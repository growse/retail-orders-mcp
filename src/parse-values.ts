// Parsers for the loosely-formatted values in Amazon's export CSVs.

const MISSING = new Set(['', 'not available', 'n/a', 'na', 'null', 'none', '-']);

/**
 * Parse a money string to integer minor units.
 *
 * Amazon's export mixes forms like `12.34`, `£12.34`, `'12.34'`, `1,234.56` and `Not Available`.
 *
 * @param raw - Raw cell value
 * @returns Minor units (e.g. pence), or null when absent/unparseable
 */
export function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const cleaned = raw
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/[£$€,\s]/g, '');
  if (MISSING.has(cleaned.toLowerCase())) return null;
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  // Reason: round rather than truncate — "19.99" * 100 is 1998.9999999999998 in floating point.
  return Math.round(Number(cleaned) * 100);
}

/**
 * Parse an export date/timestamp to YYYY-MM-DD.
 *
 * Accepts ISO timestamps (`2021-03-04T12:34:56Z`, with or without millis) and
 * `2021-03-04 12:34:56 UTC`. The date part is taken as-is (UTC), which can be a day off from
 * the UK card date around midnight — matching uses a date window, so that is tolerated.
 *
 * @param raw - Raw cell value
 * @returns YYYY-MM-DD, or null when absent/unparseable
 */
export function parseDate(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const v = raw.trim().replace(/^['"]+|['"]+$/g, '');
  if (MISSING.has(v.toLowerCase())) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Parse a quantity, defaulting to 1 for blanks.
 *
 * @param raw - Raw cell value
 * @returns Positive integer quantity
 */
export function parseQuantity(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Whole days from `a` to `b` (b - a), both YYYY-MM-DD.
 *
 * @param a - Start date
 * @param b - End date
 * @returns Signed day difference
 */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Shift a YYYY-MM-DD date by a number of days.
 *
 * @param date - Base date
 * @param days - Days to add (may be negative)
 * @returns Shifted YYYY-MM-DD
 */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
