-- Which SYSTEM_MNEMONIC_* generation derived each deposit address.
--
-- Generation 1 leaked in the 2026-10-27 dev2 compromise; generation 2 went
-- live 2026-10-28. Rows keep their own encrypted signing key, so old-generation
-- addresses still settle after rotation; this column is how an operator finds
-- every address a holder of a retired seed can still sign for.
alter table public.payment_addresses
  add column if not exists key_generation smallint not null default 1;

create index if not exists idx_payment_addresses_key_generation
  on public.payment_addresses (key_generation);

comment on column public.payment_addresses.key_generation is
  'SYSTEM_MNEMONIC_* generation that derived this address (SYSTEM_KEY_GENERATION at mint time). 1 = retired, leaked 2026-10-27.';
