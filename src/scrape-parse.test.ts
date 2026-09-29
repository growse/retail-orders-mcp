import { describe, expect, it } from 'vitest';
import { parseOrderCards, parseTransactionsText, parseUkDate } from './scrape-parse.js';

describe('parseUkDate', () => {
  it('parses long and short month names', () => {
    expect(parseUkDate('27 December 2021')).toBe('2021-12-27');
    expect(parseUkDate('8 Jul 2026')).toBe('2026-07-08');
    expect(parseUkDate('04 Sept 2022')).toBe('2022-09-04');
  });

  it('rejects other formats', () => {
    expect(parseUkDate('2021-12-27')).toBeNull();
    expect(parseUkDate('27 Foo 2021')).toBeNull();
  });
});

describe('parseOrderCards', () => {
  it('reads date, charged total, id and products from a card', () => {
    const orders = parseOrderCards([
      {
        headers: {
          'Order placed': '26 December 2021',
          Total: '£79.99',
          'Dispatch to': 'A',
          'Order #': '202-0000000-0000002',
        },
        text: '',
        products: ['  Ubiquiti UniFi 6 Lite\n  Access Point '],
      },
    ]);
    expect(orders).toEqual([
      {
        orderId: '202-0000000-0000002',
        orderDate: '2021-12-26',
        total: 7999,
        currency: 'GBP',
        products: ['Ubiquiti UniFi 6 Lite Access Point'],
      },
    ]);
  });

  it('falls back to the card text for the id, and drops cards without id or date', () => {
    const orders = parseOrderCards([
      {
        headers: { 'Order placed': '1 May 2020', Total: 'Not Available' },
        text: 'x D01-1234567-7654321 y',
        products: [],
      },
      { headers: { 'Order placed': 'yesterday' }, text: '202-1111111-1111111', products: [] },
      { headers: { 'Order placed': '1 May 2020' }, text: 'no id here', products: [] },
    ]);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ orderId: 'D01-1234567-7654321', total: null });
  });
});

describe('parseTransactionsText', () => {
  const text = [
    'View gift card activity to see gift card refunds.',
    '04 Jun 2022·AWS EMEA',
    'MasterCard••••4242',
    'Order #80000000000001',
    '-$1.00',
    'Pending',
    '08 Jul 2026·AMZNMktplace',
    'AmericanExpress••••9999',
    'Order #206-0000000-0000001',
    '-£55.98',
    'Charged',
    '10 Jul 2026·Amazon.co.uk',
    'Visa••••1234',
    'Order #202-0000000-0000001',
    '£12.00',
    'Refunded',
    '11 Jul 2026·Broken entry with no order',
    '-£1.00',
    'Back to top',
  ].join('\n');

  it('parses charges and refunds with card, order and signed amount', () => {
    const charges = parseTransactionsText(text);
    expect(charges).toHaveLength(3);
    expect(charges[1]).toEqual({
      date: '2026-07-08',
      merchant: 'AMZNMktplace',
      card: 'AmericanExpress',
      last4: '9999',
      orderId: '206-0000000-0000001',
      amount: -5598,
      currency: 'GBP',
      status: 'Charged',
    });
    expect(charges[0]).toMatchObject({ currency: 'USD', amount: -100, status: 'Pending' });
    expect(charges[2]).toMatchObject({ amount: 1200, status: 'Refunded' });
  });

  it('returns nothing for a page without transactions', () => {
    expect(parseTransactionsText('Your Payments\nNothing here')).toEqual([]);
  });
});
