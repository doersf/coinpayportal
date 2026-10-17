-- USDT on TRON (TRC-20) as a payment chain: 'USDT_TRON'.
--
-- Three CHECK constraints enumerate the chains a row may name. Widening a CHECK
-- is safe against existing rows (every stored value already satisfies the
-- narrower list). payment_addresses.cryptocurrency and
-- system_wallet_indexes.cryptocurrency have no CHECK; both are varchar(10),
-- which 'USDT_TRON' (9) fits.

alter table public.payments
  drop constraint if exists payments_blockchain_check;
alter table public.payments
  add constraint payments_blockchain_check check (
    blockchain = any (array[
      'BTC', 'BCH', 'ETH', 'POL', 'SOL',
      'DOGE', 'XRP', 'ADA', 'BNB',
      'USDT', 'USDT_ETH', 'USDT_POL', 'USDT_SOL', 'USDT_TRON',
      'USDC', 'USDC_ETH', 'USDC_POL', 'USDC_SOL', 'USDC_BASE',
      -- legacy, pre-POL-rename
      'MATIC', 'USDC_MATIC'
    ])
  );

alter table public.business_wallets
  drop constraint if exists business_wallets_cryptocurrency_check;
alter table public.business_wallets
  add constraint business_wallets_cryptocurrency_check check (
    cryptocurrency = any (array[
      'BTC', 'BCH', 'ETH', 'POL', 'SOL',
      'DOGE', 'XRP', 'ADA', 'BNB',
      'USDT', 'USDT_ETH', 'USDT_POL', 'USDT_SOL', 'USDT_TRON',
      'USDC', 'USDC_ETH', 'USDC_POL', 'USDC_SOL', 'USDC_BASE'
    ])
  );

alter table public.merchant_wallets
  drop constraint if exists merchant_wallets_cryptocurrency_check;
alter table public.merchant_wallets
  add constraint merchant_wallets_cryptocurrency_check check (
    cryptocurrency = any (array[
      'BTC', 'BCH', 'ETH', 'POL', 'SOL',
      'DOGE', 'XRP', 'ADA', 'BNB',
      'USDT', 'USDT_ETH', 'USDT_POL', 'USDT_SOL', 'USDT_TRON',
      'USDC', 'USDC_ETH', 'USDC_POL', 'USDC_SOL', 'USDC_BASE'
    ])
  );
