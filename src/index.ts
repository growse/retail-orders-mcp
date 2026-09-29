#!/usr/bin/env node
/**
 * amazon-orders-mcp
 *
 *   amazon-orders-mcp login --account <name> [--merchant amazon|ebay|etsy]  Sign in (visible Chrome window)
 *   amazon-orders-mcp scrape --account <name> [--from YYYY] [--to YYYY]   Scrape orders + card charges
 *   amazon-orders-mcp import <export.zip|dir|file.csv> --account <name>   Load an Amazon data export
 *   amazon-orders-mcp                                                     Run the MCP server over stdio
 *
 * The database lives at $AMAZON_ORDERS_DB (default ~/.local/share/amazon-orders-mcp/orders.db).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { toJSONSchema } from 'zod';
import { interactiveLogin } from './browser.js';
import { merchant } from './merchants.js';
import { DEFAULT_DB_PATH, OrdersDb } from './db.js';
import { readExport } from './export-reader.js';
import { normalizeExport } from './normalize.js';
import { scrapeAmazon } from './scrape.js';
import { runTool, TOOL_SCHEMAS } from './tools.js';

const dbPath = process.env.AMAZON_ORDERS_DB || DEFAULT_DB_PATH;

function runImport(args: string[]): void {
  const accountIdx = args.indexOf('--account');
  const account = accountIdx >= 0 ? args[accountIdx + 1] : undefined;
  const target = args.find((a, i) => !a.startsWith('--') && i !== accountIdx + 1);
  if (!target || !account) {
    console.error('Usage: amazon-orders-mcp import <export.zip|dir|file.csv> --account <name>');
    process.exit(2);
  }
  if (!fs.existsSync(target)) {
    console.error(`No such file or directory: ${target}`);
    process.exit(2);
  }
  const parsed = normalizeExport(readExport(target), account);
  if (parsed.items.length === 0) {
    // Reason: replaceAccount wipes the account first, so refuse an import that found nothing
    // rather than silently deleting a good earlier import because of a wrong path.
    console.error(`No order items found in ${target}; nothing imported. Unrecognised files:`);
    for (const s of parsed.skipped) console.error(`  ${s.file}: ${s.headers.join(', ')}`);
    process.exit(1);
  }
  const db = new OrdersDb(dbPath);
  db.replaceAccount(account, path.resolve(target), parsed.items, parsed.refunds);
  const orders = new Set(parsed.items.map((i) => i.orderId)).size;
  console.log(`Imported ${parsed.items.length} items in ${orders} orders and ${parsed.refunds.length} refunds`);
  console.log(`  account: ${account}\n  db: ${dbPath}`);
  if (parsed.skipped.length > 0) {
    console.log(`Skipped ${parsed.skipped.length} unrecognised CSV(s):`);
    for (const s of parsed.skipped) console.log(`  ${s.file}`);
  }
  db.close();
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function runScrape(args: string[]): Promise<void> {
  const account = flag(args, '--account');
  const thisYear = new Date().getFullYear();
  const toYear = Number(flag(args, '--to') ?? thisYear);
  const fromYear = Number(flag(args, '--from') ?? thisYear - 9);
  if (!account || !Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    console.error('Usage: amazon-orders-mcp scrape --account <name> [--from YYYY] [--to YYYY]');
    process.exit(2);
  }
  const db = new OrdersDb(dbPath);
  try {
    console.log(`Scraping ${account}: ${toYear} back to ${fromYear} (a Chrome window will open; leave it be)`);
    const result = await scrapeAmazon(db, { account, fromYear, toYear, log: (m) => console.log(m) });
    console.log(`Done: ${result.orders} orders, ${result.charges} card charges -> ${dbPath}`);
  } finally {
    db.close();
  }
}

async function runServer(): Promise<void> {
  const db = new OrdersDb(dbPath);
  const server = new Server({ name: 'amazon-orders-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: Object.entries(TOOL_SCHEMAS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: toJSONSchema(t.schema, { io: 'input' }) as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    try {
      const result = runTool(db, request.params.name, request.params.arguments);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  await server.connect(new StdioServerTransport());
  console.error(`amazon-orders-mcp running on stdio (db: ${dbPath})`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'import') {
  runImport(rest);
} else if (command === 'scrape') {
  runScrape(rest).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (command === 'login') {
  const account = flag(rest, '--account');
  if (!account) {
    console.error('Usage: amazon-orders-mcp login --account <name> [--merchant amazon|ebay|etsy]');
    process.exit(2);
  }
  Promise.resolve()
    .then(() => interactiveLogin(merchant(flag(rest, '--merchant') ?? 'amazon'), account))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
} else if (command === undefined) {
  runServer().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}
