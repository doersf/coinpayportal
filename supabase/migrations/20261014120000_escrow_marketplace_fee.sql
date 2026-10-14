-- Marketplace fee on escrow.
--
-- A marketplace that creates escrows for its users (ugig.net "Buy now") takes a
-- cut of each release. Until now the only split at settlement was CoinPay's own
-- commission, so the marketplace had to custody the money itself to take a fee.
-- The fee is a percentage fixed at creation; its payee is resolved server-side
-- from the OWNING business's wallets, never taken from the request body.
-- Refunds never pay it.

alter table public.escrows
  add column if not exists marketplace_fee_percent numeric,
  add column if not exists marketplace_fee_amount numeric not null default 0,
  add column if not exists marketplace_fee_address text,
  add column if not exists marketplace_fee_tx_hash text;

alter table public.escrows
  drop constraint if exists escrows_marketplace_fee_range;
alter table public.escrows
  add constraint escrows_marketplace_fee_range check (
    marketplace_fee_amount >= 0
    and (marketplace_fee_percent is null or (marketplace_fee_percent > 0 and marketplace_fee_percent <= 20))
    and (marketplace_fee_amount = 0 or marketplace_fee_address is not null)
  );

-- Settlement logs an unpaid marketplace fee as its own event, so the debt is
-- visible instead of silently lost (the platform fee already does this).
alter table public.escrow_events drop constraint if exists escrow_events_event_type_check;
alter table public.escrow_events
  add constraint escrow_events_event_type_check check (event_type = any (array[
    'created', 'pending', 'funded', 'released', 'settled', 'disputed',
    'dispute_resolved', 'refunded', 'expired', 'metadata_updated',
    'multisig_created', 'proposal_created', 'signature_added', 'tx_broadcast',
    'fee_forward_failed', 'marketplace_fee_forward_failed'
  ])) not valid;
