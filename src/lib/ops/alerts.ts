/**
 * Operator alerts — email the people running CoinPay when something needs a
 * human (top up a float, look at a stuck payment).
 *
 * Every alert is throttled per key through the `ops_alerts` table, because the
 * conditions that raise them repeat on every monitor cycle: an empty relayer
 * fails every sweep every minute until somebody tops it up, and one email
 * about it is useful where a thousand are not. The table is shared by every
 * process, so the in-process monitor and the HTTP cron cannot both send.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email';

export const OPS_ALERT_FROM =
  process.env.OPS_ALERT_FROM_EMAIL || 'CoinPay Alerts <alerts@coinpayportal.com>';

/** Comma-separated override; defaults to the operator inbox. */
export function opsAlertRecipients(): string[] {
  const configured = (process.env.OPS_ALERT_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : ['anthony@profullstack.com'];
}

/**
 * Claim the right to act on `key` for the next `intervalMs`.
 *
 * Returns true for exactly one caller per interval: the first insert wins, and
 * after that an update conditioned on the previous stamp being older than the
 * interval. Losing either race returns false.
 */
export async function claimOpsSlot(
  supabase: SupabaseClient,
  key: string,
  intervalMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const stamp = now.toISOString();

  const { data: inserted, error: insertError } = await supabase
    .from('ops_alerts')
    .insert({ key, last_sent_at: stamp })
    .select('key');
  if (!insertError && inserted && inserted.length > 0) return true;

  const cutoff = new Date(now.getTime() - intervalMs).toISOString();
  const { data: updated, error: updateError } = await supabase
    .from('ops_alerts')
    .update({ last_sent_at: stamp })
    .eq('key', key)
    .lt('last_sent_at', cutoff)
    .select('key');
  if (updateError) throw updateError;
  return !!updated && updated.length > 0;
}

/** Send an operator alert unless one with the same key went out within `throttleMs`. */
export async function sendOpsAlert(
  supabase: SupabaseClient,
  params: { key: string; subject: string; html: string; throttleMs: number },
): Promise<boolean> {
  if (!(await claimOpsSlot(supabase, `alert:${params.key}`, params.throttleMs))) return false;

  for (const to of opsAlertRecipients()) {
    const result = await sendEmail({ to, from: OPS_ALERT_FROM, subject: params.subject, html: params.html });
    if (!result.success) console.error(`[OpsAlert] ${params.key} to ${to} failed:`, result.error);
  }
  return true;
}
