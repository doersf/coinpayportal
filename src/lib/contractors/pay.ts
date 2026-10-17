import type { SupabaseClient } from '@supabase/supabase-js';
import { createPayout, resolveIndeterminatePayout } from '@/lib/payouts/service';
import { notifyPaid } from './notify';

/**
 * Paying a pay run, one contractor at a time.
 *
 * Two ways to pay an item:
 *  - wallet: CoinPay sends from the business's payout wallet (a business_wallets
 *    row holding an encrypted key) through the affiliate payout service, which
 *    converts USD at the live rate and records the transaction.
 *  - manual: the owner paid from their own wallet and records the tx hash.
 *
 * Every item is claimed by a conditional status update before anything is
 * sent, so two clicks (or two tabs) can never pay the same person twice. An
 * ambiguous broadcast is recorded as `indeterminate` and refused for retry
 * until a human has looked at the chain, exactly like the payout service.
 */

type Item = {
  id: string;
  pay_run_id: string;
  business_id: string;
  contractor_id: string;
  amount: string | number;
  status: string;
  invoice_number: string;
  affiliate_payout_id: string | null;
};

type Contractor = {
  id: string;
  name: string;
  email: string;
  payout_currency: string | null;
  payout_wallet: string | null;
  portal_token: string | null;
};

export type ItemOutcome = { item_id: string; contractor: string; status: string; tx_hash?: string | null; error?: string };

async function loadContractor(supabase: SupabaseClient, id: string): Promise<Contractor | null> {
  const { data } = await supabase
    .from('contractors')
    .select('id, name, email, payout_currency, payout_wallet, portal_token')
    .eq('id', id)
    .maybeSingle();
  return (data as Contractor) ?? null;
}

/** Recompute the run's status from its items after any change. */
export async function refreshRunStatus(supabase: SupabaseClient, runId: string) {
  const { data: items } = await supabase.from('pay_run_items').select('status').eq('pay_run_id', runId);
  const statuses = (items ?? []).map((i) => i.status as string);
  let status: string;
  if (statuses.length > 0 && statuses.every((s) => s === 'paid')) status = 'paid';
  else if (statuses.some((s) => s === 'processing')) status = 'processing';
  else if (statuses.some((s) => s !== 'pending')) status = 'partially_paid';
  else status = 'draft';
  await supabase
    .from('pay_runs')
    .update({ status, updated_at: new Date().toISOString(), ...(status === 'paid' ? { paid_at: new Date().toISOString() } : {}) })
    .eq('id', runId);
  return status;
}

async function settle(
  supabase: SupabaseClient,
  item: Item,
  contractor: Contractor,
  txHash: string | null,
  method: 'wallet' | 'manual',
  payoutId: string | null,
  paidBy: string
) {
  const { data: ok, error } = await supabase.rpc('contractor_settle_item', {
    p_item: item.id,
    p_tx_hash: txHash,
    p_method: method,
    p_payout_id: payoutId,
    p_paid_by: paidBy,
  });
  if (error) throw new Error(`settle failed: ${error.message}`);
  if (ok) {
    await notifyPaid(
      supabase,
      { ...item, tx_hash: txHash, payout_currency: contractor.payout_currency },
      contractor
    );
  }
  return Boolean(ok);
}

/** Send every payable item of a run from the business wallet. */
export async function payRunFromWallet(
  supabase: SupabaseClient,
  runId: string,
  paidBy: string,
  onlyItemIds?: string[]
): Promise<ItemOutcome[]> {
  let query = supabase.from('pay_run_items').select('*').eq('pay_run_id', runId).in('status', ['pending', 'failed']);
  if (onlyItemIds?.length) query = query.in('id', onlyItemIds);
  const { data: items } = await query;
  const outcomes: ItemOutcome[] = [];

  for (const item of (items ?? []) as Item[]) {
    const contractor = await loadContractor(supabase, item.contractor_id);
    if (!contractor?.payout_wallet || !contractor.payout_currency) {
      await supabase.from('pay_run_items').update({ error: 'No payout wallet on file yet' }).eq('id', item.id);
      outcomes.push({ item_id: item.id, contractor: contractor?.name ?? item.contractor_id, status: item.status, error: 'No payout wallet on file yet' });
      continue;
    }

    // Claim it. Only the request that flips pending/failed → processing sends.
    const { data: claimed } = await supabase
      .from('pay_run_items')
      .update({
        status: 'processing',
        method: 'wallet',
        payout_currency: contractor.payout_currency,
        payout_wallet: contractor.payout_wallet,
        error: null,
      })
      .eq('id', item.id)
      .in('status', ['pending', 'failed'])
      .select('id');
    if (!claimed?.length) continue;
    await supabase.from('pay_runs').update({ status: 'processing' }).eq('id', runId);

    const result = await createPayout(supabase, item.business_id, {
      recipient_email: contractor.email,
      recipient_wallet: contractor.payout_wallet,
      cryptocurrency: contractor.payout_currency,
      amount_usd: Number(item.amount),
      metadata: { source: 'contractor_pay_run', pay_run_id: runId, pay_run_item_id: item.id, invoice_number: item.invoice_number },
    });

    if (result.success && result.payout?.tx_hash) {
      await settle(supabase, item, contractor, result.payout.tx_hash, 'wallet', result.payout.id, paidBy);
      outcomes.push({ item_id: item.id, contractor: contractor.name, status: 'paid', tx_hash: result.payout.tx_hash });
      continue;
    }

    const status = (result.payout?.status as string) === 'indeterminate' ? 'indeterminate' : 'failed';
    await supabase
      .from('pay_run_items')
      .update({ status, error: result.error ?? 'Payout failed', affiliate_payout_id: result.payout?.id ?? null })
      .eq('id', item.id);
    outcomes.push({ item_id: item.id, contractor: contractor.name, status, error: result.error });
  }

  await refreshRunStatus(supabase, runId);
  return outcomes;
}

/**
 * Record that the owner paid an item from their own wallet. Also the way out of
 * `indeterminate`: the owner checked the chain and the transfer landed.
 */
export async function recordManualPayment(
  supabase: SupabaseClient,
  item: Item,
  txHash: string,
  paidBy: string
): Promise<ItemOutcome> {
  const contractor = await loadContractor(supabase, item.contractor_id);
  if (!contractor) return { item_id: item.id, contractor: item.contractor_id, status: item.status, error: 'Contractor not found' };

  const from = item.status === 'indeterminate' ? ['indeterminate'] : ['pending', 'failed'];
  const { data: claimed } = await supabase
    .from('pay_run_items')
    .update({
      status: 'processing',
      payout_currency: contractor.payout_currency,
      payout_wallet: contractor.payout_wallet,
    })
    .eq('id', item.id)
    .in('status', from)
    .select('id');
  if (!claimed?.length) {
    return { item_id: item.id, contractor: contractor.name, status: item.status, error: 'This item was already paid or is being paid' };
  }

  if (item.status === 'indeterminate' && item.affiliate_payout_id) {
    await resolveIndeterminatePayout(supabase, item.business_id, item.affiliate_payout_id, 'completed', txHash);
  }
  await settle(supabase, item, contractor, txHash, item.status === 'indeterminate' ? 'wallet' : 'manual', item.affiliate_payout_id, paidBy);
  await refreshRunStatus(supabase, item.pay_run_id);
  return { item_id: item.id, contractor: contractor.name, status: 'paid', tx_hash: txHash };
}

/** The owner checked the chain and an indeterminate send did NOT land: make it retryable. */
export async function markIndeterminateFailed(supabase: SupabaseClient, item: Item): Promise<ItemOutcome> {
  if (item.status !== 'indeterminate') {
    return { item_id: item.id, contractor: item.contractor_id, status: item.status, error: 'Only an indeterminate item can be marked failed' };
  }
  if (item.affiliate_payout_id) {
    await resolveIndeterminatePayout(supabase, item.business_id, item.affiliate_payout_id, 'failed');
  }
  await supabase
    .from('pay_run_items')
    .update({ status: 'failed', error: 'Confirmed not on-chain; safe to retry' })
    .eq('id', item.id)
    .eq('status', 'indeterminate');
  await refreshRunStatus(supabase, item.pay_run_id);
  return { item_id: item.id, contractor: item.contractor_id, status: 'failed' };
}
