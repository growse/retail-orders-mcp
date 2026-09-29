// Reads CSVs out of an Amazon "Request your data" export: a .zip (possibly nested), a directory, or one CSV.
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { parse } from 'csv-parse/sync';

export interface CsvFile {
  /** Path within the export, for reporting */
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

function parseCsv(name: string, text: string): CsvFile {
  const rows = parse(text, {
    columns: (h: string[]) => h.map((x) => x.trim()),
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
  }) as Record<string, string>[];
  const headers = rows.length > 0 ? Object.keys(rows[0]) : firstLineHeaders(text);
  return { name, headers, rows };
}

function firstLineHeaders(text: string): string[] {
  const first = text.replace(/^﻿/, '').split(/\r?\n/, 1)[0] ?? '';
  return first.split(',').map((h) => h.replace(/^"|"$/g, '').trim());
}

function readZip(name: string, data: Uint8Array): CsvFile[] {
  // Reason: Amazon's download is often a zip of zips (one per data category), so recurse one
  // level into any .zip entries rather than requiring the user to unpack them by hand.
  const entries = unzipSync(data, {
    filter: (f) => /\.(csv|zip)$/i.test(f.name) && !f.name.startsWith('__MACOSX/'),
  });
  const out: CsvFile[] = [];
  for (const [entry, bytes] of Object.entries(entries)) {
    const full = `${name}!${entry}`;
    if (/\.zip$/i.test(entry)) out.push(...readZip(full, bytes));
    else out.push(parseCsv(full, new TextDecoder('utf-8').decode(bytes)));
  }
  return out;
}

function readDir(dir: string): CsvFile[] {
  const out: CsvFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readDir(full));
    else if (/\.(csv|zip)$/i.test(entry.name)) out.push(...readExport(full));
  }
  return out;
}

/**
 * Read every CSV in an export.
 *
 * @param target - Path to a .zip, a directory, or a single .csv
 * @returns Parsed CSV files, in discovery order
 */
export function readExport(target: string): CsvFile[] {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return readDir(target);
  if (/\.zip$/i.test(target)) return readZip(path.basename(target), fs.readFileSync(target));
  if (/\.csv$/i.test(target)) return [parseCsv(path.basename(target), fs.readFileSync(target, 'utf-8'))];
  throw new Error(`Unsupported export path (expected .zip, .csv or a directory): ${target}`);
}
