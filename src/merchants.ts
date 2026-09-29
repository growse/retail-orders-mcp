// Per-shop settings for signing in and recognising signed-in pages.

export type MerchantId = 'amazon' | 'ebay' | 'etsy';

export interface Merchant {
  id: MerchantId;
  name: string;
  /** Page that requires sign-in and lists orders; used to start and confirm a login */
  ordersUrl: string;
  /** True for sign-in / verification / bot-challenge pages */
  isAuthPage: (url: string) => boolean;
  /** True once the browser has landed on the signed-in orders page */
  isOrdersPage: (url: URL) => boolean;
}

export const MERCHANTS: Record<MerchantId, Merchant> = {
  amazon: {
    id: 'amazon',
    name: 'Amazon',
    ordersUrl: `${process.env.AMAZON_BASE_URL || 'https://www.amazon.co.uk'}/your-orders/orders`,
    isAuthPage: (url) => /\/ap\/(signin|mfa|cvf|challenge)|\/ax\/claim|captcha/i.test(url),
    isOrdersPage: (u) => /\/your-orders\/orders|order-history/.test(u.pathname),
  },
  ebay: {
    id: 'ebay',
    name: 'eBay',
    ordersUrl: 'https://www.ebay.co.uk/mye/myebay/purchase',
    isAuthPage: (url) => /signin\.ebay\.|\/signin\/|captcha|splashui\/challenge/i.test(url),
    isOrdersPage: (u) => /ebay\.co\.uk$/.test(u.hostname) && /\/mye\/myebay\/purchase/.test(u.pathname),
  },
  etsy: {
    id: 'etsy',
    name: 'Etsy',
    ordersUrl: 'https://www.etsy.com/your/purchases',
    isAuthPage: (url) => /\/signin|\/join|captcha/i.test(url),
    isOrdersPage: (u) => /etsy\.com$/.test(u.hostname) && /\/your\/purchases/.test(u.pathname),
  },
};

/**
 * Look up a merchant by id.
 *
 * @param id - Merchant id from the command line
 * @returns Merchant settings
 */
export function merchant(id: string): Merchant {
  if (!(id in MERCHANTS)) throw new Error(`Unknown merchant "${id}" (expected ${Object.keys(MERCHANTS).join(', ')})`);
  return MERCHANTS[id as MerchantId];
}
