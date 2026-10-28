-- business_payout_wallets was created after the 2026-10-26 default-privilege
-- change, so the service role (the only role CoinPay queries as) got no grant
-- and every create failed "permission denied". Applied on prod 2026-10-28.
grant all on public.business_payout_wallets to service_role;
