-- merchant_crawlproof_connections (20261019190000) was created without a
-- grant to service_role, and this self-hosted Supabase does not add one by
-- default, so every read and save from the app failed with "permission denied
-- for table merchant_crawlproof_connections" and Connect CrawlProof could not
-- save a token. Applied by hand on prod 2026-10-19.

grant select, insert, update, delete on public.merchant_crawlproof_connections to service_role;
