/**
 * Escrow Service Types
 */

export type EscrowStatus =
  | 'pending'
  | 'funded'
  | 'released'
  | 'settled'
  | 'disputed'
  | 'refunded'
  | 'expired';

export type EscrowEventType =
  | 'pending'
  | 'funded'
  | 'released'
  | 'settled'
  | 'disputed'
  | 'dispute_resolved'
  | 'refunded'
  | 'expired'
  | 'metadata_updated'
  | 'fee_forward_failed'
  | 'marketplace_fee_forward_failed';

export type EscrowChain =
  | 'BTC' | 'BCH' | 'ETH' | 'POL' | 'SOL'
  | 'DOGE' | 'XRP' | 'ADA' | 'BNB'
  | 'USDT' | 'USDC'
  | 'USDC_ETH' | 'USDC_POL' | 'USDC_SOL';

export interface CreateEscrowInput {
  chain: EscrowChain;
  amount: number;                          // crypto amount
  depositor_address: string;               // where refunds go
  beneficiary_address: string;             // where releases go
  allow_auto_release?: boolean;            // auto-release at expiry instead of auto-refund
  arbiter_address?: string;                // optional dispute resolver
  metadata?: Record<string, unknown>;      // job details, milestones, etc.
  business_id?: string;                    // optional merchant association
  series_id?: string;                      // recurring series link
  expires_in_hours?: number;               // default 24h
  depositor_email?: string;                // optional email for expiry reminders
  beneficiary_email?: string;              // optional email for settlement notifications
  marketplace_fee_percent?: number;        // owning business's cut of a release, 0 < x <= 20
  marketplace_fee_address?: string;        // resolved server-side from the business's wallets; never from the body
}

export interface Escrow {
  id: string;
  depositor_address: string;
  beneficiary_address: string;
  arbiter_address: string | null;
  escrow_address_id: string | null;
  escrow_address: string;
  chain: EscrowChain;
  amount: number;
  amount_usd: number | null;
  fee_amount: number | null;
  deposited_amount: number | null;
  status: EscrowStatus;
  deposit_tx_hash: string | null;
  settlement_tx_hash: string | null;
  fee_tx_hash: string | null;
  marketplace_fee_percent?: number | null;
  marketplace_fee_amount?: number | null;
  marketplace_fee_address?: string | null;
  marketplace_fee_tx_hash?: string | null;
  metadata: Record<string, unknown>;
  dispute_reason: string | null;
  dispute_resolution: string | null;
  release_token: string;
  beneficiary_token: string;
  business_id: string | null;
  allow_auto_release?: boolean;
  created_at: string;
  funded_at: string | null;
  released_at: string | null;
  settled_at: string | null;
  disputed_at: string | null;
  refunded_at: string | null;
  expires_at: string;
  updated_at: string;
}

/** Public view — tokens are NOT exposed */
export interface EscrowPublic {
  id: string;
  depositor_address: string;
  beneficiary_address: string;
  arbiter_address: string | null;
  escrow_address: string;
  chain: EscrowChain;
  amount: number;
  amount_usd: number | null;
  fee_amount: number | null;
  deposited_amount: number | null;
  status: EscrowStatus;
  deposit_tx_hash: string | null;
  settlement_tx_hash: string | null;
  metadata: Record<string, unknown>;
  dispute_reason: string | null;
  dispute_resolution: string | null;
  allow_auto_release?: boolean;
  created_at: string;
  funded_at: string | null;
  released_at: string | null;
  settled_at: string | null;
  disputed_at: string | null;
  refunded_at: string | null;
  expires_at: string;
}

export interface EscrowEvent {
  id: string;
  escrow_id: string;
  event_type: EscrowEventType;
  actor: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

export interface CreateEscrowResult {
  success: boolean;
  escrow?: EscrowPublic & {
    release_token: string;
    beneficiary_token: string;
  };
  error?: string;
}

export interface EscrowActionResult {
  success: boolean;
  escrow?: EscrowPublic;
  error?: string;
}
