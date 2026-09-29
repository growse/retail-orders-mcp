// Turns raw export CSVs into OrderItem / Refund records, recognising files by their headers.
import type { CsvFile } from './export-reader.js';
import type { OrderItem, ParsedExport, Refund } from './types.js';
import { parseDate, parseMoney, parseQuantity } from './parse-values.js';

// Reason: Amazon has renamed export columns over the years and differs slightly per region, so
// each field is looked up through a list of known aliases rather than one fixed header.
const COLS = {
  orderId: ['Order ID', 'OrderID', 'Order Id'],
  orderDate: ['Order Date', 'Order Placed Date'],
  shipDate: ['Ship Date', 'Shipment Date'],
  product: ['Product Name', 'Title', 'Item Name'],
  asin: ['ASIN', 'ASIN/ISBN'],
  quantity: ['Quantity', 'Original Quantity'],
  currency: ['Currency', 'Currency Code'],
  totalOwed: ['Total Owed', 'Item Total', 'Total Charged'],
  unitPrice: ['Unit Price', 'Purchase Price Per Unit'],
  unitTax: ['Unit Price Tax'],
  status: ['Order Status', 'Status'],
  payment: ['Payment Instrument Type', 'Payment Method Type'],
  website: ['Website', 'Marketplace'],
  refundAmount: ['Refund Amount', 'Amount Refunded', 'Total Refund Amount'],
  refundDate: ['Refund Date', 'Refund Completion Date', 'Creation Date', 'Return Date'],
  refundStatus: ['Status', 'Refund Status', 'Reversal Status'],
} as const;

type Field = keyof typeof COLS;

function resolver(headers: string[]): (row: Record<string, string>, field: Field) => string | undefined {
  const lower = new Map(headers.map((h) => [h.toLowerCase(), h]));
  const cache = new Map<Field, string | undefined>();
  return (row, field) => {
    if (!cache.has(field)) cache.set(field, COLS[field].map((a) => lower.get(a.toLowerCase())).find(Boolean));
    const key = cache.get(field);
    return key === undefined ? undefined : row[key];
  };
}

function has(headers: string[], ...fields: Field[]): boolean {
  const lower = new Set(headers.map((h) => h.toLowerCase()));
  return fields.every((f) => COLS[f].some((a) => lower.has(a.toLowerCase())));
}

/** Order-history files carry per-item lines with an order id, product and a price. */
export function isOrderHistory(headers: string[]): boolean {
  return has(headers, 'orderId', 'orderDate', 'product') && (has(headers, 'totalOwed') || has(headers, 'unitPrice'));
}

/** Refund files carry an order id, a refunded amount and a date — but no product lines. */
export function isRefunds(headers: string[]): boolean {
  return has(headers, 'orderId', 'refundAmount', 'refundDate') && !has(headers, 'product');
}

function toItem(get: ReturnType<typeof resolver>, row: Record<string, string>, account: string): OrderItem | null {
  const orderId = get(row, 'orderId')?.trim();
  const orderDate = parseDate(get(row, 'orderDate'));
  if (!orderId || !orderDate) return null;
  const quantity = parseQuantity(get(row, 'quantity'));
  let totalOwed = parseMoney(get(row, 'totalOwed'));
  if (totalOwed === null) {
    // Reason: older exports have no Total Owed; unit price (+ tax) × quantity is the closest proxy.
    const unit = parseMoney(get(row, 'unitPrice'));
    const tax = parseMoney(get(row, 'unitTax')) ?? 0;
    totalOwed = unit === null ? null : (unit + tax) * quantity;
  }
  return {
    account,
    website: get(row, 'website')?.trim() ?? '',
    orderId,
    orderDate,
    shipDate: parseDate(get(row, 'shipDate')),
    productName: get(row, 'product')?.trim() ?? '',
    asin: get(row, 'asin')?.trim() ?? '',
    quantity,
    currency: get(row, 'currency')?.trim() || 'GBP',
    totalOwed,
    orderStatus: get(row, 'status')?.trim() ?? '',
    paymentInstrument: get(row, 'payment')?.trim() ?? '',
  };
}

function toRefund(get: ReturnType<typeof resolver>, row: Record<string, string>, account: string): Refund | null {
  const orderId = get(row, 'orderId')?.trim();
  const refundDate = parseDate(get(row, 'refundDate'));
  const amount = parseMoney(get(row, 'refundAmount'));
  if (!orderId || !refundDate || amount === null || amount === 0) return null;
  return {
    account,
    orderId,
    refundDate,
    currency: get(row, 'currency')?.trim() || 'GBP',
    amount: Math.abs(amount),
    status: get(row, 'refundStatus')?.trim() ?? '',
  };
}

/**
 * Normalise every recognised CSV in an export.
 *
 * @param files - CSVs read from the export
 * @param account - Label for whose Amazon account this export is (e.g. "andrew")
 * @returns Items, refunds, and any unrecognised files
 */
export function normalizeExport(files: CsvFile[], account: string): ParsedExport {
  const result: ParsedExport = { items: [], refunds: [], skipped: [] };
  for (const file of files) {
    const get = resolver(file.headers);
    if (isOrderHistory(file.headers)) {
      for (const row of file.rows) {
        const item = toItem(get, row, account);
        if (item) result.items.push(item);
      }
    } else if (isRefunds(file.headers)) {
      for (const row of file.rows) {
        const refund = toRefund(get, row, account);
        if (refund) result.refunds.push(refund);
      }
    } else {
      result.skipped.push({ file: file.name, headers: file.headers });
    }
  }
  return result;
}
