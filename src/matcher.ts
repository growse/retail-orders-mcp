// Pure matching logic: which Amazon shipments/orders/refunds explain a given card charge.
import type { OrderItem, Refund } from './types.js';
import type { StoredCharge, StoredOrder } from './db.js';
import { daysBetween } from './parse-values.js';

export type CandidateKind = 'charge' | 'shipment' | 'order' | 'item' | 'refund';

export interface CandidateItem {
  productName: string;
  asin: string;
  quantity: number;
  totalOwed: number | null;
}

export interface Candidate {
  kind: CandidateKind;
  account: string;
  orderId: string;
  orderDate: string;
  /** Ship date for purchases, refund date for refunds */
  date: string;
  /** Minor units, always positive */
  total: number;
  /** Charge date minus candidate date, in days (positive = card posted after shipping) */
  dayOffset: number;
  items: CandidateItem[];
}

export interface MatchOptions {
  /** Days after the ship/refund date that the card charge may post */
  windowDays: number;
  /** Allowed absolute difference, minor units */
  tolerance: number;
}

// Reason: a card can occasionally show the charge a day or two *before* Amazon's ship date
// (timezone of the UTC timestamp, or the charge posting at dispatch), so allow a small lead.
const EARLY_DAYS = 2;
const KIND_RANK: Record<CandidateKind, number> = { charge: -1, shipment: 0, order: 1, refund: 1, item: 2 };

function toCandidateItem(i: OrderItem): CandidateItem {
  return { productName: i.productName, asin: i.asin, quantity: i.quantity, totalOwed: i.totalOwed };
}

function sumOwed(items: OrderItem[]): number | null {
  let total = 0;
  for (const i of items) {
    if (i.totalOwed === null) return null;
    total += i.totalOwed;
  }
  return total;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

function sortCandidates(cs: Candidate[]): Candidate[] {
  return cs.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      Math.abs(a.dayOffset) - Math.abs(b.dayOffset) ||
      a.orderId.localeCompare(b.orderId)
  );
}

/**
 * Find shipments, whole orders, or single items whose total matches a purchase charge.
 *
 * Amazon UK normally charges per shipment when it dispatches, so a shipment (items in one order
 * sharing a ship date) is the primary unit. Whole-order and single-item totals are offered as
 * fallbacks for orders charged up front or items charged separately.
 *
 * @param items - Candidate order items (all items of every order that could be relevant)
 * @param amount - Charge amount in minor units (sign ignored)
 * @param chargeDate - Card transaction date, YYYY-MM-DD
 * @param opts - Window and tolerance
 * @returns Candidates, best first
 */
export function findPurchaseCandidates(
  items: OrderItem[],
  amount: number,
  chargeDate: string,
  opts: MatchOptions
): Candidate[] {
  const target = Math.abs(amount);
  const out: Candidate[] = [];
  const inWindow = (date: string): number | null => {
    const offset = daysBetween(date, chargeDate);
    return offset >= -EARLY_DAYS && offset <= opts.windowDays ? offset : null;
  };
  const push = (kind: CandidateKind, group: OrderItem[], date: string, total: number | null): void => {
    if (total === null || Math.abs(total - target) > opts.tolerance) return;
    const offset = inWindow(date);
    if (offset === null) return;
    const first = group[0];
    out.push({
      kind,
      account: first.account,
      orderId: first.orderId,
      orderDate: first.orderDate,
      date,
      total,
      dayOffset: offset,
      items: group.map(toCandidateItem),
    });
  };

  const live = items.filter((i) => !/cancel/i.test(i.orderStatus));
  for (const orderItems of groupBy(live, (i) => `${i.account}\u0000${i.orderId}`).values()) {
    const shipments = groupBy(orderItems, (i) => i.shipDate ?? i.orderDate);
    for (const [shipDate, shipItems] of shipments) {
      push('shipment', shipItems, shipDate, sumOwed(shipItems));
      if (shipItems.length > 1) for (const item of shipItems) push('item', [item], shipDate, item.totalOwed);
    }
    if (shipments.size > 1) {
      const firstShip = [...shipments.keys()].sort()[0];
      push('order', orderItems, firstShip, sumOwed(orderItems));
    }
  }
  return sortCandidates(out);
}

/**
 * Find refunds matching a credit on the card.
 *
 * @param refunds - Refunds near the credit date
 * @param orderItems - Lookup of order id to its items, for context
 * @param amount - Credit amount in minor units (sign ignored)
 * @param creditDate - Card transaction date, YYYY-MM-DD
 * @param opts - Window and tolerance
 * @returns Candidates, best first
 */
export function findRefundCandidates(
  refunds: Refund[],
  orderItems: (orderId: string) => OrderItem[],
  amount: number,
  creditDate: string,
  opts: MatchOptions
): Candidate[] {
  const target = Math.abs(amount);
  const out: Candidate[] = [];
  for (const r of refunds) {
    if (Math.abs(r.amount - target) > opts.tolerance) continue;
    const offset = daysBetween(r.refundDate, creditDate);
    if (offset < -EARLY_DAYS || offset > opts.windowDays) continue;
    const items = orderItems(r.orderId);
    out.push({
      kind: 'refund',
      account: r.account,
      orderId: r.orderId,
      orderDate: items[0]?.orderDate ?? '',
      date: r.refundDate,
      total: r.amount,
      dayOffset: offset,
      items: items.map(toCandidateItem),
    });
  }
  return sortCandidates(out);
}

const productItems = (products: string[]): CandidateItem[] =>
  products.map((productName) => ({ productName, asin: '', quantity: 1, totalOwed: null }));

/**
 * Match a bank transaction against Amazon's own record of card charges (Your Payments →
 * Transactions). The amount must agree exactly (within tolerance, same sign) and the dates within
 * the window either side.
 *
 * Reason: card issuers and Amazon disagree on the date by several days in both directions (Amex
 * often posts before Amazon's charge date), so unlike shipments the window here is symmetric —
 * the exact amount and order id carry the confidence.
 *
 * @param charges - Amazon card charges near the bank date
 * @param products - Lookup of order id to product names, for context
 * @param amount - Bank amount in minor units, signed (negative = purchase)
 * @param bankDate - Bank transaction date, YYYY-MM-DD
 * @param opts - Window and tolerance
 * @returns Candidates, best first
 */
export function findChargeCandidates(
  charges: StoredCharge[],
  products: (orderId: string) => { orderDate: string; products: string[] },
  amount: number,
  bankDate: string,
  opts: MatchOptions
): Candidate[] {
  const out: Candidate[] = [];
  for (const c of charges) {
    if (Math.abs(c.amount - amount) > opts.tolerance) continue;
    const offset = daysBetween(c.date, bankDate);
    if (Math.abs(offset) > opts.windowDays) continue;
    const order = products(c.orderId);
    out.push({
      kind: 'charge',
      account: c.account,
      orderId: c.orderId,
      orderDate: order.orderDate,
      date: c.date,
      total: Math.abs(c.amount),
      dayOffset: offset,
      items: productItems(order.products),
    });
  }
  return sortCandidates(out);
}

/**
 * Match a purchase against scraped order totals (what the Your Orders list says was charged,
 * net of gift cards). Weaker than a charge match: an order shipped in parts is charged in parts,
 * and the list page carries no dispatch date, so the window is measured from the order date.
 *
 * @param orders - Scraped orders placed near the bank date
 * @param amount - Bank amount in minor units (sign ignored)
 * @param bankDate - Bank transaction date, YYYY-MM-DD
 * @param opts - Window and tolerance
 * @returns Candidates, best first
 */
export function findScrapedOrderCandidates(
  orders: StoredOrder[],
  amount: number,
  bankDate: string,
  opts: MatchOptions
): Candidate[] {
  const target = Math.abs(amount);
  const out: Candidate[] = [];
  for (const o of orders) {
    if (o.total === null || Math.abs(o.total - target) > opts.tolerance) continue;
    const offset = daysBetween(o.orderDate, bankDate);
    if (offset < -EARLY_DAYS || offset > opts.windowDays) continue;
    out.push({
      kind: 'order',
      account: o.account,
      orderId: o.orderId,
      orderDate: o.orderDate,
      date: o.orderDate,
      total: o.total,
      dayOffset: offset,
      items: productItems(o.products),
    });
  }
  return sortCandidates(out);
}

/**
 * Merge candidate lists, keeping the best-ranked candidate per (account, order, kind-class) so the
 * same order found via a charge and via its order total isn't reported twice.
 *
 * @param lists - Candidate lists from the different sources
 * @returns Deduplicated, ranked candidates
 */
export function mergeCandidates(...lists: Candidate[][]): Candidate[] {
  const ranked = sortCandidates(lists.flat());
  const seen = new Set<string>();
  return ranked.filter((c) => {
    // Reason: split shipments of one order are legitimately distinct candidates with different
    // totals, so dedupe on order *and* amount — only re-discoveries of the same charge collapse.
    const key = `${c.account}|${c.orderId}|${c.total}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
