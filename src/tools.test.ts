import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { OrdersDb } from './db.js';
import { readExport } from './export-reader.js';
import { normalizeExport } from './normalize.js';
import { runTool } from './tools.js';

const FIXTURES = path.join(import.meta.dirname, 'test-fixtures');

describe('tools over an imported export', () => {
  let db: OrdersDb;

  beforeAll(() => {
    db = new OrdersDb(':memory:');
    const parsed = normalizeExport(readExport(FIXTURES), 'andrew');
    db.replaceAccount('andrew', FIXTURES, parsed.items, parsed.refunds);
  });

  afterAll(() => db.close());

  it('find_order_candidates matches a purchase shipment', () => {
    const result = runTool(db, 'find_order_candidates', { amount: -55.98, date: '2026-07-08' }) as {
      kind: string;
      orderId: string;
      total: string;
    }[];
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'shipment', orderId: '202-1111111-1111111', total: '55.98' });
  });

  it('find_order_candidates treats positive amounts as refunds', () => {
    const result = runTool(db, 'find_order_candidates', { amount: 28, date: '2026-07-21' }) as { kind: string }[];
    expect(result.map((r) => r.kind)).toEqual(['refund']);
  });

  it('match_charges reports unique, ambiguous and none', () => {
    const result = runTool(db, 'match_charges', {
      charges: [
        { id: 't1', amount: -9.99, date: '2026-05-20' },
        { id: 't2', amount: -1.23, date: '2026-05-20' },
        { id: 't3', amount: -27.98, date: '2026-07-08' },
      ],
    }) as { id: string; status: string }[];
    // t3: the 27.98 hub line alone is an item-level fallback; the cancelled 27.98 order is ignored.
    expect(result.map((r) => [r.id, r.status])).toEqual([
      ['t1', 'unique'],
      ['t2', 'none'],
      ['t3', 'unique'],
    ]);
  });

  it('get_order, search_items, list_orders, list_refunds and stats return data', () => {
    const order = runTool(db, 'get_order', { order_id: '202-1111111-1111111' }) as {
      items: unknown[];
      refunds: unknown[];
    };
    expect(order.items).toHaveLength(2);
    expect(order.refunds).toHaveLength(1);
    expect(runTool(db, 'search_items', { query: 'lego' })).toHaveLength(2);
    expect(runTool(db, 'search_items', { query: '100%' })).toHaveLength(0);
    const orders = runTool(db, 'list_orders', { start_date: '2026-05-01', end_date: '2026-05-31' }) as {
      total: string;
    }[];
    expect(orders).toEqual([expect.objectContaining({ total: '127.98' })]);
    expect(runTool(db, 'list_refunds', { start_date: '2026-07-01', end_date: '2026-07-31' })).toHaveLength(1);
    expect(runTool(db, 'stats', {})).toEqual({
      exports: [expect.objectContaining({ account: 'andrew', orders: 4 })],
      scraped: [],
    });
  });

  it('rejects unknown tools and invalid arguments', () => {
    expect(() => runTool(db, 'nope', {})).toThrow('Unknown tool');
    expect(() => runTool(db, 'find_order_candidates', { amount: -1, date: '8 July' })).toThrow();
  });

  it('re-importing an account replaces its data rather than duplicating it', () => {
    const parsed = normalizeExport(readExport(FIXTURES), 'andrew');
    db.replaceAccount('andrew', FIXTURES, parsed.items, parsed.refunds);
    expect(runTool(db, 'search_items', { query: 'lego' })).toHaveLength(2);
  });
});

describe('tools over scraped orders and charges', () => {
  let db: OrdersDb;

  beforeAll(() => {
    db = new OrdersDb(':memory:');
    db.upsertOrders('andrew', [
      { orderId: '206-0000000-0000001', orderDate: '2026-07-06', total: 5598, currency: 'GBP', products: ['USB hub'] },
      { orderId: '202-0000000-0000002', orderDate: '2021-12-26', total: 7999, currency: 'GBP', products: ['UniFi AP'] },
    ]);
    db.upsertCharges('andrew', [
      {
        date: '2026-07-08',
        merchant: 'AMZNMktplace',
        card: 'AmericanExpress',
        last4: '9999',
        orderId: '206-0000000-0000001',
        amount: -5598,
        currency: 'GBP',
        status: 'Charged',
      },
    ]);
  });

  afterAll(() => db.close());

  it('prefers an exact card charge and does not repeat the same order via its total', () => {
    const result = runTool(db, 'find_order_candidates', { amount: -55.98, date: '2026-07-08' }) as {
      kind: string;
      orderId: string;
      items: { productName: string }[];
    }[];
    expect(result.map((r) => r.kind)).toEqual(['charge']);
    expect(result[0].items[0].productName).toBe('USB hub');
  });

  it('matches older orders by their charged total when no card charge is recorded', () => {
    const result = runTool(db, 'find_order_candidates', { amount: -79.99, date: '2021-12-28' }) as {
      kind: string;
    }[];
    expect(result.map((r) => r.kind)).toEqual(['order']);
  });

  it('upserts rather than duplicates on re-scrape, and exposes scraped data in lookups', () => {
    db.upsertOrders('andrew', [
      { orderId: '202-0000000-0000002', orderDate: '2021-12-26', total: 7999, currency: 'GBP', products: ['UniFi AP'] },
    ]);
    expect(runTool(db, 'stats', {})).toMatchObject({ scraped: [{ account: 'andrew', orders: 2, charges: 1 }] });
    expect(runTool(db, 'get_order', { order_id: '206-0000000-0000001' })).toMatchObject({
      order: { total: '55.98' },
      charges: [{ amount: '-55.98', last4: '9999' }],
    });
    expect(runTool(db, 'search_items', { query: 'unifi' })).toEqual([
      expect.objectContaining({ orderId: '202-0000000-0000002', productName: 'UniFi AP' }),
    ]);
    expect(runTool(db, 'list_orders', { start_date: '2021-01-01', end_date: '2021-12-31' })).toEqual([
      expect.objectContaining({ orderId: '202-0000000-0000002', total: '79.99' }),
    ]);
  });
});

describe('readExport', () => {
  it('reads CSVs from a zip nested inside a zip', () => {
    const csv = fs.readFileSync(path.join(FIXTURES, 'Retail.OrderHistory.1.csv'), 'utf-8');
    const inner = zipSync({ 'Retail.OrderHistory.1/Retail.OrderHistory.1.csv': strToU8(csv) });
    const outer = zipSync({ 'Your Orders.zip': inner, 'README.txt': strToU8('hi') });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aom-'));
    const zipPath = path.join(dir, 'export.zip');
    fs.writeFileSync(zipPath, outer);

    const files = readExport(zipPath);
    expect(files.map((f) => f.name)).toEqual([
      'export.zip!Your Orders.zip!Retail.OrderHistory.1/Retail.OrderHistory.1.csv',
    ]);
    expect(normalizeExport(files, 'a').items).toHaveLength(6);
    fs.rmSync(dir, { recursive: true });
  });

  it('rejects unsupported paths', () => {
    expect(() => readExport(path.join(FIXTURES, '..', 'types.ts'))).toThrow('Unsupported export path');
  });
});
