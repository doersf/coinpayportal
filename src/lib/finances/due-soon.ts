import { addDays, localDate } from './periods';
import type { AccountScope, RecurrenceCadence, RecurringCharge } from './position';

/**
 * What is about to leave, across every linked account.
 *
 * Two sources, because the feed only knows one of them:
 *
 * - **Projected** charges come from recurring detection (`position.ts`): a
 *   subscription seen three times on a steady cadence is expected again one
 *   interval after the last sighting. That is a guess with a known shape —
 *   banks post a day or three late — so a projection that has just passed is
 *   `overdue` for half an interval (at most a week) and only after that is it
 *   `missed`: most likely cancelled or moved to another card, and worth a
 *   line of its own rather than a red flag every morning.
 * - **Scheduled** payments are a card or loan's statement due day, which no
 *   feed carries (SimpleFIN has no such field and Plaid liabilities was never
 *   linked), so the owner states it once per account. A payment that already
 *   landed on that account this cycle and covers the amount marks it `paid`.
 *
 * Dates are calendar days in the owner's finance timezone; "today" is never
 * the server's UTC day.
 */

/**
 * `awaiting`: the projected date has passed but the account's feed has not
 * posted anything since, so there is no evidence either way yet. It is not
 * counted as overdue; banks and the bridge routinely run days behind.
 */
export type DueStatus = 'overdue' | 'awaiting' | 'today' | 'soon' | 'paid';

export interface DueItem {
  source: 'projected' | 'scheduled';
  payee: string;
  /** Positive amount expected to leave, or null for "the statement balance". */
  amount: number | null;
  /** The balance owed, for a scheduled payment with no fixed amount. */
  owed: number | null;
  cadence: RecurrenceCadence | 'monthly';
  /** Local calendar date it is due, `YYYY-MM-DD`. */
  dueOn: string;
  /** Days from today; negative when overdue. */
  daysUntil: number;
  status: DueStatus;
  accountId: string;
  accountName: string;
  scope: AccountScope;
  isDebtService: boolean;
}

export interface ScheduledPaymentInput {
  accountId: string;
  accountName: string;
  scope: AccountScope;
  /** 1-31; a day past the end of a short month means its last day. */
  dueDay: number;
  /** Fixed amount (a loan instalment or the minimum), or null to show the balance. */
  amount: number | null;
  /** Positive amount owed on the account now. */
  owed: number | null;
  /** Payments landing on the account, positive, with their posted timestamps. */
  payments: Array<{ posted: string; amount: number }>;
}

export interface DueSoon {
  timezone: string;
  today: string;
  horizonDays: number;
  /** Overdue, due today and due within the horizon, soonest first. */
  items: DueItem[];
  /** Scheduled payments already covered this cycle, for reassurance. */
  paid: DueItem[];
  /** Projections more than the grace period late on a feed that has moved on: probably stopped. */
  missed: Array<{ payee: string; amount: number; expectedOn: string; lastSeen: string; accountName: string }>;
  totals: {
    /** Sum of known amounts due today through the horizon, overdue included. */
    due: number;
    overdue: number;
    /** Items whose amount is the statement balance, counted but not summed. */
    unpriced: number;
  };
}

const CADENCE_DAYS: Record<RecurrenceCadence, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30.44,
  quarterly: 91.3,
  annual: 365.25,
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Whole calendar days from `a` to `b`, both `YYYY-MM-DD`. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** How late a projection may run before it stops being "overdue". */
export function graceDays(cadence: RecurrenceCadence): number {
  return Math.min(7, Math.max(2, Math.floor(CADENCE_DAYS[cadence] / 2)));
}

/** `dueDay` of the month `YYYY-MM`, clamped to the month's length. */
function dayInMonth(year: number, month: number, dueDay: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(1, Math.floor(dueDay)), last);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The due date a statement cycle is working towards on `today`: this month's
 * due day if it has not passed, otherwise next month's. Also returns the
 * previous due date, which is where the current cycle's payments start.
 */
export function cycleDueDates(today: string, dueDay: number): { due: string; previous: string } {
  const [y, m] = today.split('-').map(Number);
  const thisMonth = dayInMonth(y, m, dueDay);
  const prevMonth = m === 1 ? dayInMonth(y - 1, 12, dueDay) : dayInMonth(y, m - 1, dueDay);
  const nextMonth = m === 12 ? dayInMonth(y + 1, 1, dueDay) : dayInMonth(y, m + 1, dueDay);
  return thisMonth >= today ? { due: thisMonth, previous: prevMonth } : { due: nextMonth, previous: thisMonth };
}

function statusFor(daysUntil: number): DueStatus {
  if (daysUntil < 0) return 'overdue';
  if (daysUntil === 0) return 'today';
  return 'soon';
}

/** Pure: every input is passed in, so the whole projection is testable. */
export function buildDueSoon({
  charges,
  scheduled = [],
  now = new Date(),
  timezone,
  horizonDays = 7,
  lastPosted = {},
}: {
  charges: RecurringCharge[];
  scheduled?: ScheduledPaymentInput[];
  now?: Date;
  timezone: string;
  horizonDays?: number;
  /** Newest posted timestamp per account id, to tell "late" from "not reported yet". */
  lastPosted?: Record<string, string>;
}): DueSoon {
  const today = localDate(now, timezone);
  const items: DueItem[] = [];
  const paid: DueItem[] = [];
  const missed: DueSoon['missed'] = [];

  for (const c of charges) {
    const dueOn = localDate(new Date(c.nextExpected), timezone);
    const daysUntil = daysBetween(today, dueOn);
    if (daysUntil > horizonDays) continue;
    // Has this account's feed reported anything dated after the due day? If
    // not, a missing charge is just one the bank has not sent yet.
    const newest = lastPosted[c.accountId];
    const feedCaughtUp = newest !== undefined && localDate(new Date(newest), timezone) > dueOn;
    if (daysUntil < 0 && !feedCaughtUp) {
      items.push({
        source: 'projected',
        payee: c.payee,
        amount: c.amount,
        owed: null,
        cadence: c.cadence,
        dueOn,
        daysUntil,
        status: 'awaiting',
        accountId: c.accountId,
        accountName: c.accountName,
        scope: c.scope,
        isDebtService: c.isDebtService,
      });
      continue;
    }
    if (daysUntil < -graceDays(c.cadence)) {
      missed.push({ payee: c.payee, amount: c.amount, expectedOn: dueOn, lastSeen: localDate(new Date(c.lastSeen), timezone), accountName: c.accountName });
      continue;
    }
    items.push({
      source: 'projected',
      payee: c.payee,
      amount: c.amount,
      owed: null,
      cadence: c.cadence,
      dueOn,
      daysUntil,
      status: statusFor(daysUntil),
      accountId: c.accountId,
      accountName: c.accountName,
      scope: c.scope,
      isDebtService: c.isDebtService,
    });
  }

  for (const s of scheduled) {
    if (!Number.isInteger(s.dueDay) || s.dueDay < 1 || s.dueDay > 31) continue;
    const { due, previous } = cycleDueDates(today, s.dueDay);
    const daysUntil = daysBetween(today, due);
    // Payments count towards this cycle from the day after the last due date.
    const cycleStart = addDays(previous, 1);
    const paidThisCycle = s.payments
      .filter((p) => p.amount > 0 && localDate(new Date(p.posted), timezone) >= cycleStart)
      .reduce((t, p) => t + p.amount, 0);
    const target = s.amount ?? s.owed ?? 0;
    const item: DueItem = {
      source: 'scheduled',
      payee: s.accountName,
      amount: s.amount,
      owed: s.owed,
      cadence: 'monthly',
      dueOn: due,
      daysUntil,
      status: statusFor(daysUntil),
      accountId: s.accountId,
      accountName: s.accountName,
      scope: s.scope,
      isDebtService: true,
    };
    // Nothing owed, or a payment this cycle that covers it: done.
    if ((s.owed !== null && s.owed <= 0) || (target > 0 && paidThisCycle >= target)) {
      if (daysUntil <= horizonDays) paid.push({ ...item, status: 'paid' });
      continue;
    }
    if (daysUntil > horizonDays) continue;
    items.push(item);
  }

  items.sort((a, b) => a.daysUntil - b.daysUntil || (b.amount ?? 0) - (a.amount ?? 0));
  missed.sort((a, b) => b.expectedOn.localeCompare(a.expectedOn));

  let due = 0;
  let overdue = 0;
  let unpriced = 0;
  for (const i of items) {
    // Awaiting items are listed, never totalled: they may already be paid.
    if (i.status === 'awaiting') continue;
    if (i.amount === null) {
      unpriced += 1;
      continue;
    }
    due += i.amount;
    if (i.status === 'overdue') overdue += i.amount;
  }

  return {
    timezone,
    today,
    horizonDays,
    items,
    paid,
    missed,
    totals: { due: round2(due), overdue: round2(overdue), unpriced },
  };
}
