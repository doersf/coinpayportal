/**
 * Business payout (sending) wallets.
 *
 * A business's receive wallets (business_wallets) are its own addresses and
 * carry no key, so they cannot sign a payout. A payout wallet is a hot wallet
 * CoinPay generates and keeps the encrypted key for; the merchant funds it and
 * /api/payouts/create sends from it. One EVM key covers every EVM coin.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;
import { ethers } from 'ethers';
import { encrypt } from '@/lib/crypto/encryption';
import { requireEncryptionKey } from '@/lib/crypto/require-key';

export type PayoutWalletFamily = 'evm';

/** ERC-20 payout coins: contract + decimals. */
export const EVM_PAYOUT_TOKENS: Record<string, { contract: string; decimals: number; native: string }> = {
  USDC_POL: { contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6, native: 'POL' },
  USDT_POL: { contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6, native: 'POL' },
  USDC_ETH: { contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, native: 'ETH' },
  USDT_ETH: { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, native: 'ETH' },
  USDC_BASE: { contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, native: 'ETH' },
};

const EVM_NATIVE = new Set(['ETH', 'POL', 'BNB']);

export function payoutFamilyFor(cryptocurrency: string): PayoutWalletFamily | null {
  const c = cryptocurrency.toUpperCase();
  return EVM_NATIVE.has(c) || c in EVM_PAYOUT_TOKENS ? 'evm' : null;
}

export interface PayoutWalletRow {
  id: string;
  business_id: string;
  family: PayoutWalletFamily;
  address: string;
  encrypted_private_key: string;
  created_at: string;
}

export async function getPayoutWallet(
  supabase: SupabaseClient,
  businessId: string,
  family: PayoutWalletFamily
): Promise<PayoutWalletRow | null> {
  const { data, error } = await supabase
    .from('business_payout_wallets')
    .select('id, business_id, family, address, encrypted_private_key, created_at')
    .eq('business_id', businessId)
    .eq('family', family)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

/**
 * Create the business's payout wallet, or return the existing one. Never
 * rotates a key: the old wallet may still hold funds.
 */
export async function ensurePayoutWallet(
  supabase: SupabaseClient,
  businessId: string,
  family: PayoutWalletFamily = 'evm',
  createdBy: string | null = null
): Promise<{ address: string; created: boolean }> {
  const existing = await getPayoutWallet(supabase, businessId, family);
  if (existing) return { address: existing.address, created: false };

  const wallet = ethers.Wallet.createRandom();
  const encrypted = encrypt(wallet.privateKey, requireEncryptionKey('payout'));
  const { error } = await supabase.from('business_payout_wallets').insert({
    business_id: businessId,
    family,
    address: wallet.address,
    encrypted_private_key: encrypted,
    created_by: createdBy,
  });
  if (error) {
    // Lost a race to a concurrent create: the winner's wallet stands.
    const raced = await getPayoutWallet(supabase, businessId, family);
    if (raced) return { address: raced.address, created: false };
    throw new Error(`Failed to create payout wallet: ${error.message}`);
  }
  return { address: wallet.address, created: true };
}
