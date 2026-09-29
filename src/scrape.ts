// Scrapes the signed-in amazon.co.uk session into the database: card charges and order history.
import type { Page } from 'playwright-core';
import type { OrdersDb } from './db.js';
import { AMAZON_BASE, ORDERS_URL, gotoAuthed, openBrowser } from './browser.js';
import { parseOrderCards, parseTransactionsText, type RawOrderCard } from './scrape-parse.js';

export interface ScrapeOptions {
  account: string;
  fromYear: number;
  toYear: number;
  /** Base pause between page loads; jittered so requests don't arrive on a fixed beat */
  delayMs?: number;
  log?: (msg: string) => void;
}

export interface ScrapeResult {
  orders: number;
  charges: number;
}

// Reason: Amazon serves headless Chrome a 503 and throttles rapid-fire page loads, so scraping
// runs in a visible window and paces itself like a person paging through their orders.
const DEFAULT_DELAY_MS = 2500;
const MAX_PAGES_PER_YEAR = 100;

const pause = (page: Page, base: number): Promise<void> => page.waitForTimeout(base + Math.random() * base);

/** Runs in the browser: pull header label/value pairs, text and product titles from each card. */
function extractCards(cards: Element[]): RawOrderCard[] {
  return cards.map((card) => {
    const headers: Record<string, string> = {};
    for (const li of Array.from(card.querySelectorAll('.order-header__header-list-item'))) {
      const label = li.querySelector('.a-text-caps')?.textContent?.trim();
      if (!label) continue;
      const value = Array.from(li.querySelectorAll('span'))
        .filter((s) => !s.classList.contains('a-text-caps'))
        .map((s) => (s.textContent ?? '').trim())
        .find((t) => t.length > 0);
      headers[label] = value ?? '';
    }
    const products = Array.from(card.querySelectorAll('.yohtmlc-product-title')).map((e) =>
      (e.textContent ?? '').trim()
    );
    return { headers, text: (card as HTMLElement).innerText ?? '', products };
  });
}

async function scrapeCharges(page: Page, opts: ScrapeOptions, db: OrdersDb): Promise<number> {
  await gotoAuthed(page, `${AMAZON_BASE}/cpe/yourpayments/transactions`);
  // Reason: the transactions list renders client-side after load; wait for an order reference.
  await page
    .getByText(/Order #/)
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined);
  const charges = parseTransactionsText(await page.evaluate(() => document.body.innerText));
  db.upsertCharges(opts.account, charges);
  opts.log?.(`card charges: ${charges.length} (Amazon only lists the most recent ones)`);
  return charges.length;
}

async function scrapeYear(page: Page, year: number, opts: ScrapeOptions, db: OrdersDb): Promise<number> {
  let total = 0;
  for (let n = 0; n < MAX_PAGES_PER_YEAR; n++) {
    await gotoAuthed(page, `${ORDERS_URL}?timeFilter=year-${year}&page=${n}`);
    await page
      .locator('.js-order-card')
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => undefined);
    const cards = await page.$$eval('.js-order-card', extractCards);
    const orders = parseOrderCards(cards);
    // Reason: save per page, so an interrupted run (expired session, closed window) keeps its progress.
    db.upsertOrders(opts.account, orders);
    total += orders.length;
    if (cards.length !== orders.length) {
      opts.log?.(`  ${year} page ${n + 1}: ${cards.length - orders.length} card(s) could not be parsed`);
    }
    const hasNext = await page.locator('ul.a-pagination li.a-last:not(.a-disabled) a').count();
    if (cards.length === 0 || hasNext === 0) break;
    await pause(page, opts.delayMs ?? DEFAULT_DELAY_MS);
  }
  opts.log?.(`${year}: ${total} orders`);
  return total;
}

/**
 * Scrape card charges and order history for the signed-in Amazon account.
 *
 * @param db - Database to write into (upserts; safe to re-run)
 * @param opts - Account label, year range and pacing
 * @returns Counts of orders and charges saved
 */
export async function scrapeAmazon(db: OrdersDb, opts: ScrapeOptions): Promise<ScrapeResult> {
  const context = await openBrowser('amazon', opts.account, false);
  const page = context.pages()[0] ?? (await context.newPage());
  try {
    const charges = await scrapeCharges(page, opts, db);
    let orders = 0;
    for (let year = opts.toYear; year >= opts.fromYear; year--) {
      await pause(page, opts.delayMs ?? DEFAULT_DELAY_MS);
      orders += await scrapeYear(page, year, opts, db);
    }
    return { orders, charges };
  } finally {
    await context.close();
  }
}
