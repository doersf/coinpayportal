import { describe, it, expect } from 'vitest';

import type { PositionAccount, PositionTransaction } from './position';
import { buildSpendTrend, MAX_CUTS } from './spend-trend';
import { spendTargetLine, suggestTarget, renderDailySummaryHtml } from './daily-summary';

/**
 * Spend per day and top cuts, on a feed shaped like a real one: card payoffs
 * that the categoriser did NOT file as payments, a brokerage buy from
 * checking, fees, interest and a car loan.
 */

const NOW = new Date('2026-10-17T12:00:00.000Z');

function account(id: string, name: string, kind: string, liability = false): PositionAccount {
  return { id, name, org_name: 'Bank', currency: 'USD', balance: 0, available_balance: null, effective_kind: kind as PositionAccount['effective_kind'], is_liability: liability, scope_override: null };
}

function tx(account_id: string, posted: string, amount: number, payee: string, category: string | null = null): PositionTransaction {
  return { account_id, posted: `${posted}T12:00:00.000Z`, amount, category, payee, description: null };
}

function monthly(account_id: string, payee: string, amount: number, day: number, months: number[]): PositionTransaction[] {
  return months.map((m) => tx(account_id, `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, -amount, payee));
}

const ACCOUNTS = [account('chk', 'Checking', 'checking'), account('amex', 'Amex', 'credit', true), account('cap1', 'Capital One', 'credit', true)];

const RECURRING = [
  ...monthly('amex', 'DIGITALOCEAN.COM', 369.96, 12, [4, 5, 6, 7, 8, 9, 10]),
  ...monthly('amex', 'NETFLIX.COM', 22.99, 12, [4, 5, 6, 7, 8, 9, 10]),
  ...monthly('cap1', 'SPOTIFY USA', 11.99, 3, [5, 6, 7, 8, 9, 10]),
  ...monthly('chk', 'COMCAST CABLE', 89, 8, [5, 6, 7, 8, 9, 10]),
  ...monthly('cap1', 'LINEAR APP', 40, 1, [6, 7, 8, 9, 10]),
  ...monthly('amex', 'GITHUB INC', 4, 2, [5, 6, 7, 8, 9, 10]),
  // Debt service and investing on a steady monthly schedule: never a cut.
  ...monthly('chk', 'TOYOTA FINANCIAL PMT', 410.22, 15, [4, 5, 6, 7, 8, 9, 10]),
  ...monthly('chk', 'ELECTRONIC WITHDRAWAL AMEX EPAYMENT', 500, 20, [4, 5, 6, 7, 8, 9]),
  ...monthly('chk', 'ROBINHOOD DEBITS', 250, 5, [4, 5, 6, 7, 8, 9, 10]),
];

const LAST_30 = [
  tx('chk', '2026-10-05', -180, 'Costco Wholesale', 'groceries'),
  tx('amex', '2026-10-08', -120, 'Delta Air Lines', 'travel'),
  // Payoffs the categoriser missed, from checking: none of this is spending.
  tx('chk', '2026-10-09', -1812.5, 'ELECTRONIC WITHDRAWAL AMEX EPAYMENT', 'cash'),
  tx('chk', '2026-10-10', -640, 'CAPITAL ONE', 'other'),
  tx('chk', '2026-10-10', -95, 'DISCOVER', null),
  tx('chk', '2026-10-11', -300, 'CHASE CR', 'other'),
  // ...and their other side, on the cards.
  tx('amex', '2026-10-09', 1812.5, 'AUTOPAY PAYMENT - THANK YOU', 'other'),
  tx('cap1', '2026-10-10', 640, 'CAPITAL ONE MOBILE PYMT', null),
  // Investing and income.
  tx('chk', '2026-10-12', -2000, 'COINBASE.COM', 'other'),
  tx('chk', '2026-10-01', 5000, 'PAYROLL', 'income'),
  // Fees and interest: spending, and cuts.
  tx('cap1', '2026-10-04', -35, 'RETURNED PAYMENT FEE', 'payment'),
  tx('chk', '2026-09-28', -34, 'OVERDRAFT ITEM FEE', 'fees'),
  tx('chk', '2026-08-28', -34, 'OVERDRAFT ITEM FEE', 'fees'),
  tx('amex', '2026-10-06', -88.12, 'INTEREST CHARGE ON PURCHASES', null),
];

const trend = buildSpendTrend({ accounts: ACCOUNTS, transactions: [...RECURRING, ...LAST_30], now: NOW });

describe('spend per day', () => {
  it('counts purchases, subscriptions, fees and interest, and leaves out card payoffs, loans, investments and income', () => {
    // In the 30 days to Oct 17: recurring that posted in the window...
    const recurringInWindow = 369.96 + 22.99 + 11.99 + 89 + 40 + 4; // DO, Netflix, Spotify (10-03), Comcast, Linear (10-01), GitHub
    // ...plus one-offs, the returned-payment fee, one overdraft fee and the interest.
    const expected = recurringInWindow + 180 + 120 + 35 + 34 + 88.12;
    expect(trend.spent).toBeCloseTo(expected, 2);
    expect(trend.perDay).toBeCloseTo(expected / 30, 2);
  });
});

describe('top cuts', () => {
  it('lists at most five, largest first, fees and interest guaranteed a place', () => {
    expect(trend.cuts.length).toBe(MAX_CUTS);
    const monthlies = trend.cuts.map((c) => c.monthly);
    expect([...monthlies].sort((a, b) => b - a)).toEqual(monthlies);
    // Interest and the overdraft fees are smaller than most subscriptions, yet listed.
    const kinds = trend.cuts.map((c) => c.kind);
    expect(kinds).toContain('interest');
    expect(kinds.filter((k) => k !== 'recurring').length).toBe(2);
    expect(trend.cuts[0].payee).toBe('DIGITALOCEAN.COM');
    expect(trend.cuts[0].monthly).toBeCloseTo(369.96, 2);
  });

  it('never suggests cancelling debt service, a card payoff or an investment', () => {
    const payees = trend.cuts.map((c) => c.payee.toUpperCase()).join(' | ');
    expect(payees).not.toMatch(/TOYOTA|EPAYMENT|ROBINHOOD|AUTOPAY|CAPITAL ONE MOBILE/);
  });

  it('averages a fee over the quarter, by kind', () => {
    const t = buildSpendTrend({ accounts: ACCOUNTS, transactions: LAST_30, now: NOW });
    const overdraft = t.cuts.find((c) => c.kind === 'overdraft');
    expect(overdraft?.monthly).toBeCloseTo((68 * 30.44) / 90, 2);
    expect(overdraft?.note).toMatch(/2× in 90 days/);
    // With few subscriptions, the spare places go to more fees.
    expect(t.cuts.map((c) => c.kind).sort()).toEqual(['interest', 'overdraft', 'returned_payment']);
  });
});

describe('the target line', () => {
  it('says over or under the target', () => {
    expect(spendTargetLine({ perDay: 123.45, windowDays: 30 }, 100, 'USD')).toBe("Spent $123.45/day over the last 30 days. Target $100.00/day. You're $23.45/day over.");
    expect(spendTargetLine({ perDay: 80, windowDays: 30 }, 100, 'USD')).toBe("Spent $80.00/day over the last 30 days. Target $100.00/day. You're $20.00/day under.");
  });

  it('suggests a target when none is set', () => {
    expect(suggestTarget(123.45)).toBe(110);
    expect(suggestTarget(20)).toBe(18);
    expect(suggestTarget(0)).toBeNull();
    expect(spendTargetLine({ perDay: 123.45, windowDays: 30 }, null, 'USD')).toBe('Spent $123.45/day over the last 30 days. No daily target set; try $110.00/day: coinpay finances daily --target 110');
  });

  it('puts the line and the cuts in the email', () => {
    const html = renderDailySummaryHtml({
      due: { today: '2026-10-17', timezone: 'America/Los_Angeles', horizonDays: 7, items: [], paid: [], missed: [], totals: { due: 0, overdue: 0, unpriced: 0 }, recurring: { charges: [], monthlyTotal: 0 } } as never,
      activity: { count: 0, moneyIn: 0, moneyOut: 0, largest: [], since: '2026-10-16T14:00:00.000Z' },
      position: { currency: 'USD', assets: 0, liabilities: 0, net: 0, recurringMonthly: 0, recurringCount: 0 },
      appUrl: 'https://coinpayportal.com',
      spend: trend,
      target: 100,
      unsubscribeUrl: 'https://coinpayportal.com/api/finances/unsubscribe?t=abc.def',
    });
    expect(html).toContain('Target $100.00/day');
    expect(html).toContain('Top cuts');
    expect(html).toContain('DIGITALOCEAN.COM');
    expect(html).toContain('href="https://coinpayportal.com/api/finances/unsubscribe?t=abc.def"');
  });
});
