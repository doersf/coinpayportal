-- Finances: the opt-in business report, and Connect CrawlProof.
--
-- 1. `business_report` becomes a third finance_email_schedules kind. Unlike
--    the daily summary and the weekly digest it is NOT a default report:
--    nothing creates it except the owner turning it on, there is no backfill,
--    and turning it off or the one-click link in every email deletes it.
-- 2. `merchant_crawlproof_connections`: one read-only CrawlProof API token
--    (scope stats:read, checked when it is saved) per merchant, encrypted with
--    ENCRYPTION_KEY by the app. The business report reads that merchant's own
--    site stats with it; disconnecting deletes the row.
--
-- Additive only. RLS on with no policies: only the service role reads it.

alter table public.finance_email_schedules drop constraint if exists finance_email_schedules_kind_check;
alter table public.finance_email_schedules
  add constraint finance_email_schedules_kind_check
  check (kind in ('weekly_digest', 'daily_summary', 'weekly_payments', 'business_report'));

create table if not exists public.merchant_crawlproof_connections (
  merchant_id      uuid primary key references public.merchants(id) on delete cascade,
  token_encrypted  text not null,
  -- First 8 characters of the token (crp_xxxx), for the UI only.
  token_prefix     text not null,
  sites_count      integer not null default 0,
  connected_at     timestamptz not null default now(),
  last_ok_at       timestamptz,
  last_error       text,
  updated_at       timestamptz not null default now()
);

alter table public.merchant_crawlproof_connections enable row level security;
revoke all on public.merchant_crawlproof_connections from anon, authenticated;

comment on table public.merchant_crawlproof_connections is
  'A merchant''s read-only (stats:read) CrawlProof token, AES-GCM encrypted by the app. Read only by the service role for the business report.';
