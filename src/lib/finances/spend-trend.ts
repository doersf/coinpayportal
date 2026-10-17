import {
  buildPosition,
  recurrenceKey,
  type PositionAccount,
  type PositionTransaction,
  type RecurrenceCadence,
  type RecurringCharge,
} from './position';
import { INTERNAL_CATEGORIES } from './report-summary';

/**
 * Spend & cuts: whether spending is going down, night by night.
 *
 * Three readings, all across every visible account in the primary currency:
 *
 *  - Spending over the last 30 days against the 30 before. "Spending" is
 *    debits net of card refunds, with transfers and card payments left out
 *    (category `transfer`/`payment`), so moving money between one's own
 *    accounts never reads as spending. Investment accounts are left out too.
 *  - The recurring run-rate: every bill and subscription normalised to a
 *    monthly cost (debt service is not a cut, so it is not in it), now and as
 *    of 30 days ago, from the same detector the dashboard uses.
 *  - What changed between those two snapshots: series that stopped (a
 *    cancelled subscription; its monthly cost is the saving), series that
 *    started, and series still listed whose charge did not arrive when due —
 *    the early sign of a cancellation, since the detector keeps a series for
 *    two intervals after its last sighting.
 *
 * Pure: the caller fetches ~210 days of rows once (`spend-trend-load.ts`), so
 * this is testable from fixtures.
 */

export interface SpendTrendCharge {
  key: string;
  payee: string;
  cadence: RecurrenceCadence;
  amount: number;
  monthly: number;
  lastSeen: string;
  nextExpected: string;
  accountName: string;
}

export interface SpendTrendVendor {
  name: string;
  spent: number;
  count: number;
}

export interface SpendTrend {
  currency: string | null;
  windowDays: number;
  /** Net spending in the last `windowDays`, stated positive. */
  spent: number;
  /** The same for the `windowDays` before that. */
  previous: number;
  /** spent / previous - 1, or null when there is nothing to compare against. */
  change: number | null;
  /** Monthly cost of recurring bills and subscriptions now, and a window ago. */
  runRate: number;
  runRateBefore: number;
  stopped: SpendTrendCharge[];
  started: SpendTrendCharge[];
  /** Listed now, but their charge is overdue past a grace period: likely cancelled. */
  missed: SpendTrendCharge[];
  topVendors: SpendTrendVendor[];
}

const DAY = 86_400_000;
export const RECURRING_LOOKBACK_DAYS = 180;
/** How late a charge may be, by cadence, before it counts as missed. */
const GRACE_DAYS: Record<RecurrenceCadence, number> = { weekly: 3, biweekly: 4, monthly: 7, quarterly: 15, annual: 30 };

const round2 = (n: number) => Math.round(n * 100) / 100;

function toCharge(c: RecurringCharge): SpendTrendCharge {
  return {
    key: c.key,
    payee: c.payee,
    cadence: c.cadence,
    amount: c.amount,
    monthly: c.monthlyEquivalent,
    lastSeen: c.lastSeen,
    nextExpected: c.nextExpected,
    accountName: c.accountName,
  };
}

function bills(
  accounts: PositionAccount[],
  transactions: PositionTransaction[],
  asOf: Date,
): RecurringCharge[] {
  const from = asOf.getTime() - RECURRING_LOOKBACK_DAYS * DAY;
  const rows = transactions.filter((tx) => {
    const t = Date.parse(tx.posted);
    return Number.isFinite(t) && t >= from && t <= asOf.getTime();
  });
  return buildPosition({ accounts, transactions: rows, lookbackDays: RECURRING_LOOKBACK_DAYS, now: asOf })
    .recurring.charges.filter((c) => !c.isDebtService);
}

export function buildSpendTrend({
  accounts,
  transactions,
  now = new Date(),
  windowDays = 30,
  vendorLimit = 6,
}: {
  accounts: PositionAccount[];
  transactions: PositionTransaction[];
  now?: Date;
  windowDays?: number;
  vendorLimit?: number;
}): SpendTrend {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const end = now.getTime();
  const start = end - windowDays * DAY;
  const before = start - windowDays * DAY;

  let spent = 0;
  let previous = 0;
  const vendors = new Map<string, SpendTrendVendor & { latest: number }>();

  for (const tx of transactions) {
    const account = byId.get(tx.account_id);
    if (!account || account.effective_kind === 'investment') continue;
    if (INTERNAL_CATEGORIES.has(String(tx.category ?? ''))) continue;
    const t = Date.parse(tx.posted);
    if (!Number.isFinite(t) || t >= end || t < before) continue;
    // A debit is spending; a credit on a card is a refund that undoes some.
    // A credit on a deposit account is income and is not part of spending.
    const amount = Number(tx.amount);
    let delta = 0;
    if (amount < 0) delta = -amount;
    else if (account.is_liability && amount > 0) delta = -amount;
    if (!delta) continue;
    if (t >= start) {
      spent += delta;
      if (delta > 0) {
        const key = recurrenceKey(tx) || 'unknown';
        const entry = vendors.get(key) ?? { name: '', spent: 0, count: 0, latest: 0 };
        entry.spent += delta;
        entry.count += 1;
        if (t >= entry.latest) { entry.latest = t; entry.name = (tx.payee || tx.description || key).slice(0, 40); }
        vendors.set(key, entry);
      }
    } else {
      previous += delta;
    }
  }

  const nowCharges = bills(accounts, transactions, now);
  const thenCharges = bills(accounts, transactions, new Date(start));
  const nowKeys = new Set(nowCharges.map((c) => c.key));
  const thenKeys = new Set(thenCharges.map((c) => c.key));

  const missed = nowCharges.filter((c) => {
    const due = Date.parse(c.nextExpected);
    return Number.isFinite(due) && end - due > GRACE_DAYS[c.cadence] * DAY;
  });

  return {
    currency: accounts[0]?.currency ?? null,
    windowDays,
    spent: round2(spent),
    previous: round2(previous),
    change: previous > 0 ? spent / previous - 1 : null,
    runRate: round2(nowCharges.reduce((sum, c) => sum + c.monthlyEquivalent, 0)),
    runRateBefore: round2(thenCharges.reduce((sum, c) => sum + c.monthlyEquivalent, 0)),
    stopped: thenCharges.filter((c) => !nowKeys.has(c.key)).map(toCharge),
    started: nowCharges.filter((c) => !thenKeys.has(c.key)).map(toCharge),
    missed: missed.map(toCharge),
    topVendors: [...vendors.values()]
      .sort((a, b) => b.spent - a.spent)
      .slice(0, vendorLimit)
      .map(({ name, spent: total, count }) => ({ name, spent: round2(total), count })),
  };
}
