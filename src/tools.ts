// MCP tool definitions and handlers over an OrdersDb.
import { z } from 'zod';
import type { OrdersDb } from './db.js';
import type { OrderItem, Refund } from './types.js';
import {
  findChargeCandidates,
  findPurchaseCandidates,
  findRefundCandidates,
  findScrapedOrderCandidates,
  mergeCandidates,
  type Candidate,
  type MatchOptions,
} from './matcher.js';
import { addDays } from './parse-values.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// Reason: pre-orders and backorders can ship weeks after they are placed, so when looking for the
// order behind a charge, consider orders placed up to this long before the charge window.
const ORDER_LOOKBACK_DAYS = 60;

const ChargeSchema = z.object({
  amount: z
    .number()
    .describe('Charge as it appears in the bank, in currency units. Negative = purchase, positive = refund/credit.'),
  date: isoDate.describe('Bank transaction date, YYYY-MM-DD'),
  window_days: z.number().int().min(0).max(60).default(10).describe('Days after shipping the charge may post'),
  tolerance: z.number().min(0).default(0.01).describe('Allowed difference in currency units'),
  account: z.string().optional().describe('Restrict to one imported Amazon account'),
});

export const TOOL_SCHEMAS = {
  find_order_candidates: {
    description:
      'Find Amazon shipments/orders/items (or refunds, for positive amounts) that match one bank charge by amount and date.',
    schema: ChargeSchema,
  },
  match_charges: {
    description:
      'Batch version of find_order_candidates. Returns up to 5 candidates per charge with a status of unique, ambiguous or none.',
    schema: z.object({
      charges: z
        .array(ChargeSchema.extend({ id: z.string().describe('Caller id, e.g. the bank transaction id') }))
        .min(1)
        .max(500),
    }),
  },
  get_order: {
    description: 'Get every item, shipment date and refund for one Amazon order id.',
    schema: z.object({ order_id: z.string() }),
  },
  search_items: {
    description: 'Search purchased item names (case-insensitive substring).',
    schema: z.object({
      query: z.string().min(1),
      start_date: isoDate.default('1990-01-01'),
      end_date: isoDate.default('2999-12-31'),
      limit: z.number().int().min(1).max(500).default(50),
    }),
  },
  list_orders: {
    description: 'List orders placed in a date range with their items and totals.',
    schema: z.object({
      start_date: isoDate,
      end_date: isoDate,
      account: z.string().optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
  },
  list_refunds: {
    description: 'List refunds in a date range.',
    schema: z.object({ start_date: isoDate, end_date: isoDate, account: z.string().optional() }),
  },
  stats: {
    description: 'Show which Amazon accounts are imported, how many orders, and the date coverage.',
    schema: z.object({}),
  },
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

const money = (minor: number | null): string | null => (minor === null ? null : (minor / 100).toFixed(2));

function presentCandidate(c: Candidate): Record<string, unknown> {
  return { ...c, total: money(c.total), items: c.items.map((i) => ({ ...i, totalOwed: money(i.totalOwed) })) };
}

function presentItem(i: OrderItem): Record<string, unknown> {
  return { ...i, totalOwed: money(i.totalOwed) };
}

function presentRefund(r: Refund): Record<string, unknown> {
  return { ...r, amount: money(r.amount) };
}

/** Order date and product names for an order, from whichever source has it. */
function orderContext(db: OrdersDb, orderId: string): { orderDate: string; products: string[] } {
  const scraped = db.scrapedOrder(orderId);
  if (scraped) return { orderDate: scraped.orderDate, products: scraped.products };
  const items = db.itemsForOrder(orderId);
  return { orderDate: items[0]?.orderDate ?? '', products: items.map((i) => i.productName) };
}

function candidatesFor(db: OrdersDb, charge: z.infer<typeof ChargeSchema>): Candidate[] {
  const amount = Math.round(charge.amount * 100);
  const opts: MatchOptions = { windowDays: charge.window_days, tolerance: Math.round(charge.tolerance * 100) };
  const from = addDays(charge.date, -charge.window_days - 2);
  const to = addDays(charge.date, 2);
  const exactCharges = db.chargesBetween(
    addDays(charge.date, -charge.window_days),
    addDays(charge.date, charge.window_days),
    charge.account
  );
  const byCharge = findChargeCandidates(exactCharges, (id) => orderContext(db, id), amount, charge.date, opts);
  if (amount > 0) {
    const refunds = db.refundsBetween(from, to, charge.account);
    return mergeCandidates(
      byCharge,
      findRefundCandidates(refunds, (id) => db.itemsForOrder(id), amount, charge.date, opts)
    );
  }
  const items = db.itemsForOrdersPlaced(addDays(from, -ORDER_LOOKBACK_DAYS), to, charge.account);
  return mergeCandidates(
    byCharge,
    findPurchaseCandidates(items, amount, charge.date, opts),
    findScrapedOrderCandidates(db.ordersBetween(from, to, charge.account), amount, charge.date, opts)
  );
}

function summarizeOrders(items: OrderItem[], limit: number): Record<string, unknown>[] {
  const orders = new Map<string, OrderItem[]>();
  for (const i of items) orders.set(i.orderId, [...(orders.get(i.orderId) ?? []), i]);
  return [...orders.values()].slice(0, limit).map((its) => ({
    account: its[0].account,
    orderId: its[0].orderId,
    orderDate: its[0].orderDate,
    status: its[0].orderStatus,
    total: money(its.every((i) => i.totalOwed !== null) ? its.reduce((s, i) => s + (i.totalOwed ?? 0), 0) : null),
    items: its.map((i) => ({ productName: i.productName, shipDate: i.shipDate, totalOwed: money(i.totalOwed) })),
  }));
}

/**
 * Run a tool against the database.
 *
 * @param db - Orders database
 * @param name - Tool name
 * @param rawArgs - Unvalidated arguments from the client
 * @returns JSON-serialisable result
 */
export function runTool(db: OrdersDb, name: string, rawArgs: unknown): unknown {
  const raw = rawArgs ?? {};
  const s = TOOL_SCHEMAS;
  switch (name as ToolName) {
    case 'find_order_candidates':
      return candidatesFor(db, s.find_order_candidates.schema.parse(raw)).map(presentCandidate);
    case 'match_charges':
      return s.match_charges.schema.parse(raw).charges.map((c) => {
        const cs = candidatesFor(db, c);
        return {
          id: c.id,
          status: cs.length === 0 ? 'none' : cs.length === 1 ? 'unique' : 'ambiguous',
          candidates: cs.slice(0, 5).map(presentCandidate),
        };
      });
    case 'get_order': {
      const { order_id } = s.get_order.schema.parse(raw);
      const scraped = db.scrapedOrder(order_id);
      return {
        order: scraped ? { ...scraped, total: money(scraped.total) } : null,
        items: db.itemsForOrder(order_id).map(presentItem),
        charges: db.chargesForOrder(order_id).map((c) => ({ ...c, amount: money(c.amount) })),
        refunds: db.refundsForOrder(order_id).map(presentRefund),
      };
    }
    case 'search_items': {
      const a = s.search_items.schema.parse(raw);
      const fromExport = db.searchItems(a.query, a.start_date, a.end_date, a.limit).map(presentItem);
      const needle = a.query.toLowerCase();
      const fromScrape = db
        .searchScrapedOrders(a.query, a.start_date, a.end_date, a.limit)
        .flatMap((o) =>
          o.products
            .filter((p) => p.toLowerCase().includes(needle))
            .map((productName) => ({ account: o.account, orderId: o.orderId, orderDate: o.orderDate, productName }))
        );
      return [...fromExport, ...fromScrape].slice(0, a.limit);
    }
    case 'list_orders': {
      const a = s.list_orders.schema.parse(raw);
      const fromExport = summarizeOrders(db.itemsForOrdersPlaced(a.start_date, a.end_date, a.account), a.limit);
      const known = new Set(fromExport.map((o) => o.orderId));
      const fromScrape = db
        .ordersBetween(a.start_date, a.end_date, a.account)
        .filter((o) => !known.has(o.orderId))
        .map((o) => ({ ...o, total: money(o.total) }));
      return [...fromExport, ...fromScrape].slice(0, a.limit);
    }
    case 'list_refunds': {
      const a = s.list_refunds.schema.parse(raw);
      return db.refundsBetween(a.start_date, a.end_date, a.account).map(presentRefund);
    }
    case 'stats':
      return db.stats();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
