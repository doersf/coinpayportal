import {
  buildPosition,
  recurrenceKey,
  type PositionAccount,
  type PositionTransaction,
  type RecurrenceCadence,
  type RecurringCharge,
} from './position';
import { feeKind, isCardPayoff, isInvestmentBuy, isLoanPayment, spendDelta, type FeeKind } from './spend-rules';

/**
 * Spend & cuts: whether spending is going down, night by night.
 *
 * Three readings, all across every visible account in the primary currency:
 *
 *  - Spending over the last 30 days against the 30 before, and per day.
 *    "Spending" is debits net of card refunds, with transfers, card payoffs,
 *    loan payments, investment buys and income left out (`spend-rules.ts`,
 *    which reads the payee as well as the category), so moving money between
 *    one's own accounts never reads as spending. Fees and interest count.
 *  - The recurring run-rate: every bill and subscription normalised to a
 *    monthly cost (debt service is not a cut, so it is not in it), now and as
 *    of 30 days ago, from the same detector the dashboard uses.
 *  - What changed between those two snapshots: series that stopped (a
 *    cancelled subscription; its monthly cost is the saving), series that
 *    started, and series still listed whose charge did not arrive when due —
 *    the early sign of a cancellation, since the detector keeps a series for
 *    two intervals after its last sighting.
 *
 *  - Top cuts: the biggest avoidable recurring charges, plus the fees and
 *    interest paid lately (returned-payment, overdraft, late, interest), each
 *    as a monthly cost. Debt service is never a cut; the interest on it is.
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

export interface SpendCut {
  /** `recurring` for a bill or subscription; otherwise the fee's kind. */
  kind: 'recurring' | FeeKind;
  payee: string;
  /** Its monthly cost: the recurring charge normalised, or fees averaged over `FEE_LOOKBACK_DAYS`. */
  monthly: number;
  accountName: string;
  /** Short context: cadence for a charge, count and last date for a fee. */
  note: string;
}

export interface SpendTrend {
  currency: string | null;
  windowDays: number;
  /** Net spending in the last `windowDays`, stated positive. */
  spent: number;
  /** `spent` per day of the window. */
  perDay: number;
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
  /** At most `MAX_CUTS`, largest monthly cost first. */
  cuts: SpendCut[];
}

const DAY = 86_400_000;
export const RECURRING_LOOKBACK_DAYS = 180;
/** How late a charge may be, by cadence, before it counts as missed. */
const GRACE_DAYS: Record<RecurrenceCadence, number> = { weekly: 3, biweekly: 4, monthly: 7, quarterly: 15, annual: 30 };

const round2 = (n: number) => Math.round(n * 100) / 100;
export const MAX_CUTS = 5;
/** Fees are lumpy, so they are averaged over a quarter rather than one window. */
export const FEE_LOOKBACK_DAYS = 90;
/** Fee lines guaranteed a place among the cuts, however small: they are the easiest money to stop losing. */
const FEE_SLOTS = 2;
const FEE_LABEL: Record<FeeKind, string> = {
  returned_payment: 'returned-payment fee',
  overdraft: 'overdraft fee',
  late: 'late fee',
  interest: 'interest',
  fee: 'fee',
};

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

  const fees = new Map<string, Omit<SpendCut, 'kind'> & { kind: FeeKind; latest: string; count: number; total: number }>();
  const feeStart = end - FEE_LOOKBACK_DAYS * DAY;

  for (const tx of transactions) {
    const account = byId.get(tx.account_id);
    if (!account || account.effective_kind === 'investment') continue;
    const t = Date.parse(tx.posted);
    if (!Number.isFinite(t) || t >= end) continue;
    const kind = t >= feeStart ? feeKind(tx) : null;
    if (kind) {
      const key = `${kind}:${recurrenceKey(tx) || 'unknown'}`;
      const entry = fees.get(key) ?? { kind, payee: '', monthly: 0, accountName: account.name, note: '', latest: '', count: 0, total: 0 };
      entry.total += -Number(tx.amount);
      entry.count += 1;
      if (tx.posted >= entry.latest) { entry.latest = tx.posted; entry.payee = (tx.payee || tx.description || FEE_LABEL[kind]).slice(0, 40); entry.accountName = account.name; }
      fees.set(key, entry);
    }
    if (t < before) continue;
    const delta = spendDelta(tx, account);
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

  const feeCuts: SpendCut[] = [...fees.values()].map((f) => ({
    kind: f.kind,
    payee: f.payee,
    monthly: round2((f.total * 30.44) / FEE_LOOKBACK_DAYS),
    accountName: f.accountName,
    note: `${FEE_LABEL[f.kind]} · ${f.count}× in ${FEE_LOOKBACK_DAYS} days, last ${f.latest.slice(0, 10)}`,
  }));

  return {
    currency: accounts[0]?.currency ?? null,
    windowDays,
    spent: round2(spent),
    perDay: round2(spent / windowDays),
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
    cuts: rankCuts(nowCharges, feeCuts, byId),
  };
}

/**
 * Whether a recurring series is something one could cancel. The detector
 * already sets debt service apart, but a card payoff drawn from checking on
 * a steady autopay, a loan instalment, a standing brokerage buy or a fee
 * series can still arrive here as a "charge"; none of them is a cut (fees are
 * listed on their own).
 */
function cancellable(c: RecurringCharge, byId: Map<string, PositionAccount>): boolean {
  const account = byId.get(c.accountId);
  if (!account) return false;
  const tx = { amount: -c.amount, payee: c.payee, description: null, category: null };
  if (isCardPayoff(tx, account) || isLoanPayment(tx) || isInvestmentBuy(tx, account) || feeKind(tx)) return false;
  return c.monthlyEquivalent > 0;
}

/**
 * Top cuts: fees first claim up to `FEE_SLOTS` places, because a $35
 * returned-payment fee is the cheapest money there is to stop losing and would
 * otherwise rank under every subscription; the largest cancellable recurring
 * charges fill the rest. Listed largest monthly cost first.
 */
export function rankCuts(charges: RecurringCharge[], feeCuts: SpendCut[], byId: Map<string, PositionAccount>): SpendCut[] {
  const fees = [...feeCuts].sort((a, b) => b.monthly - a.monthly).slice(0, FEE_SLOTS);
  const recurring: SpendCut[] = charges
    .filter((c) => cancellable(c, byId))
    .sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent)
    .slice(0, MAX_CUTS - fees.length)
    .map((c) => ({ kind: 'recurring', payee: c.payee, monthly: c.monthlyEquivalent, accountName: c.accountName, note: c.cadence }));
  // Fewer subscriptions than slots: more fee lines may fill them.
  const spare = MAX_CUTS - fees.length - recurring.length;
  const moreFees = spare > 0 ? [...feeCuts].sort((a, b) => b.monthly - a.monthly).slice(FEE_SLOTS, FEE_SLOTS + spare) : [];
  return [...fees, ...recurring, ...moreFees].sort((a, b) => b.monthly - a.monthly);
}
