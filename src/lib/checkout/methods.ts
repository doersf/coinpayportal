/**
 * Every coin CoinPay can take, in hosted-checkout display order: stablecoins
 * first (cheapest chains first), then native coins. No imports, so the client
 * page can use it too.
 */
export type MethodGroup = 'stablecoin' | 'crypto' | 'paypal';

export interface CheckoutMethod {
  code: string;
  label: string;
  ticker: string;
  chain: string | null;
  group: MethodGroup;
}

export const PAYPAL_METHOD = 'PAYPAL';

export const CHECKOUT_COINS: CheckoutMethod[] = [
  { code: 'USDC_POL', label: 'USDC on Polygon', ticker: 'USDC', chain: 'Polygon', group: 'stablecoin' },
  { code: 'USDC_SOL', label: 'USDC on Solana', ticker: 'USDC', chain: 'Solana', group: 'stablecoin' },
  { code: 'USDC_BASE', label: 'USDC on Base', ticker: 'USDC', chain: 'Base', group: 'stablecoin' },
  { code: 'USDC_ETH', label: 'USDC on Ethereum', ticker: 'USDC', chain: 'Ethereum', group: 'stablecoin' },
  { code: 'USDC', label: 'USDC (ERC-20)', ticker: 'USDC', chain: 'Ethereum', group: 'stablecoin' },
  { code: 'USDT_POL', label: 'USDT on Polygon', ticker: 'USDT', chain: 'Polygon', group: 'stablecoin' },
  { code: 'USDT_SOL', label: 'USDT on Solana', ticker: 'USDT', chain: 'Solana', group: 'stablecoin' },
  { code: 'USDT_TRON', label: 'USDT on TRON (TRC-20)', ticker: 'USDT', chain: 'TRON', group: 'stablecoin' },
  { code: 'USDT_ETH', label: 'USDT on Ethereum', ticker: 'USDT', chain: 'Ethereum', group: 'stablecoin' },
  { code: 'USDT', label: 'USDT (ERC-20)', ticker: 'USDT', chain: 'Ethereum', group: 'stablecoin' },
  { code: 'BTC', label: 'Bitcoin', ticker: 'BTC', chain: null, group: 'crypto' },
  { code: 'ETH', label: 'Ethereum', ticker: 'ETH', chain: null, group: 'crypto' },
  { code: 'SOL', label: 'Solana', ticker: 'SOL', chain: null, group: 'crypto' },
  { code: 'POL', label: 'Polygon', ticker: 'POL', chain: null, group: 'crypto' },
  { code: 'BNB', label: 'BNB', ticker: 'BNB', chain: 'BNB Chain', group: 'crypto' },
  { code: 'XRP', label: 'XRP', ticker: 'XRP', chain: null, group: 'crypto' },
  { code: 'ADA', label: 'Cardano', ticker: 'ADA', chain: null, group: 'crypto' },
  { code: 'DOGE', label: 'Dogecoin', ticker: 'DOGE', chain: null, group: 'crypto' },
  { code: 'BCH', label: 'Bitcoin Cash', ticker: 'BCH', chain: null, group: 'crypto' },
];
