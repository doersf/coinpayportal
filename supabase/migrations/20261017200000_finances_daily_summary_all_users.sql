-- Finances: the daily summary for every merchant with a linked bank or card.
--
-- Per-merchant email preferences, kept apart from `finance_settings` on
-- purpose: an upsert there for a target alone would also write the default
-- 'UTC' timezone, and a saved timezone stops the app asking for one.
--
-- 1. `daily_spend_target`: the owner's own $/day target, shown as the top
--    line of the summary. Null means none set.
-- 2. `daily_summary_opted_out_at`: set by `coinpay finances daily off`, the
--    DELETE route and the one-click unsubscribe link. While it is set, nothing
--    automatic (the backfill, linking another connection) creates a daily
--    summary again; only the owner turning it back on clears it.
--
-- The subscriptions themselves are created by the app (`daily-subscriptions.ts`):
-- the worker backfills any merchant with an active connection and no
-- schedule, and linking a first connection subscribes immediately. Each goes
-- to the merchant's own address only.
--
-- Additive only. RLS on with no policies, like every finance table: the app
-- (service role) is the only reader.

create table if not exists public.finance_email_preferences (
  merchant_id                 uuid primary key references public.merchants(id) on delete cascade,
  daily_spend_target          numeric(20,2)
                                check (daily_spend_target is null or daily_spend_target >= 0),
  daily_summary_opted_out_at  timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

comment on table public.finance_email_preferences is
  'Per-merchant finance email preferences: daily spend target and daily summary opt-out. Service role only.';
comment on column public.finance_email_preferences.daily_summary_opted_out_at is
  'When the owner turned the daily summary off or unsubscribed. While set, it is never re-created automatically.';

alter table public.finance_email_preferences enable row level security;
revoke all on table public.finance_email_preferences from public, anon, authenticated;
grant select, insert, update, delete on table public.finance_email_preferences to service_role;
