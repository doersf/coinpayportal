import type { SupabaseClient } from '@supabase/supabase-js';
import { notifyPayRunDrafted } from './notify';

/**
 * Pay-run scheduler, run from the payment monitor.
 *
 * When a fixed contract reaches its pay date, draft a pay run for that business
 * (fixed fees plus any approved work) and email the owner. It never sends money:
 * paying is a deliberate owner action, because a scheduler that empties a wallet
 * on a wrong amount cannot take it back.
 *
 * At most once an hour, and never while a draft is already waiting, so an
 * owner who has not reviewed last week's run is not buried in new ones.
 */

const INTERVAL_MS = 60 * 60 * 1000;
let lastRun = 0;

export type PayRunSchedulerStats = { businesses: number; drafted: number; errors: number };

export async function runContractorPayRunScheduler(
  supabase: SupabaseClient,
  now: Date,
  force = false
): Promise<PayRunSchedulerStats> {
  const stats: PayRunSchedulerStats = { businesses: 0, drafted: 0, errors: 0 };
  if (!force && now.getTime() - lastRun < INTERVAL_MS) return stats;
  lastRun = now.getTime();

  const today = now.toISOString().slice(0, 10);
  const { data: due, error } = await supabase
    .from('contractor_contracts')
    .select('business_id')
    .eq('kind', 'fixed')
    .in('status', ['active', 'ended'])
    .lte('next_pay_date', today)
    .limit(1000);
  if (error) {
    // The table is missing until the migration is applied; stay quiet about it.
    if (!/does not exist|schema cache/i.test(error.message)) console.error('[contractors] scheduler:', error.message);
    return stats;
  }

  const businesses = [...new Set((due ?? []).map((r) => r.business_id as string))];
  stats.businesses = businesses.length;

  for (const businessId of businesses) {
    try {
      const { data: draft } = await supabase
        .from('pay_runs')
        .select('id')
        .eq('business_id', businessId)
        .eq('status', 'draft')
        .limit(1);
      if (draft?.length) continue;

      const { data: runId, error: buildErr } = await supabase.rpc('contractor_build_pay_run', {
        p_business: businessId,
        p_pay_date: today,
        p_created_by: null,
        p_auto: true,
      });
      if (buildErr) {
        if (!/nothing_to_pay/.test(buildErr.message)) throw new Error(buildErr.message);
        continue;
      }
      const { data: run } = await supabase.from('pay_runs').select('id, number, total').eq('id', runId).single();
      if (run) await notifyPayRunDrafted(supabase, businessId, run);
      stats.drafted++;
    } catch (err) {
      stats.errors++;
      console.error(`[contractors] scheduler failed for business ${businessId}:`, err);
    }
  }
  return stats;
}
