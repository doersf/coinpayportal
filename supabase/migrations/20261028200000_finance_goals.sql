-- Finances: goals.
--
-- A goal is something the owner is saving toward (a house, a car, an
-- emergency fund) or paying off (a card, a loan), with a target amount and a
-- deadline. Progress is read from real balances where the goal is linked to
-- finance accounts (bank/card/loan feeds) or CoinPay web wallets, and from
-- contributions the owner records by hand otherwise. Nothing here moves money.
--
-- - finance_goals: one row per goal. `start_progress` is the progress the
--   goal had when it was created (a linked savings account that already held
--   $5,000 starts at $5,000), so "on track" is measured from where the owner
--   actually started, not from zero. For a payoff goal `starting_amount` is
--   the debt owed at the start; progress is how much of it is gone.
-- - finance_goal_contributions: manual amounts toward a goal (negative for a
--   withdrawal), dated, so period reports can place them.
-- - finance_email_schedules gains kind `goals_digest` (opt-in, never created
--   by a backfill) and a `cadence` column: daily, weekly, monthly or
--   quarterly. Other kinds leave it null and keep their weekday schedule.
--
-- RLS on with no policies, like every finance table: the app (service role)
-- is the only reader and writer. Additive only.

create table if not exists public.finance_goals (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references public.merchants(id) on delete cascade,
  name                text not null check (char_length(name) between 1 and 80),
  kind                text not null check (kind in ('house', 'car', 'emergency_fund', 'debt_payoff', 'custom')),
  target_amount       numeric(20,2) not null check (target_amount > 0),
  currency            text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  start_date          date not null default current_date,
  deadline            date not null,
  starting_amount     numeric(20,2) check (starting_amount is null or starting_amount >= 0),
  start_progress      numeric(20,2) not null default 0,
  linked_account_ids  uuid[] not null default '{}',
  linked_wallet_ids   uuid[] not null default '{}',
  notes               text check (notes is null or char_length(notes) <= 500),
  archived_at         timestamptz,
  achieved_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (deadline > start_date)
);

create index if not exists finance_goals_merchant_idx
  on public.finance_goals (merchant_id) where archived_at is null;

comment on table public.finance_goals is
  'Savings and payoff goals with a target and deadline; progress from linked balances or manual contributions. Service role only.';

create table if not exists public.finance_goal_contributions (
  id           uuid primary key default gen_random_uuid(),
  goal_id      uuid not null references public.finance_goals(id) on delete cascade,
  merchant_id  uuid not null references public.merchants(id) on delete cascade,
  amount       numeric(20,2) not null check (amount <> 0),
  occurred_on  date not null default current_date,
  note         text check (note is null or char_length(note) <= 200),
  created_at   timestamptz not null default now()
);

create index if not exists finance_goal_contributions_goal_idx
  on public.finance_goal_contributions (goal_id, occurred_on);

comment on table public.finance_goal_contributions is
  'Manual contributions toward a finance goal (negative = withdrawal). Service role only.';

alter table public.finance_goals enable row level security;
alter table public.finance_goal_contributions enable row level security;
revoke all on table public.finance_goals from public, anon, authenticated;
revoke all on table public.finance_goal_contributions from public, anon, authenticated;
grant select, insert, update, delete on table public.finance_goals to service_role;
grant select, insert, update, delete on table public.finance_goal_contributions to service_role;

alter table public.finance_email_schedules
  add column if not exists cadence text;

alter table public.finance_email_schedules drop constraint if exists finance_email_schedules_cadence_check;
alter table public.finance_email_schedules
  add constraint finance_email_schedules_cadence_check
  check (cadence is null or cadence in ('daily', 'weekly', 'monthly', 'quarterly'));

alter table public.finance_email_schedules drop constraint if exists finance_email_schedules_kind_check;
alter table public.finance_email_schedules
  add constraint finance_email_schedules_kind_check
  check (kind in ('weekly_digest', 'daily_summary', 'weekly_payments', 'business_report', 'goals_digest'));
