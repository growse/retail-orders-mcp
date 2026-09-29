import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, parseDate, parseMoney, parseQuantity } from './parse-values.js';

describe('parseMoney', () => {
  it.each([
    ['27.98', 2798],
    ['£1,234.56', 123456],
    ["'3.99'", 399],
    ['19.99', 1999],
    ['-0.01', -1],
  ])('parses %s', (raw, expected) => {
    expect(parseMoney(raw)).toBe(expected);
  });

  it.each(['Not Available', '', 'N/A', 'abc', undefined])('returns null for %s', (raw) => {
    expect(parseMoney(raw)).toBeNull();
  });
});

describe('parseDate', () => {
  it('takes the date part of ISO and UTC-suffixed timestamps', () => {
    expect(parseDate('2026-07-06T19:02:11Z')).toBe('2026-07-06');
    expect(parseDate('2026-07-06T19:02:11.000Z')).toBe('2026-07-06');
    expect(parseDate('2026-07-06 19:02:11 UTC')).toBe('2026-07-06');
  });

  it('returns null for missing or non-ISO values', () => {
    expect(parseDate('Not Available')).toBeNull();
    expect(parseDate('06/07/2026')).toBeNull();
  });
});

describe('parseQuantity', () => {
  it('defaults blanks and junk to 1', () => {
    expect(parseQuantity('3')).toBe(3);
    expect(parseQuantity('')).toBe(1);
    expect(parseQuantity('0')).toBe(1);
  });
});

describe('date arithmetic', () => {
  it('handles month boundaries and negatives', () => {
    expect(addDays('2026-02-27', 3)).toBe('2026-03-02');
    expect(daysBetween('2026-03-02', '2026-02-27')).toBe(-3);
  });
});
