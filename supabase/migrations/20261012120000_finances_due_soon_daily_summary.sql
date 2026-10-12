-- Finances: due soon + daily summary.
--
-- 1. A card or loan's statement due day. No feed carries it (SimpleFIN has
--    no such field; Plaid liabilities was never linked), so the owner states
--    it once per account and the due-soon list projects it monthly.
--    `payment_due_amount` null means "the statement balance".
-- 2. `daily_summary` joins `weekly_digest` as a schedule kind; the same
--    worker turns a due row into an `email_report` job.
-- 3. Our own merchant gets a daily summary at 07:00 Pacific, every account.
--    Nobody else is opted in.
--
-- Additive only: the deployed code selects explicit account columns, so the
-- new columns must exist before the code that reads them ships.

alter table public.finance_accounts
  add column if not exists payment_due_day smallint
    check (payment_due_day between 1 and 31);

alter table public.finance_accounts
  add column if not exists payment_due_amount numeric(20,4)
    check (payment_due_amount is null or payment_due_amount >= 0);

comment on column public.finance_accounts.payment_due_day is
  'Statement due day of month, stated by the owner. A day past the end of a short month means its last day.';
comment on column public.finance_accounts.payment_due_amount is
  'Fixed amount due on payment_due_day (a loan instalment or minimum); null shows the statement balance.';

alter table public.finance_email_schedules drop constraint if exists finance_email_schedules_kind_check;
alter table public.finance_email_schedules
  add constraint finance_email_schedules_kind_check
  check (kind in ('weekly_digest', 'daily_summary'));

insert into public.finance_email_schedules
  (merchant_id, kind, weekdays, hour, timezone, recipients, scope, formats, active, next_run_at)
select m.id, 'daily_summary', '{0,1,2,3,4,5,6}', 7, 'America/Los_Angeles',
       '{anthony@profullstack.com}', 'all', '{html}', true,
       -- The next 07:00 Pacific from now.
       (date_trunc('day', now() at time zone 'America/Los_Angeles')
          + interval '7 hours'
          + case when (now() at time zone 'America/Los_Angeles')::time >= time '07:00'
                 then interval '1 day' else interval '0' end)
         at time zone 'America/Los_Angeles'
  from public.merchants m
 where m.email = 'anthony@profullstack.com'
on conflict (merchant_id, kind) do nothing;
