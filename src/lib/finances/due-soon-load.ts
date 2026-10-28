import 'server-only';
import { getSupabaseAdmin } from '../supabase/server';
import { getSummary, listAccounts, type FinanceSummary } from './summary';
import { getFinanceSettings } from './settings';
import { buildDueSoon, type DueSoon, type ScheduledPaymentInput } from './due-soon';
import type { RecurringCharge } from './position';

export const MAX_HORIZON_DAYS = 60;

export interface DueSoonResult extends DueSoon {
  /** Every recurring charge detected, for the full list beside the due view. */
  recurring: {
    charges: RecurringCharge[];
    monthlyTotal: number;
    monthlyDebtService: number;
  };
  currency: string | null;
}

/**
 * Due-soon for one merchant across every visible account, business and
 * personal alike: a bill is due whichever set of books it lands in.
 */
export async function getDueSoon(
  merchantId: string,
  options: { horizonDays?: number; timezone?: string; now?: Date } = {},
): Promise<DueSoonResult> {
  return (await loadDueSoon(merchantId, options)).dueSoon;
}

/** The same, with the balance-sheet summary it was computed from. */
export async function loadDueSoon(
  merchantId: string,
  { horizonDays = 7, timezone, now = new Date() }: { horizonDays?: number; timezone?: string; now?: Date } = {},
): Promise<{ dueSoon: DueSoonResult; summary: FinanceSummary }> {
  const horizon = Math.min(Math.max(Number.isFinite(horizonDays) ? Math.floor(horizonDays) : 7, 0), MAX_HORIZON_DAYS);
  const tz = timezone ?? (await getFinanceSettings(merchantId))?.timezone ?? 'UTC';
  const summary = await getSummary(merchantId, { windowDays: 30 });
  const { position } = summary;

  // Accounts the owner gave a due day. Their payments in the last two
  // cycles are enough to tell whether this one is already covered.
  const accounts = (await listAccounts(merchantId)).filter((a) => a.payment_due_day);
  const scheduled: ScheduledPaymentInput[] = [];
  if (accounts.length > 0) {
    const supabase = getSupabaseAdmin();
    const since = new Date(now.getTime() - 70 * 86_400_000).toISOString();
    const { data, error } = await supabase
      .from('finance_transactions')
      .select('account_id, posted, amount')
      .in('account_id', accounts.map((a) => a.id))
      .gt('amount', 0)
      .gte('posted', since);
    if (error) throw new Error(`Could not load payments: ${error.message}`);
    for (const a of accounts) {
      const owed = a.balance === null ? null : a.is_liability ? -Number(a.balance) : null;
      scheduled.push({
        accountId: a.id,
        accountName: a.name,
        scope: a.effective_scope,
        dueDay: Number(a.payment_due_day),
        amount: a.payment_due_amount === null || a.payment_due_amount === undefined ? null : Number(a.payment_due_amount),
        owed,
        payments: (data ?? [])
          .filter((t) => t.account_id === a.id)
          .map((t) => ({ posted: t.posted as string, amount: Number(t.amount) })),
      });
    }
  }

  // The newest row each charged account has posted, so a projection the bank
  // simply has not reported yet is not called overdue.
  const lastPosted: Record<string, string> = {};
  const chargedIds = [...new Set(position.recurring.charges.map((c) => c.accountId).filter(Boolean))];
  if (chargedIds.length > 0) {
    const supabase = getSupabaseAdmin();
    await Promise.all(
      chargedIds.map(async (accountId) => {
        const { data } = await supabase
          .from('finance_transactions')
          .select('posted')
          .eq('account_id', accountId)
          .order('posted', { ascending: false })
          .limit(1);
        const newest = data?.[0]?.posted as string | undefined;
        if (newest) lastPosted[accountId] = newest;
      }),
    );
  }

  const due = buildDueSoon({ charges: position.recurring.charges, scheduled, now, timezone: tz, horizonDays: horizon, lastPosted });
  return { dueSoon: { ...due, recurring: position.recurring, currency: position.currency }, summary };
}
