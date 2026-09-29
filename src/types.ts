// Shared domain types. Money is always integer minor units (pence/cents) to avoid float drift.

export interface OrderItem {
  account: string;
  website: string;
  orderId: string;
  /** YYYY-MM-DD */
  orderDate: string;
  /** YYYY-MM-DD, or null when Amazon reports "Not Available" (e.g. cancelled / digital) */
  shipDate: string | null;
  productName: string;
  asin: string;
  quantity: number;
  currency: string;
  /** What was charged for this line: item + tax + shipping - discounts. Null if unknown. */
  totalOwed: number | null;
  orderStatus: string;
  paymentInstrument: string;
}

export interface Refund {
  account: string;
  orderId: string;
  /** YYYY-MM-DD */
  refundDate: string;
  currency: string;
  /** Positive amount refunded, minor units */
  amount: number;
  status: string;
}

export interface ParsedExport {
  items: OrderItem[];
  refunds: Refund[];
  /** CSVs that were found but not recognised, with their headers, so new export formats can be supported */
  skipped: { file: string; headers: string[] }[];
}
