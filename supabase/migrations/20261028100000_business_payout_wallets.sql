-- A keyed sending wallet per business for /api/payouts/create (2026-10-28).
--
-- Payouts sign with business_wallets.encrypted_private_key, but business
-- wallets are the merchant's own receive addresses: 0 of 1,475 rows had a
-- key and nothing ever wrote one, so every payout failed with "No active
-- wallet with a private key". This is a separate hot wallet CoinPay
-- generates and holds the key for. The merchant funds it (token + native
-- gas) and payouts send from it. Receive addresses and forwarding are
-- untouched.
--
-- One EVM key serves every EVM payout coin (POL, ETH, BNB and the USDC/USDT
-- tokens on Polygon, Ethereum and Base). Service role only.

create table if not exists public.business_payout_wallets (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  family text not null check (family in ('evm')),
  address text not null,
  encrypted_private_key text not null,
  created_by text,
  created_at timestamptz not null default now(),
  unique (business_id, family)
);

alter table public.business_payout_wallets enable row level security;
revoke all on public.business_payout_wallets from anon, authenticated;
