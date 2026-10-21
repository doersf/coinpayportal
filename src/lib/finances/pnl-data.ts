import 'server-only';
import { getSupabaseAdmin } from '../supabase/server';
import { listAccounts } from './summary';
import { rowsForPeriod } from './books';
import { parseExactAmount } from './decimal';
import { buildPnl, type PnlAccount, type PnlReceipt, type PnlRow, type PnlScope, type PnlStatement } from './pnl';

/** Payments that reached the merchant; same set the activity summary counts. */
const SETTLED_PAYMENTS = ['confirmed', 'forwarded'];
const DAY = 86_400_000;

async function loadReceipts(merchantId: string, start: string, end: string): Promise<PnlReceipt[]> {
  const supabase = getSupabaseAdmin();
  const { data: biz, error: bizError } = await supabase.from('businesses').select('id, name').eq('merchant_id', merchantId).limit(500);
  if (bizError) throw new Error(`Could not read businesses: ${bizError.message}`);
  const names = new Map((biz ?? []).map((b) => [b.id as string, (b.name as string | null) ?? 'Business']));
  if (names.size === 0) return [];
  const { data, error } = await supabase
    .from('payments')
    .select('id, business_id, amount, currency, status, created_at')
    .in('business_id', [...names.keys()])
    .in('status', SETTLED_PAYMENTS)
    .gte('created_at', start)
    .lt('created_at', end)
    .order('created_at', { ascending: true })
    .limit(10_000);
  if (error) throw new Error(`Could not read CoinPay payments: ${error.message}`);
  const out: PnlReceipt[] = [];
  for (const p of data ?? []) {
    const amount = parseExactAmount(p.amount);
    if (!amount) continue;
    out.push({
      id: p.id as string,
      created: p.created_at as string,
      amount,
      currency: ((p.currency as string | null) ?? 'USD').toUpperCase(),
      business: names.get(p.business_id as string) ?? 'Business',
      status: p.status as string,
    });
  }
  return out;
}

/**
 * Load everything a P&L needs. Rows for BOTH scopes are loaded so a transfer
 * from personal checking into business checking pairs with its other half;
 * hidden accounts are included because a re-linked bank's old feed holds
 * history the new one does not.
 */
export async function loadPnl(
  merchantId: string,
  params: { scope: PnlScope; start: string; end: string; timezone: string; holder: string; newestFirst?: boolean },
): Promise<PnlStatement> {
  const [accountViews, bookRows, receipts] = await Promise.all([
    listAccounts(merchantId, { includeHidden: true }),
    // Bank rows carry a calendar day stored as a UTC instant; buildPnl keeps
    // the days inside the period, so read a day either side of it.
    rowsForPeriod(merchantId, new Date(Date.parse(params.start) - DAY).toISOString(), new Date(Date.parse(params.end) + DAY).toISOString(), 'all'),
    params.scope === 'business' ? loadReceipts(merchantId, params.start, params.end) : Promise.resolve([]),
  ]);
  const accounts: PnlAccount[] = accountViews.map((a) => ({
    id: a.id,
    name: a.name,
    orgName: a.org_name,
    kind: a.effective_kind,
    liability: a.is_liability,
    scope: a.effective_scope,
    hidden: a.is_hidden,
    currency: a.currency,
  }));
  const rows: PnlRow[] = bookRows
    .filter((r) => r.posted)
    .map((r) => ({
      id: r.id,
      accountId: r.account_id,
      posted: r.posted as string,
      amount: r.amount,
      description: r.description,
      payee: r.payee,
      category: r.category,
      taxCategory: r.tax_category,
      reviewed: Boolean(r.reviewed_at),
      scope: r.effective_scope,
    }));
  return buildPnl({ ...params, rows, accounts, receipts });
}
