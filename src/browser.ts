// Drives the locally installed Chrome with dedicated, persistent profiles (one per shop + account).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { MERCHANTS, type Merchant, type MerchantId } from './merchants.js';

const PROFILE_ROOT = path.join(os.homedir(), '.local', 'share', 'amazon-orders-mcp');

export const AMAZON_BASE = process.env.AMAZON_BASE_URL || 'https://www.amazon.co.uk';
export const ORDERS_URL = MERCHANTS.amazon.ordersUrl;

const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * Chrome profile directory for a shop + account. Each gets its own profile so several people's
 * sessions (e.g. partners with separate logins) and several shops can coexist.
 *
 * @param merchantId - Shop the session is for
 * @param account - Account label used with --account
 * @returns Absolute profile directory
 */
export function profileDir(merchantId: MerchantId, account: string): string {
  if (!/^[\w.-]+$/.test(account)) throw new Error(`Invalid account name: ${account}`);
  return process.env.AMAZON_PROFILE_DIR || path.join(PROFILE_ROOT, `chrome-profile-${merchantId}-${account}`);
}

/**
 * Open Chrome on a dedicated profile.
 *
 * Reason: a separate profile keeps each shop session isolated from the user's everyday browser,
 * and persisting it means the user signs in (password, 2FA) once, by hand — the tool never sees
 * credentials.
 *
 * @param merchantId - Shop; selects the Chrome profile
 * @param account - Account label; selects the Chrome profile
 * @param headless - Run without a window (Amazon rejects headless Chrome, so scrapers pass false)
 * @returns A browser context; close it when done
 */
export async function openBrowser(merchantId: MerchantId, account: string, headless: boolean): Promise<BrowserContext> {
  const dir = profileDir(merchantId, account);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(dir, {
    channel: 'chrome',
    headless,
    viewport: { width: 1280, height: 900 },
    locale: 'en-GB',
  });
}

/** True when the page is an Amazon sign-in / verification step rather than real content. */
export function isAuthPage(url: string): boolean {
  return MERCHANTS.amazon.isAuthPage(url);
}

/**
 * Open a visible window on the shop's orders page and wait for the user to finish signing in.
 *
 * @param m - Shop to sign in to
 * @param account - Account label; selects the Chrome profile
 * @returns Resolves once the orders page loads without a sign-in redirect
 */
export async function interactiveLogin(m: Merchant, account: string): Promise<void> {
  const context = await openBrowser(m.id, account, false);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(m.ordersUrl);
  console.log(`Sign in to ${m.name} in the Chrome window (including any 2FA). Waiting up to 10 minutes...`);
  await page.waitForURL((u) => m.isOrdersPage(u) && !m.isAuthPage(u.href), { timeout: LOGIN_TIMEOUT_MS });
  await page.waitForLoadState('domcontentloaded');
  console.log(`Signed in; session saved to ${profileDir(m.id, account)}`);
  await context.close();
}

/**
 * Navigate and fail loudly if the shop bounced us to sign-in (session expired) or blocked us.
 *
 * @param page - Page to use
 * @param url - Absolute URL
 * @param m - Shop the URL belongs to (defaults to Amazon)
 */
export async function gotoAuthed(page: Page, url: string, m: Merchant = MERCHANTS.amazon): Promise<void> {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (m.isAuthPage(page.url())) {
    throw new Error(`${m.name} asked to sign in again. Run \`login --merchant ${m.id}\` and retry.`);
  }
  // Reason: bot defences (Amazon in particular) answer with a bare 503 page rather than a
  // challenge; stop instead of recording an empty year.
  if (response?.status() === 503) {
    throw new Error(`${m.name} returned 503 (likely rate limiting / bot detection). Wait a while and retry.`);
  }
}
