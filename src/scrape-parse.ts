// Pure parsers for data scraped from amazon.co.uk pages (kept separate from the browser code so
// they can be unit-tested against captured page text).
import { parseMoney } from './parse-values.js';

/** What the browser pulls out of one `.js-order-card` on the Your Orders list. */
export interface RawOrderCard {
  /** Header label → value, e.g. { "Order placed": "27 December 2021", "Total": "£5.59" } */
  headers: Record<string, string>;
  /** Full innerText of the card, used as a fallback for the order id */
  text: string;
  products: string[];
}

export interface ScrapedOrder {
  orderId: string;
  /** YYYY-MM-DD */
  orderDate: string;
  /** Amount charged for the order (after gift cards/points), minor units; null if not shown */
  total: number | null;
  currency: string;
  products: string[];
}

export interface ScrapedCharge {
  /** YYYY-MM-DD */
  date: string;
  merchant: string;
  card: string;
  last4: string;
  orderId: string;
  /** Signed as Amazon shows it: negative = charge, positive = refund. Minor units. */
  amount: number;
  currency: string;
  status: string;
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

export const ORDER_ID_RE = /\b(?:\d{3}|D\d{2})-\d{7}-\d{7}\b/;

/**
 * Parse UK-style long or short dates ("27 December 2021", "08 Jul 2026") to YYYY-MM-DD.
 *
 * @param raw - Date text from an Amazon page
 * @returns ISO date, or null if unrecognised
 */
export function parseUkDate(raw: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  return month ? `${m[3]}-${month}-${m[1].padStart(2, '0')}` : null;
}

function currencyOf(raw: string): string {
  if (raw.includes('$')) return 'USD';
  if (raw.includes('€')) return 'EUR';
  return 'GBP';
}

function header(card: RawOrderCard, ...labels: string[]): string | undefined {
  const entries = Object.entries(card.headers);
  for (const label of labels) {
    const hit = entries.find(([k]) => k.trim().toLowerCase() === label.toLowerCase());
    if (hit) return hit[1].trim();
  }
  return undefined;
}

/**
 * Turn raw order cards into orders. Cards without a recognisable id or date are dropped.
 *
 * @param cards - Cards extracted from a Your Orders page
 * @returns Parsed orders
 */
export function parseOrderCards(cards: RawOrderCard[]): ScrapedOrder[] {
  const out: ScrapedOrder[] = [];
  for (const card of cards) {
    const idText = header(card, 'Order #', 'Order number', 'Order No.') ?? '';
    const orderId = (ORDER_ID_RE.exec(idText) ?? ORDER_ID_RE.exec(card.text))?.[0];
    const orderDate = parseUkDate(header(card, 'Order placed', 'Ordered on') ?? '');
    if (!orderId || !orderDate) continue;
    const totalText = header(card, 'Total', 'Order total') ?? '';
    out.push({
      orderId,
      orderDate,
      total: parseMoney(totalText),
      currency: currencyOf(totalText),
      products: card.products.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean),
    });
  }
  return out;
}

const TX_HEAD_RE = /^(\d{1,2} [A-Za-z]{3} \d{4})\s*·\s*(.*)$/;
const TX_CARD_RE = /^(.*?)\s*•+\s*(\d{4})$/;
const TX_ORDER_RE = /Order #\s*([\w-]+)/;
const TX_AMOUNT_RE = /^[-+]?\s*[£$€][\d,]+\.\d{2}$/;

/**
 * Parse the innerText of the Your Payments → Transactions page.
 *
 * Each entry renders as consecutive lines:
 *   `08 Jul 2026·AMZNMktplace` / `AmericanExpress••••9999` / `Order #206-…` / `-£55.98` / `Charged`
 *
 * @param text - document.body.innerText
 * @returns Charges in page order
 */
export function parseTransactionsText(text: string): ScrapedCharge[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const out: ScrapedCharge[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = TX_HEAD_RE.exec(lines[i]);
    const date = head ? parseUkDate(head[1]) : null;
    if (!head || !date) continue;
    // Reason: read forward only until the next entry header, so one malformed entry can't
    // swallow fields belonging to its neighbour.
    let j = i + 1;
    const block: string[] = [];
    while (j < lines.length && !TX_HEAD_RE.test(lines[j]) && block.length < 6) block.push(lines[j++]);
    const card = block.map((l) => TX_CARD_RE.exec(l)).find(Boolean);
    const order = block.map((l) => TX_ORDER_RE.exec(l)).find(Boolean);
    const amountIdx = block.findIndex((l) => TX_AMOUNT_RE.test(l));
    const amount = amountIdx >= 0 ? parseMoney(block[amountIdx].replace(/\s+/g, '')) : null;
    if (!order || amount === null) continue;
    out.push({
      date,
      merchant: head[2].trim(),
      card: card?.[1].trim() ?? '',
      last4: card?.[2] ?? '',
      orderId: order[1],
      amount,
      currency: currencyOf(block[amountIdx]),
      status: block[amountIdx + 1] ?? '',
    });
  }
  return out;
}
