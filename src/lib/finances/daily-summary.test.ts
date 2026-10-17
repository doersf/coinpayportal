import { describe, it, expect } from 'vitest';

import { dailySummarySubject, renderDailySummaryHtml, whenLabel, type DailySummaryInput } from './daily-summary';
import { buildDueSoon } from './due-soon';
import type { RecurringCharge } from './position';
import type { SpendTrend } from './spend-trend';

const NOW = new Date('2026-10-12T15:00:00.000Z');

function charge(payee: string, amount: number, nextExpected: string): RecurringCharge {
  return {
    key: `charge:${payee.toLowerCase()}`,
    payee,
    amount,
    cadence: 'monthly',
    occurrences: 4,
    lastSeen: '2026-09-01T12:00:00.000Z',
    nextExpected,
    monthlyEquivalent: amount,
    scope: 'business',
    isDebtService: false,
    accountId: 'a',
    accountName: 'Amex <Graphite>',
  };
}

function input(): DailySummaryInput {
  return {
    due: buildDueSoon({
      charges: [charge('DigitalOcean', 369.96, '2026-10-12T12:00:00.000Z'), charge('Resend', 20, '2026-10-09T12:00:00.000Z'), charge('Spotify', 33.98, '2026-10-15T12:00:00.000Z')],
      now: NOW,
      timezone: 'America/Los_Angeles',
      lastPosted: { a: '2026-10-11T12:00:00.000Z' },
    }),
    activity: { count: 3, moneyIn: 100, moneyOut: 59, largest: [{ payee: 'Apollo Io', amount: 59, accountName: 'Chase', posted: '2026-10-11T12:00:00Z' }], since: '2026-10-11T14:00:00.000Z' },
    position: { currency: 'USD', assets: 10000, liabilities: 4000, net: 6000, recurringMonthly: 423.94, recurringCount: 3 },
    appUrl: 'https://coinpayportal.com/',
  };
}

describe('daily summary email', () => {
  it('adds Spend & cuts to the subject and the body when the trend is there', () => {
    const spend: SpendTrend = {
      currency: 'USD',
      windowDays: 30,
      spent: 312.99,
      previous: 474.98,
      change: 312.99 / 474.98 - 1,
      runRate: 74.98,
      runRateBefore: 294.98,
      stopped: [{ key: 'charge:equinox gym', payee: 'Equinox <Gym>', cadence: 'monthly', amount: 260, monthly: 260, lastSeen: '2026-08-10T12:00:00.000Z', nextExpected: '2026-09-09T12:00:00.000Z', accountName: 'Chase' }],
      started: [{ key: 'charge:linear app', payee: 'Linear App', cadence: 'monthly', amount: 40, monthly: 40, lastSeen: '2026-10-01T12:00:00.000Z', nextExpected: '2026-10-31T12:00:00.000Z', accountName: 'Amex' }],
      missed: [],
      topVendors: [{ name: 'Costco Wholesale', spent: 180, count: 1 }],
      perDay: 10.43,
      cuts: [],
    };
    const withSpend = { ...input(), spend };
    expect(dailySummarySubject(withSpend)).toBe('CoinPay daily summary 2026-10-12: 1 overdue, 1 due today, $423.94 due in 7 days, spent $312.99 in 30d (-34%)');
    const html = renderDailySummaryHtml(withSpend);
    expect(html).toContain('Spend &amp; cuts');
    expect(html).toContain('down 34%');
    expect(html).toContain('−$220.00/mo');
    expect(html).toContain('Stopped: saving $260.00/mo');
    expect(html).toContain('Equinox &lt;Gym&gt;');
    expect(html).not.toContain('Equinox <Gym>');
    expect(html).toContain('Started: adding $40.00/mo');
    expect(html).toContain('Costco Wholesale');
    // Without it the email is exactly what it was.
    expect(renderDailySummaryHtml(input())).not.toContain('Spend &amp; cuts');
  });

  it('leads the subject with what needs action', () => {
    expect(dailySummarySubject(input())).toBe('CoinPay daily summary 2026-10-12: 1 overdue, 1 due today, $423.94 due in 7 days');
  });

  it('labels days the way a person reads them', () => {
    expect(whenLabel({ daysUntil: 0, dueOn: '2026-10-12' })).toBe('Today');
    expect(whenLabel({ daysUntil: 1, dueOn: '2026-10-13' })).toBe('Tomorrow');
    expect(whenLabel({ daysUntil: -3, dueOn: '2026-10-09' })).toBe('3 days late');
    expect(whenLabel({ daysUntil: 3, dueOn: '2026-10-15' })).toBe('Thu, Oct 15');
  });

  it('renders overdue, due soon, activity and position, escaping names', () => {
    const html = renderDailySummaryHtml(input());
    expect(html).toContain('Overdue');
    expect(html).toContain('Resend');
    expect(html).toContain('DigitalOcean');
    expect(html).toContain('$369.96');
    expect(html).toContain('Amex &lt;Graphite&gt;');
    expect(html).not.toContain('Amex <Graphite>');
    expect(html).toContain('Apollo Io');
    expect(html).toContain('$6,000.00');
    expect(html).toContain('https://coinpayportal.com/finances');
  });

  it('says so when nothing is due', () => {
    const empty = { ...input(), due: buildDueSoon({ charges: [], now: NOW, timezone: 'UTC' }) };
    expect(renderDailySummaryHtml(empty)).toContain('Nothing due in the next 7 days.');
  });
});
