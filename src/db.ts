// SQLite storage (Node's built-in node:sqlite, so there is no native module to build).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OrderItem, Refund } from './types.js';
import type { ScrapedCharge, ScrapedOrder } from './scrape-parse.js';

export type StoredOrder = ScrapedOrder & { account: string };
export type StoredCharge = ScrapedCharge & { account: string };

interface OrderRow {
  account: string;
  order_id: string;
  order_date: string;
  total: number | null;
  currency: string;
  products: string;
}

interface ChargeRow {
  account: string;
  date: string;
  merchant: string;
  card: string;
  last4: string;
  order_id: string;
  amount: number;
  currency: string;
  status: string;
}

function toOrder(r: OrderRow): StoredOrder {
  return {
    account: r.account,
    orderId: r.order_id,
    orderDate: r.order_date,
    total: r.total,
    currency: r.currency,
    products: JSON.parse(r.products) as string[],
  };
}

function toCharge(r: ChargeRow): StoredCharge {
  return {
    account: r.account,
    date: r.date,
    merchant: r.merchant,
    card: r.card,
    last4: r.last4,
    orderId: r.order_id,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
  };
}

export const DEFAULT_DB_PATH = path.join(os.homedir(), '.local', 'share', 'amazon-orders-mcp', 'orders.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  website TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_date TEXT NOT NULL,
  ship_date TEXT,
  product_name TEXT NOT NULL,
  asin TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  currency TEXT NOT NULL,
  total_owed INTEGER,
  order_status TEXT NOT NULL,
  payment_instrument TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_order ON items(order_id);
CREATE INDEX IF NOT EXISTS items_dates ON items(ship_date, order_date);
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY,
  account TEXT NOT NULL,
  order_id TEXT NOT NULL,
  refund_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS refunds_date ON refunds(refund_date);
CREATE TABLE IF NOT EXISTS imports (
  account TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  items INTEGER NOT NULL,
  refunds INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  account TEXT NOT NULL,
  order_id TEXT NOT NULL,
  order_date TEXT NOT NULL,
  total INTEGER,
  currency TEXT NOT NULL,
  products TEXT NOT NULL,
  scraped_at TEXT NOT NULL,
  PRIMARY KEY (account, order_id)
);
CREATE INDEX IF NOT EXISTS orders_date ON orders(order_date);
CREATE TABLE IF NOT EXISTS charges (
  account TEXT NOT NULL,
  date TEXT NOT NULL,
  merchant TEXT NOT NULL,
  card TEXT NOT NULL,
  last4 TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (account, order_id, date, amount)
);
CREATE INDEX IF NOT EXISTS charges_date ON charges(date);
`;

interface ItemRow {
  account: string;
  website: string;
  order_id: string;
  order_date: string;
  ship_date: string | null;
  product_name: string;
  asin: string;
  quantity: number;
  currency: string;
  total_owed: number | null;
  order_status: string;
  payment_instrument: string;
}

interface RefundRow {
  account: string;
  order_id: string;
  refund_date: string;
  currency: string;
  amount: number;
  status: string;
}

function toItem(r: ItemRow): OrderItem {
  return {
    account: r.account,
    website: r.website,
    orderId: r.order_id,
    orderDate: r.order_date,
    shipDate: r.ship_date,
    productName: r.product_name,
    asin: r.asin,
    quantity: r.quantity,
    currency: r.currency,
    totalOwed: r.total_owed,
    orderStatus: r.order_status,
    paymentInstrument: r.payment_instrument,
  };
}

function toRefund(r: RefundRow): Refund {
  return {
    account: r.account,
    orderId: r.order_id,
    refundDate: r.refund_date,
    currency: r.currency,
    amount: r.amount,
    status: r.status,
  };
}

export class OrdersDb {
  private db: DatabaseSync;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  /**
   * Replace everything stored for an account with a fresh export.
   *
   * Reason: each Amazon export is a full snapshot of the account's history, so replacing (rather
   * than merging) keeps re-imports idempotent and drops orders Amazon no longer reports.
   */
  replaceAccount(account: string, source: string, items: OrderItem[], refunds: Refund[]): void {
    const insItem = this.db.prepare(
      `INSERT INTO items (account, website, order_id, order_date, ship_date, product_name, asin, quantity, currency,
        total_owed, order_status, payment_instrument) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    const insRefund = this.db.prepare(
      'INSERT INTO refunds (account, order_id, refund_date, currency, amount, status) VALUES (?,?,?,?,?,?)'
    );
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM items WHERE account = ?').run(account);
      this.db.prepare('DELETE FROM refunds WHERE account = ?').run(account);
      for (const i of items) {
        insItem.run(
          account,
          i.website,
          i.orderId,
          i.orderDate,
          i.shipDate,
          i.productName,
          i.asin,
          i.quantity,
          i.currency,
          i.totalOwed,
          i.orderStatus,
          i.paymentInstrument
        );
      }
      for (const r of refunds) insRefund.run(account, r.orderId, r.refundDate, r.currency, r.amount, r.status);
      this.db
        .prepare('INSERT OR REPLACE INTO imports (account, source, imported_at, items, refunds) VALUES (?,?,?,?,?)')
        .run(account, source, new Date().toISOString(), items.length, refunds.length);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Items whose ship (or, if unshipped, order) date falls in [start, end]. */
  itemsBetween(start: string, end: string, account?: string): OrderItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE COALESCE(ship_date, order_date) BETWEEN ? AND ?
         AND (? IS NULL OR account = ?) ORDER BY COALESCE(ship_date, order_date), order_id`
      )
      .all(start, end, account ?? null, account ?? null) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  /** Orders placed in [start, end], all their items. */
  itemsForOrdersPlaced(start: string, end: string, account?: string): OrderItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE order_date BETWEEN ? AND ? AND (? IS NULL OR account = ?)
         ORDER BY order_date, order_id`
      )
      .all(start, end, account ?? null, account ?? null) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  itemsForOrder(orderId: string): OrderItem[] {
    const rows = this.db
      .prepare('SELECT * FROM items WHERE order_id = ? ORDER BY ship_date')
      .all(orderId) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  refundsBetween(start: string, end: string, account?: string): Refund[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM refunds WHERE refund_date BETWEEN ? AND ? AND (? IS NULL OR account = ?)
         ORDER BY refund_date`
      )
      .all(start, end, account ?? null, account ?? null) as unknown as RefundRow[];
    return rows.map(toRefund);
  }

  refundsForOrder(orderId: string): Refund[] {
    const rows = this.db
      .prepare('SELECT * FROM refunds WHERE order_id = ? ORDER BY refund_date')
      .all(orderId) as unknown as RefundRow[];
    return rows.map(toRefund);
  }

  searchItems(query: string, start: string, end: string, limit: number): OrderItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM items WHERE product_name LIKE ? ESCAPE '\\' AND order_date BETWEEN ? AND ?
         ORDER BY order_date DESC LIMIT ?`
      )
      .all(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, start, end, limit) as unknown as ItemRow[];
    return rows.map(toItem);
  }

  /**
   * Insert or update scraped orders.
   *
   * Reason: scraping runs year by year and can be repeated or interrupted, so orders are upserted
   * by (account, order_id) rather than replacing the whole account like an export import does.
   */
  upsertOrders(account: string, orders: ScrapedOrder[]): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO orders (account, order_id, order_date, total, currency, products, scraped_at)
       VALUES (?,?,?,?,?,?,?)`
    );
    const now = new Date().toISOString();
    this.inTransaction(() => {
      for (const o of orders) {
        ins.run(account, o.orderId, o.orderDate, o.total, o.currency, JSON.stringify(o.products), now);
      }
    });
  }

  /** Insert or update card charges scraped from the Transactions page. */
  upsertCharges(account: string, charges: ScrapedCharge[]): void {
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO charges (account, date, merchant, card, last4, order_id, amount, currency, status)
       VALUES (?,?,?,?,?,?,?,?,?)`
    );
    this.inTransaction(() => {
      for (const c of charges) {
        ins.run(account, c.date, c.merchant, c.card, c.last4, c.orderId, c.amount, c.currency, c.status);
      }
    });
  }

  ordersBetween(start: string, end: string, account?: string): StoredOrder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders WHERE order_date BETWEEN ? AND ? AND (? IS NULL OR account = ?)
         ORDER BY order_date, order_id`
      )
      .all(start, end, account ?? null, account ?? null) as unknown as OrderRow[];
    return rows.map(toOrder);
  }

  scrapedOrder(orderId: string): StoredOrder | undefined {
    const row = this.db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as unknown as
      OrderRow | undefined;
    return row ? toOrder(row) : undefined;
  }

  searchScrapedOrders(query: string, start: string, end: string, limit: number): StoredOrder[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders WHERE products LIKE ? ESCAPE '\\' AND order_date BETWEEN ? AND ?
         ORDER BY order_date DESC LIMIT ?`
      )
      .all(`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, start, end, limit) as unknown as OrderRow[];
    return rows.map(toOrder);
  }

  chargesBetween(start: string, end: string, account?: string): StoredCharge[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM charges WHERE date BETWEEN ? AND ? AND (? IS NULL OR account = ?) ORDER BY date, order_id`
      )
      .all(start, end, account ?? null, account ?? null) as unknown as ChargeRow[];
    return rows.map(toCharge);
  }

  chargesForOrder(orderId: string): StoredCharge[] {
    const rows = this.db
      .prepare('SELECT * FROM charges WHERE order_id = ? ORDER BY date')
      .all(orderId) as unknown as ChargeRow[];
    return rows.map(toCharge);
  }

  stats(): Record<string, unknown> {
    return {
      exports: this.db
        .prepare(
          `SELECT i.account, i.source, i.imported_at, i.items, i.refunds,
            (SELECT MIN(order_date) FROM items WHERE account = i.account) AS first_order,
            (SELECT MAX(order_date) FROM items WHERE account = i.account) AS last_order,
            (SELECT COUNT(DISTINCT order_id) FROM items WHERE account = i.account) AS orders
           FROM imports i ORDER BY i.account`
        )
        .all(),
      scraped: this.db
        .prepare(
          `SELECT account, COUNT(*) AS orders, MIN(order_date) AS first_order, MAX(order_date) AS last_order,
            MAX(scraped_at) AS last_scraped,
            (SELECT COUNT(*) FROM charges c WHERE c.account = o.account) AS charges
           FROM orders o GROUP BY account ORDER BY account`
        )
        .all(),
    };
  }

  private inTransaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}
