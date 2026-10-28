-- Finances: declared recurring costs.
--
-- Recurring detection only sees what a bank or card feed shows, so a cost
-- paid by PayPal, crypto or an unlinked card (a server rented from a host
-- that bills PayPal) never appears in it. A declared cost is the owner
-- stating it instead. The first source is an OpenDevice inventory
-- (logicsrc.com/docs/opendevice), converted by @profullstack/fleet's
-- toCoinPayCosts(); `source` keeps sets from different tools apart, and each
-- source's set is replaced as a whole by PUT /api/finances/declared-costs.
--
-- The app merges these with the detected charges: a detected charge that
-- matches one (payee, amount within 10%, interval) is counted once, as
-- observed; an unmatched one is counted as declared.
--
-- RLS on with no policies, like every finance table: the app (service role)
-- is the only reader and writer. Additive only.

create table if not exists public.finance_declared_costs (
  id                  uuid primary key default gen_random_uuid(),
  merchant_id         uuid not null references public.merchants(id) on delete cascade,
  source              text not null check (source ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  key                 text not null check (char_length(key) between 1 and 120),
  payee               text not null check (char_length(payee) between 1 and 80),
  amount              numeric(20,2) not null check (amount > 0),
  currency            text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  cadence             text not null check (cadence in ('monthly', 'yearly')),
  monthly_equivalent  numeric(20,2) not null check (monthly_equivalent >= 0),
  scope               text not null default 'business' check (scope in ('business', 'personal')),
  category            text,
  paid_with           text,
  next_expected       timestamptz,
  meta                jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (merchant_id, source, key)
);

create index if not exists finance_declared_costs_merchant_idx
  on public.finance_declared_costs (merchant_id);

comment on table public.finance_declared_costs is
  'Owner-declared recurring costs (e.g. from an OpenDevice inventory) merged into recurring detection. Service role only.';

alter table public.finance_declared_costs enable row level security;
revoke all on table public.finance_declared_costs from public, anon, authenticated;
grant select, insert, update, delete on table public.finance_declared_costs to service_role;

-- Replace one source's set for one merchant in a single transaction: rows
-- whose key is not in p_rows are deleted, the rest upserted.
create or replace function public.finance_replace_declared_costs(
  p_merchant_id uuid,
  p_source text,
  p_rows jsonb
) returns table (removed integer, upserted integer)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_removed integer;
  v_upserted integer;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'p_rows must be a json array';
  end if;

  delete from public.finance_declared_costs d
   where d.merchant_id = p_merchant_id
     and d.source = p_source
     and not exists (
       select 1 from jsonb_array_elements(p_rows) r where r->>'key' = d.key
     );
  get diagnostics v_removed = row_count;

  insert into public.finance_declared_costs as d (
    merchant_id, source, key, payee, amount, currency, cadence,
    monthly_equivalent, scope, category, paid_with, next_expected, meta, updated_at
  )
  select p_merchant_id, p_source, r->>'key', r->>'payee', (r->>'amount')::numeric,
         coalesce(r->>'currency', 'USD'), r->>'cadence', (r->>'monthly_equivalent')::numeric,
         coalesce(r->>'scope', 'business'), r->>'category', r->>'paid_with',
         nullif(r->>'next_expected', '')::timestamptz, coalesce(r->'meta', '{}'::jsonb), now()
    from jsonb_array_elements(p_rows) r
  on conflict (merchant_id, source, key) do update set
    payee = excluded.payee,
    amount = excluded.amount,
    currency = excluded.currency,
    cadence = excluded.cadence,
    monthly_equivalent = excluded.monthly_equivalent,
    scope = excluded.scope,
    category = excluded.category,
    paid_with = excluded.paid_with,
    next_expected = excluded.next_expected,
    meta = excluded.meta,
    updated_at = now();
  get diagnostics v_upserted = row_count;

  return query select v_removed, v_upserted;
end;
$$;

revoke all on function public.finance_replace_declared_costs(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.finance_replace_declared_costs(uuid, text, jsonb) to service_role;
