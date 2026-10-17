import 'server-only';
import { getSupabaseAdmin } from '../supabase/server';
import { isValidTimeZone } from './periods';
import { audit } from './audit';

/**
 * The daily summary, on by default for every merchant with a linked bank or
 * card, and off for good once its owner says so.
 *
 * - A merchant with at least one connection that is not disconnected, no
 *   daily summary schedule and no opt-out gets one: 07:00 every day in their
 *   finance timezone (America/Los_Angeles when none is saved), every account,
 *   to the merchant's own login address and nobody else. The worker backfills
 *   (`backfillDailySummaries`) and linking a connection subscribes at once
 *   (`ensureDefaultDailySummary`); both only ever insert, never overwrite.
 * - Turning it off (`coinpay finances daily off`, the DELETE route, the
 *   unsubscribe link) records `daily_summary_opted_out_at`; while that is set
 *   nothing automatic creates it again. Turning it back on clears it.
 * - If the preferences cannot be read, nothing is created: an opt-out we
 *   cannot see is still an opt-out.
 *
 * The email itself is scoped by the schedule's `merchant_id` alone
 * (`sendDailySummary` → `listAccounts(merchantId)`), so one merchant's
 * schedule can only ever describe that merchant's connections.
 */

export const DEFAULT_DAILY_TIMEZONE = 'America/Los_Angeles';
export const DEFAULT_DAILY_HOUR = 7;
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHUNK = 200;

export interface EmailPreferences {
  merchant_id: string;
  daily_spend_target: number | null;
  daily_summary_opted_out_at: string | null;
}

export interface DefaultScheduleRow {
  merchant_id: string;
  kind: 'daily_summary';
  weekdays: number[];
  hour: number;
  timezone: string;
  recipients: string[];
  scope: 'all';
  formats: string[];
  active: true;
  next_run_at: string;
}

/**
 * Which merchants get a default daily summary, and the row each gets. Pure.
 *
 * Every row's recipients are that merchant's own address, looked up by that
 * merchant's id; there is no input through which another address can enter.
 */
export function planDefaultSubscriptions({
  merchants,
  connected,
  subscribed,
  optedOut,
  timezones,
  nextRun,
}: {
  merchants: Array<{ id: string; email: string | null }>;
  /** Merchants with at least one connection that is not disconnected. */
  connected: ReadonlySet<string>;
  /** Merchants that already have a daily_summary row, active or not. */
  subscribed: ReadonlySet<string>;
  optedOut: ReadonlySet<string>;
  timezones: ReadonlyMap<string, string>;
  nextRun: (timezone: string) => Date;
}): DefaultScheduleRow[] {
  const rows: DefaultScheduleRow[] = [];
  const seen = new Set<string>();
  for (const m of merchants) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (!connected.has(m.id) || subscribed.has(m.id) || optedOut.has(m.id)) continue;
    const email = (m.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) continue;
    const saved = timezones.get(m.id);
    const timezone = saved && isValidTimeZone(saved) ? saved : DEFAULT_DAILY_TIMEZONE;
    rows.push({
      merchant_id: m.id,
      kind: 'daily_summary',
      weekdays: EVERY_DAY,
      hour: DEFAULT_DAILY_HOUR,
      timezone,
      recipients: [email],
      scope: 'all',
      formats: ['html'],
      active: true,
      next_run_at: nextRun(timezone).toISOString(),
    });
  }
  return rows;
}

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

export async function getEmailPreferences(merchantId: string): Promise<EmailPreferences | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('finance_email_preferences')
    .select('merchant_id, daily_spend_target, daily_summary_opted_out_at')
    .eq('merchant_id', merchantId)
    .maybeSingle();
  if (error) throw new Error(`Could not read email preferences: ${error.message}`);
  if (!data) return null;
  const row = data as { merchant_id: string; daily_spend_target: unknown; daily_summary_opted_out_at: string | null };
  const target = row.daily_spend_target === null || row.daily_spend_target === undefined ? null : Number(row.daily_spend_target);
  return { merchant_id: row.merchant_id, daily_spend_target: Number.isFinite(target) ? target : null, daily_summary_opted_out_at: row.daily_summary_opted_out_at };
}

async function savePreferences(merchantId: string, patch: Partial<Omit<EmailPreferences, 'merchant_id'>>): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('finance_email_preferences')
    .upsert({ merchant_id: merchantId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'merchant_id' });
  if (error) throw new Error(`Could not save email preferences: ${error.message}`);
}

/** Validate a $/day target: null clears it; otherwise 0 to 1,000,000, two decimals. */
export function parseSpendTarget(value: unknown): number | null {
  if (value === null || value === '' || value === 'off' || value === 'clear' || value === 'none') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/^\$/, ''));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000) throw new Error('target must be a daily amount from 0 to 1000000, or null to clear it');
  return Math.round(n * 100) / 100;
}

export async function setDailySpendTarget(merchantId: string, target: number | null): Promise<void> {
  await savePreferences(merchantId, { daily_spend_target: target });
  await audit(merchantId, 'daily_summary.target', 'merchant', merchantId, { target: target === null ? 'none' : String(target) });
}

export async function recordDailySummaryOptOut(merchantId: string, at: Date = new Date()): Promise<void> {
  await savePreferences(merchantId, { daily_summary_opted_out_at: at.toISOString() });
}

export async function clearDailySummaryOptOut(merchantId: string): Promise<void> {
  const prefs = await getEmailPreferences(merchantId);
  if (prefs?.daily_summary_opted_out_at) await savePreferences(merchantId, { daily_summary_opted_out_at: null });
}

/**
 * Subscribe every eligible merchant among `merchantIds` (all merchants with
 * a live connection when omitted). Idempotent: rows are inserted with
 * `on conflict do nothing`, so a second run, or a race with the owner
 * saving their own schedule, changes nothing.
 */
export async function backfillDailySummaries({ merchantIds, now = new Date() }: { merchantIds?: string[]; now?: Date } = {}): Promise<{ considered: number; created: number }> {
  const supabase = getSupabaseAdmin();
  const { nextRunAt } = await import('./schedules');

  let connQuery = supabase.from('finance_connections').select('merchant_id').neq('lifecycle_state', 'disconnected');
  if (merchantIds) connQuery = connQuery.in('merchant_id', merchantIds);
  const { data: conns, error: connError } = await connQuery.limit(10_000);
  if (connError) throw new Error(`Could not read connections: ${connError.message}`);
  const connected = new Set((conns ?? []).map((r) => r.merchant_id as string).filter(Boolean));
  if (merchantIds) for (const id of [...connected]) if (!merchantIds.includes(id)) connected.delete(id);
  const ids = [...connected];
  if (ids.length === 0) return { considered: 0, created: 0 };

  const merchants: Array<{ id: string; email: string | null }> = [];
  const subscribed = new Set<string>();
  const optedOut = new Set<string>();
  const timezones = new Map<string, string>();
  for (const part of chunks(ids)) {
    const [m, s, p, t] = await Promise.all([
      supabase.from('merchants').select('id, email').in('id', part),
      supabase.from('finance_email_schedules').select('merchant_id').eq('kind', 'daily_summary').in('merchant_id', part),
      supabase.from('finance_email_preferences').select('merchant_id, daily_summary_opted_out_at').in('merchant_id', part),
      supabase.from('finance_settings').select('merchant_id, timezone').in('merchant_id', part),
    ]);
    // Any failure stops the run before anything is written: above all the
    // opt-outs, which must be known before anyone is subscribed.
    for (const r of [m, s, p, t]) if (r.error) throw new Error(`Could not prepare the daily summary backfill: ${r.error.message}`);
    for (const row of m.data ?? []) merchants.push({ id: row.id as string, email: (row.email as string | null) ?? null });
    for (const row of s.data ?? []) subscribed.add(row.merchant_id as string);
    for (const row of p.data ?? []) if (row.daily_summary_opted_out_at) optedOut.add(row.merchant_id as string);
    for (const row of t.data ?? []) if (row.timezone) timezones.set(row.merchant_id as string, row.timezone as string);
  }

  const rows = planDefaultSubscriptions({ merchants, connected, subscribed, optedOut, timezones, nextRun: (tz) => nextRunAt(EVERY_DAY, DEFAULT_DAILY_HOUR, tz, now) });
  let created = 0;
  for (const part of chunks(rows)) {
    const { data, error } = await supabase
      .from('finance_email_schedules')
      .upsert(part, { onConflict: 'merchant_id,kind', ignoreDuplicates: true })
      .select('id, merchant_id');
    if (error) throw new Error(`Could not create daily summaries: ${error.message}`);
    for (const row of data ?? []) {
      created += 1;
      await audit(row.merchant_id as string, 'daily_summary.default_subscribe', 'schedule', row.id as string, { recipients: 1 });
    }
  }
  return { considered: ids.length, created };
}

/** Subscribe one merchant if eligible; called when a connection is linked. Never throws. */
export async function ensureDefaultDailySummary(merchantId: string): Promise<boolean> {
  try {
    const { created } = await backfillDailySummaries({ merchantIds: [merchantId] });
    return created > 0;
  } catch (error) {
    console.warn('[finances] default daily summary not created', error instanceof Error ? error.message : error);
    return false;
  }
}

let lastBackfillAt = 0;
const BACKFILL_EVERY_MS = 6 * 3_600_000;

/** The worker's periodic backfill, at most every six hours per process. */
export async function maybeBackfillDailySummaries(now: Date = new Date()): Promise<number> {
  if (process.env.FINANCES_DAILY_DEFAULT_SUBSCRIBE === 'false') return 0;
  if (now.getTime() - lastBackfillAt < BACKFILL_EVERY_MS) return 0;
  lastBackfillAt = now.getTime();
  const { created } = await backfillDailySummaries({ now });
  if (created > 0) console.log(`[finances] daily summary: subscribed ${created} merchant(s) by default`);
  return created;
}

/**
 * One recipient asked to stop. Removes that address from the schedule; when
 * it was the last one the schedule is deleted and the opt-out recorded, so it
 * is never re-created automatically. Idempotent: a second click is a no-op.
 */
export async function unsubscribeDailySummary(merchantId: string, email: string): Promise<'unsubscribed' | 'removed_recipient' | 'already'> {
  const { getSchedule } = await import('./schedules');
  const supabase = getSupabaseAdmin();
  const address = email.trim().toLowerCase();
  const schedule = await getSchedule(merchantId, 'daily_summary');
  const remaining = (schedule?.recipients ?? []).filter((r) => r.trim().toLowerCase() !== address);
  if (schedule && remaining.length > 0) {
    if (remaining.length === schedule.recipients.length) return 'already';
    const { error } = await supabase
      .from('finance_email_schedules')
      .update({ recipients: remaining, updated_at: new Date().toISOString() })
      .eq('id', schedule.id)
      .eq('merchant_id', merchantId);
    if (error) throw new Error(`Could not update the schedule: ${error.message}`);
    await audit(merchantId, 'daily_summary.unsubscribe', 'schedule', schedule.id, { removed: 1, remaining: remaining.length });
    return 'removed_recipient';
  }
  const prefs = await getEmailPreferences(merchantId);
  if (!schedule && prefs?.daily_summary_opted_out_at) return 'already';
  // Opt-out first: if the delete then fails, nothing re-creates it meanwhile.
  await recordDailySummaryOptOut(merchantId);
  if (schedule) {
    const { error } = await supabase.from('finance_email_schedules').delete().eq('id', schedule.id).eq('merchant_id', merchantId);
    if (error) throw new Error(`Could not delete the schedule: ${error.message}`);
  }
  await audit(merchantId, 'daily_summary.unsubscribe', 'schedule', schedule?.id ?? merchantId, { removed: schedule ? 1 : 0, remaining: 0 });
  return 'unsubscribed';
}
