-- Merchant webhooks move onto @profullstack/webhooks 0.2.1 (the "hub").
--
-- Purely additive: two new tables and one claim function. Nothing existing is
-- altered, renamed or dropped, so this is safe to apply before the code that
-- uses it is deployed (and the code falls back to the old direct sender if the
-- tables are missing).
--
-- * hub_webhook_deliveries is the durable outbox. Every business webhook
--   (payment.*, invoice.*, escrow.*, business_collection.*) is written here and
--   retried with backoff. The business's own webhook (businesses.webhook_url /
--   webhook_secret) is NOT copied anywhere: it is addressed as the virtual
--   endpoint id 'biz_<business id>' and read live from businesses on every
--   attempt, so the merchant's URL, secret and settings page stay the single
--   source of truth.
-- * hub_webhook_endpoints holds only the additional Standard Webhooks
--   endpoints a merchant creates through /api/v1/webhooks.
-- * webhook_logs stays the per-attempt log the dashboard reads; the app writes
--   one row per hub attempt, as before.
--
-- The schema is the package's own schemaSql('pg', 'hub_') (as in ugig.net), so
-- a later move to postgresStore needs no data change. The legacy
-- webhook_deliveries retry table is left in place and still drained by the cron
-- for anything queued before this change.
--
-- Only the server (service role) touches these tables: RLS on, no policies,
-- claim RPC granted to service_role alone. Idempotent: safe to re-run.

create table if not exists public.hub_webhook_endpoints (
  id text primary key,
  owner text not null,
  url text not null,
  secret text not null,
  events text not null default '["*"]',
  description text not null default '',
  enabled integer not null default 1,
  failures integer not null default 0,
  disabled_reason text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists hub_webhook_endpoints_owner on public.hub_webhook_endpoints(owner);

create table if not exists public.hub_webhook_deliveries (
  id text primary key,
  endpoint_id text not null,
  owner text not null,
  event_id text not null,
  event_type text not null,
  payload text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_at bigint not null,
  last_status integer,
  last_error text,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists hub_webhook_deliveries_due on public.hub_webhook_deliveries(status, next_at);
create index if not exists hub_webhook_deliveries_endpoint on public.hub_webhook_deliveries(endpoint_id, created_at);
create index if not exists hub_webhook_deliveries_owner on public.hub_webhook_deliveries(owner, created_at);

alter table public.hub_webhook_endpoints enable row level security;
alter table public.hub_webhook_deliveries enable row level security;
revoke all on public.hub_webhook_endpoints from anon, authenticated;
revoke all on public.hub_webhook_deliveries from anon, authenticated;
grant all on public.hub_webhook_endpoints to service_role;
grant all on public.hub_webhook_deliveries to service_role;

-- Take up to p_limit due deliveries and lease them until p_lease_until, so two
-- app processes never send the same row (the package's postgresStore claim,
-- as an RPC because PostgREST cannot express FOR UPDATE SKIP LOCKED).
create or replace function public.claim_hub_webhook_deliveries(p_now bigint, p_limit integer, p_lease_until bigint)
returns setof public.hub_webhook_deliveries
language sql
volatile
set search_path to 'public'
as $function$
  update public.hub_webhook_deliveries
     set next_at = p_lease_until
   where id in (
     select id from public.hub_webhook_deliveries
      where status = 'pending' and next_at <= p_now
      order by next_at
      limit p_limit
      for update skip locked
   )
  returning *;
$function$;
revoke execute on function public.claim_hub_webhook_deliveries(bigint, integer, bigint) from public, anon, authenticated;
grant execute on function public.claim_hub_webhook_deliveries(bigint, integer, bigint) to service_role;

notify pgrst, 'reload schema';
