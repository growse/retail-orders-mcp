import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readExport } from './export-reader.js';
import { isOrderHistory, isRefunds, normalizeExport } from './normalize.js';

const FIXTURES = path.join(import.meta.dirname, 'test-fixtures');

describe('normalizeExport', () => {
  const parsed = normalizeExport(readExport(FIXTURES), 'andrew');

  it('reads order items with money in pence and ISO dates', () => {
    expect(parsed.items).toHaveLength(6);
    expect(parsed.items[0]).toEqual({
      account: 'andrew',
      website: 'Amazon.co.uk',
      orderId: '202-1111111-1111111',
      orderDate: '2026-07-06',
      shipDate: '2026-07-07',
      productName: 'USB-C Hub 7-in-1',
      asin: 'B0AAAAAAA1',
      quantity: 1,
      currency: 'GBP',
      totalOwed: 2798,
      orderStatus: 'Closed',
      paymentInstrument: 'Visa - 1234',
    });
  });

  it('keeps unshipped digital items with a null ship date and quoted prices', () => {
    const kindle = parsed.items.find((i) => i.orderId.startsWith('D01'));
    expect(kindle).toMatchObject({ shipDate: null, totalOwed: 399 });
  });

  it('reads refunds and reports unrecognised files', () => {
    expect(parsed.refunds).toEqual([
      {
        account: 'andrew',
        orderId: '202-1111111-1111111',
        refundDate: '2026-07-20',
        currency: 'GBP',
        amount: 2800,
        status: 'Completed',
      },
    ]);
    expect(parsed.skipped.map((s) => path.basename(s.file))).toEqual(['Digital.Subscriptions.1.csv']);
  });

  it('falls back to unit price plus tax times quantity when Total Owed is absent', () => {
    const result = normalizeExport(
      [
        {
          name: 'old.csv',
          headers: ['Order ID', 'Order Date', 'Product Name', 'Unit Price', 'Unit Price Tax', 'Quantity'],
          rows: [
            {
              'Order ID': '1',
              'Order Date': '2019-01-01T00:00:00Z',
              'Product Name': 'Socks',
              'Unit Price': '5.00',
              'Unit Price Tax': '1.00',
              Quantity: '2',
            },
          ],
        },
      ],
      'a'
    );
    expect(result.items[0].totalOwed).toBe(1200);
  });

  it('skips rows without an order id or date', () => {
    const result = normalizeExport(
      [
        {
          name: 'x.csv',
          headers: ['Order ID', 'Order Date', 'Product Name', 'Total Owed'],
          rows: [{ 'Order ID': '', 'Order Date': '2020-01-01', 'Product Name': 'x', 'Total Owed': '1' }],
        },
      ],
      'a'
    );
    expect(result.items).toEqual([]);
  });
});

describe('file recognition', () => {
  it('distinguishes order history from refund files', () => {
    expect(isOrderHistory(['Order ID', 'Order Date', 'Product Name', 'Total Owed'])).toBe(true);
    expect(isRefunds(['Order ID', 'Refund Completion Date', 'Amount Refunded'])).toBe(true);
    expect(isOrderHistory(['Order ID', 'Refund Completion Date', 'Amount Refunded'])).toBe(false);
  });
});
