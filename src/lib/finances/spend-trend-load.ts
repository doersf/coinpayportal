import 'server-only';
import { getSupabaseAdmin } from '../supabase/server';
import type { PositionTransaction } from './position';
import { buildSpendTrend, RECURRING_LOOKBACK_DAYS, type SpendTrend } from './spend-trend';
import { aggregateAccounts, fetchAllRows, listAccounts } from './summary';

/**
 * Fetches what `buildSpendTrend` needs for one merchant: every visible account,
 * and the transactions of the primary currency back far enough to evaluate the
 * recurring detector both now and a window ago on a full lookback each
 * (180 + 30 days). One paged query; the pure builder does the rest.
 */
export async function loadSpendTrend(merchantId: string, { now = new Date(), windowDays = 30 }: { now?: Date; windowDays?: number } = {}): Promise<SpendTrend> {
  const accounts = await listAccounts(merchantId);
  const { primaryCurrency } = aggregateAccounts(accounts);
  const inCurrency = accounts.filter((a) => !primaryCurrency || (a.currency || 'USD') === primaryCurrency);
  const since = new Date(now.getTime() - (RECURRING_LOOKBACK_DAYS + windowDays + 1) * 86_400_000);
  const transactions: PositionTransaction[] = [];

  if (inCurrency.length > 0) {
    const supabase = getSupabaseAdmin();
    const rows = await fetchAllRows<PositionTransaction>(() =>
      supabase
        .from('finance_transactions')
        .select('account_id, posted, amount, category, payee, description')
        .in('account_id', inCurrency.map((a) => a.id))
        .gte('posted', since.toISOString())
        .order('posted', { ascending: false }) as never,
    );
    for (const row of rows) {
      const amount = Number(row.amount);
      if (Number.isFinite(amount)) transactions.push({ ...row, amount });
    }
  }

  return buildSpendTrend({ accounts: inCurrency, transactions, now, windowDays });
}
