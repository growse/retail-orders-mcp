import { describe, expect, it } from 'vitest';
import {
  findChargeCandidates,
  findPurchaseCandidates,
  findRefundCandidates,
  findScrapedOrderCandidates,
  mergeCandidates,
} from './matcher.js';
import type { StoredCharge } from './db.js';
import type { OrderItem, Refund } from './types.js';

const opts = { windowDays: 10, tolerance: 1 };

function item(o: Partial<OrderItem> & Pick<OrderItem, 'orderId' | 'totalOwed'>): OrderItem {
  return {
    account: 'a',
    website: 'Amazon.co.uk',
    orderDate: '2026-05-18',
    shipDate: '2026-05-19',
    productName: 'Thing',
    asin: 'X',
    quantity: 1,
    currency: 'GBP',
    orderStatus: 'Closed',
    paymentInstrument: 'Visa',
    ...o,
  };
}

const splitOrder = [
  item({ orderId: 'B', totalOwed: 999, productName: 'Minifig', shipDate: '2026-05-19' }),
  item({ orderId: 'B', totalOwed: 11799, productName: 'Excavator', shipDate: '2026-05-25' }),
];

describe('findPurchaseCandidates', () => {
  it('matches each shipment of a split order to its own charge', () => {
    const first = findPurchaseCandidates(splitOrder, -999, '2026-05-20', opts);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ kind: 'shipment', orderId: 'B', dayOffset: 1, total: 999 });

    const second = findPurchaseCandidates(splitOrder, -11799, '2026-05-26', opts);
    expect(second[0]).toMatchObject({ kind: 'shipment', date: '2026-05-25' });
  });

  it('offers the whole order when it was charged in one go', () => {
    const c = findPurchaseCandidates(splitOrder, -12798, '2026-05-20', opts);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'order', date: '2026-05-19' });
    expect(c[0].items).toHaveLength(2);
  });

  it('sums items that ship together and ranks shipments above single items', () => {
    const items = [
      item({ orderId: 'A', totalOwed: 2798, shipDate: '2026-07-07' }),
      item({ orderId: 'A', totalOwed: 2800, shipDate: '2026-07-07' }),
      item({ orderId: 'Z', totalOwed: 5598, shipDate: '2026-07-08' }),
    ];
    const c = findPurchaseCandidates(items, -5598, '2026-07-08', opts);
    expect(c.map((x) => [x.kind, x.orderId])).toEqual([
      ['shipment', 'Z'],
      ['shipment', 'A'],
    ]);
  });

  it('respects tolerance and the date window, including a small early allowance', () => {
    const one = [item({ orderId: 'A', totalOwed: 1000, shipDate: '2026-07-10' })];
    expect(findPurchaseCandidates(one, -1001, '2026-07-10', opts)).toHaveLength(1);
    expect(findPurchaseCandidates(one, -1002, '2026-07-10', opts)).toHaveLength(0);
    expect(findPurchaseCandidates(one, -1000, '2026-07-08', opts)).toHaveLength(1);
    expect(findPurchaseCandidates(one, -1000, '2026-07-07', opts)).toHaveLength(0);
    expect(findPurchaseCandidates(one, -1000, '2026-07-21', opts)).toHaveLength(0);
  });

  it('ignores cancelled orders and items with unknown prices', () => {
    const items = [
      item({ orderId: 'C', totalOwed: 500, orderStatus: 'Cancelled' }),
      item({ orderId: 'D', totalOwed: null }),
    ];
    expect(findPurchaseCandidates(items, -500, '2026-05-19', opts)).toEqual([]);
  });
});

describe('findRefundCandidates', () => {
  const refunds: Refund[] = [
    { account: 'a', orderId: 'A', refundDate: '2026-07-20', currency: 'GBP', amount: 2800, status: 'Completed' },
  ];
  const lookup = (id: string): OrderItem[] => (id === 'A' ? [item({ orderId: 'A', totalOwed: 2800 })] : []);

  it('matches a credit to a refund and includes the order items', () => {
    const c = findRefundCandidates(refunds, lookup, 2800, '2026-07-22', opts);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'refund', orderId: 'A', dayOffset: 2, orderDate: '2026-05-18' });
    expect(c[0].items).toHaveLength(1);
  });

  it('finds nothing outside the window', () => {
    expect(findRefundCandidates(refunds, lookup, 2800, '2026-08-15', opts)).toEqual([]);
  });
});

describe('findChargeCandidates', () => {
  const charge = (o: Partial<StoredCharge>): StoredCharge => ({
    account: 'a',
    date: '2026-06-01',
    merchant: 'AMZNMktplace',
    card: 'Amex',
    last4: '9999',
    orderId: 'O1',
    amount: -2122,
    currency: 'GBP',
    status: 'Charged',
    ...o,
  });
  const ctx = (): { orderDate: string; products: string[] } => ({ orderDate: '2026-05-25', products: ['Widget'] });

  it('matches a bank date several days before Amazon records the charge', () => {
    const c = findChargeCandidates([charge({})], ctx, -2122, '2026-05-27', opts);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ kind: 'charge', dayOffset: -5, items: [{ productName: 'Widget' }] });
  });

  it('requires the same sign and a close amount', () => {
    expect(findChargeCandidates([charge({})], ctx, 2122, '2026-06-01', opts)).toEqual([]);
    expect(findChargeCandidates([charge({})], ctx, -2200, '2026-06-01', opts)).toEqual([]);
    expect(findChargeCandidates([charge({})], ctx, -2122, '2026-06-20', opts)).toEqual([]);
  });
});

describe('findScrapedOrderCandidates / mergeCandidates', () => {
  const order = {
    account: 'a',
    orderId: 'O1',
    orderDate: '2021-12-26',
    total: 7999,
    currency: 'GBP',
    products: ['AP'],
  };

  it('matches an order total within the window after the order date', () => {
    expect(findScrapedOrderCandidates([order], -7999, '2021-12-30', opts)).toHaveLength(1);
    expect(findScrapedOrderCandidates([order], -7999, '2022-01-20', opts)).toHaveLength(0);
    expect(findScrapedOrderCandidates([{ ...order, total: null }], -7999, '2021-12-30', opts)).toHaveLength(0);
  });

  it('keeps the strongest candidate when two sources find the same charge', () => {
    const viaOrder = findScrapedOrderCandidates([order], -7999, '2021-12-27', opts);
    const viaCharge = [{ ...viaOrder[0], kind: 'charge' as const }];
    expect(mergeCandidates(viaOrder, viaCharge).map((c) => c.kind)).toEqual(['charge']);
  });
});
