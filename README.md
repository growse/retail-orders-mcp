# amazon-orders-mcp

A local MCP server over your Amazon order history, built for matching bank/card charges to the
orders behind them (e.g. to categorise Amazon spending in Actual Budget).

Data comes from two sources, both stored in a local SQLite database (Node's built-in
`node:sqlite`, so no native modules):

- **Scraping your signed-in amazon.co.uk session** (recommended): order history (date, amount
  charged, order number, items) for every year, plus Amazon's own record of recent card charges.
- **Amazon's "Request your data" export**: per-item prices, dispatch dates and refunds.

## Scrape (recommended)

Uses your installed Google Chrome through `playwright-core` (no browser download). Each account
gets its own Chrome profile under `~/.local/share/amazon-orders-mcp/`, separate from your normal
browser. You sign in by hand once; the tool never sees your password.

```sh
npm install && npm run build
node build/index.js login --account andrew                  # sign in in the window that opens (2FA etc.)
node build/index.js scrape --account andrew --from 2017     # visible window; leave it alone while it runs
node build/index.js login --account lorna                   # a second Amazon account, if any
node build/index.js scrape --account lorna --from 2017
```

Scraping runs in a visible window because Amazon answers headless Chrome with a 503, and it
pauses a few seconds between pages. Re-running is safe (orders are upserted); progress is saved
after every page. If the session expires, run `login` again.

Limits: the order list shows what was charged per order (net of gift cards) but not per-shipment
charges or dispatch dates, and Amazon's Transactions page only lists the ~20 most recent card
charges. Orders shipped in several parts, and refunds, match better with the data export.

## Data export (optional)

1. amazon.co.uk → Account → _Request your data_ (Privacy Central) → request **Your Orders**.
2. When the email arrives (usually within a day or two), download the zip. No need to unzip it —
   nested zips are handled.

Import it:

```sh
node build/index.js import ~/Downloads/Your\ Orders.zip --account andrew
node build/index.js import ~/Downloads/lorna-orders.zip --account lorna   # optional, one per Amazon account
```

Re-importing an account replaces its data (each export is a full snapshot). The import refuses to
run if it finds no order items, and lists any CSVs it didn't recognise.

The database defaults to `~/.local/share/amazon-orders-mcp/orders.db`; override with
`AMAZON_ORDERS_DB`.

Register with Claude Code:

```sh
claude mcp add amazon-orders -- node ~/Projects/amazon-orders-mcp/build/index.js
```

## Tools

| Tool                    | Purpose                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `find_order_candidates` | Card charges / shipments / orders / single items (or refunds, for positive amounts) matching one bank transaction |
| `match_charges`         | Batch of the above (up to 500 charges); each result is `unique`, `ambiguous` or `none`                            |
| `get_order`             | All items, ship dates and refunds for an order id                                                                 |
| `search_items`          | Substring search over item names                                                                                  |
| `list_orders`           | Orders placed in a date range with totals                                                                         |
| `list_refunds`          | Refunds in a date range                                                                                           |
| `stats`                 | Imported accounts, order counts, date coverage                                                                    |

Amounts in tool arguments are in currency units as they appear in the bank (negative = purchase,
positive = refund). Amounts in results are decimal strings.

## How matching works

Candidates are ranked strongest first:

1. **charge** — Amazon's own record of a card charge with the same amount (same sign) within
   `window_days` either side. Exact; identifies the order directly.
2. **shipment** (export) — see below.
3. **order** — an order's charged total within `window_days` after the order date (scrape), or a
   whole order's total (export).
4. **item** (export) — a single line item charged on its own.

For the export, Amazon UK charges when it dispatches, so the primary unit is a **shipment**: items in the same order
with the same ship date, summed by `Total Owed`. A charge matches when the total is within the
tolerance (default 0.01) and the charge posts between 2 days before and `window_days` (default 10)
after the ship date. Whole-order totals (for orders charged in one go) and single items (for items
charged separately) are offered as lower-ranked fallbacks. Cancelled orders are ignored. Orders
placed up to 60 days before the window are considered, to catch pre-orders.

## Development

```sh
npm test          # vitest
npm run quality   # prettier check + type-check
```
