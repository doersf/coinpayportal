-- Books review preferences. Its own table, not a finance_settings column:
-- a finance_settings row carries a timezone that defaults to UTC, and
-- inserting one just to store this toggle would pin a zone the merchant
-- never chose.
--
-- auto_accept: suggestions from rules, heuristics and the model are marked
-- reviewed as they land (sync and categorisation runs), so the review queue
-- only holds rows nothing could categorise. On unless turned off.

create table if not exists public.finance_books_settings (
  merchant_id  uuid primary key references public.merchants(id) on delete cascade,
  auto_accept  boolean not null default true,
  updated_at   timestamptz not null default now()
);

alter table public.finance_books_settings enable row level security;
grant select, insert, update, delete on public.finance_books_settings to service_role;
