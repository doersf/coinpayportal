import { describe, it, expect } from 'vitest';

import { buildDueSoon, cycleDueDates, daysBetween, graceDays, type ScheduledPaymentInput } from './due-soon';
import type { RecurringCharge } from './position';

// 2026-10-12 08:00 in Los Angeles.
const NOW = new Date('2026-10-12T15:00:00.000Z');
const TZ = 'America/Los_Angeles';

function charge(partial: Partial<RecurringCharge>): RecurringCharge {
  return {
    key: partial.key ?? `charge:${(partial.payee ?? 'Netflix').toLowerCase()}`,
    payee: partial.payee ?? 'Netflix',
    amount: partial.amount ?? 26.99,
    cadence: partial.cadence ?? 'monthly',
    occurrences: 4,
    lastSeen: partial.lastSeen ?? '2026-09-14T12:00:00.000Z',
    nextExpected: partial.nextExpected ?? '2026-10-14T12:00:00.000Z',
    monthlyEquivalent: partial.amount ?? 26.99,
    scope: partial.scope ?? 'personal',
    isDebtService: partial.isDebtService ?? false,
    accountId: partial.accountId ?? 'card',
    accountName: partial.accountName ?? 'Sapphire',
  };
}

function scheduled(partial: Partial<ScheduledPaymentInput>): ScheduledPaymentInput {
  return {
    accountId: 'jeep',
    accountName: 'Jeep loan',
    scope: 'personal',
    dueDay: partial.dueDay ?? 15,
    amount: 'amount' in partial ? (partial.amount ?? null) : 810.46,
    owed: 'owed' in partial ? (partial.owed ?? null) : 5625.55,
    payments: partial.payments ?? [],
  };
}

describe('date helpers', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-10-12', '2026-10-14')).toBe(2);
    expect(daysBetween('2026-10-12', '2026-10-09')).toBe(-3);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('gives a weekly charge a short grace and a monthly one a week', () => {
    expect(graceDays('weekly')).toBe(3);
    expect(graceDays('monthly')).toBe(7);
    expect(graceDays('annual')).toBe(7);
  });

  it('clamps a due day to the end of a short month', () => {
    expect(cycleDueDates('2027-02-10', 31)).toEqual({ due: '2027-02-28', previous: '2027-01-31' });
  });

  it('rolls to next month once the due day has passed', () => {
    expect(cycleDueDates('2026-10-16', 15)).toEqual({ due: '2026-11-15', previous: '2026-10-15' });
    expect(cycleDueDates('2026-10-15', 15)).toEqual({ due: '2026-10-15', previous: '2026-09-15' });
    expect(cycleDueDates('2026-12-20', 5)).toEqual({ due: '2027-01-05', previous: '2026-12-05' });
  });
});

describe('buildDueSoon — projected charges', () => {
  it('lists a charge due inside the horizon with its local date', () => {
    const d = buildDueSoon({ charges: [charge({})], now: NOW, timezone: TZ });
    expect(d.today).toBe('2026-10-12');
    expect(d.items).toHaveLength(1);
    expect(d.items[0]).toMatchObject({ payee: 'Netflix', dueOn: '2026-10-14', daysUntil: 2, status: 'soon', accountName: 'Sapphire' });
    expect(d.totals.due).toBe(26.99);
  });

  it('leaves out a charge beyond the horizon', () => {
    const d = buildDueSoon({ charges: [charge({ nextExpected: '2026-10-25T12:00:00.000Z' })], now: NOW, timezone: TZ });
    expect(d.items).toHaveLength(0);
    expect(buildDueSoon({ charges: [charge({ nextExpected: '2026-10-25T12:00:00.000Z' })], now: NOW, timezone: TZ, horizonDays: 14 }).items).toHaveLength(1);
  });

  it('uses the owner\'s day, not UTC, for today', () => {
    // 04:00 UTC on the 13th is still the evening of the 12th in Los Angeles.
    const d = buildDueSoon({ charges: [charge({ nextExpected: '2026-10-12T19:00:00.000Z' })], now: new Date('2026-10-13T04:00:00.000Z'), timezone: TZ });
    expect(d.today).toBe('2026-10-12');
    expect(d.items[0].status).toBe('today');
  });

  it('calls a recently passed projection overdue, and an old one missed', () => {
    const d = buildDueSoon({
      charges: [
        charge({ payee: 'Resend', amount: 20, nextExpected: '2026-10-09T12:00:00.000Z' }),
        charge({ payee: 'Anthropic', amount: 200, nextExpected: '2026-09-12T12:00:00.000Z', lastSeen: '2026-08-12T12:00:00.000Z' }),
      ],
      now: NOW,
      timezone: TZ,
      lastPosted: { card: '2026-10-11T12:00:00.000Z' },
    });
    expect(d.items.map((i) => [i.payee, i.status, i.daysUntil])).toEqual([['Resend', 'overdue', -3]]);
    expect(d.totals.overdue).toBe(20);
    expect(d.missed).toEqual([{ payee: 'Anthropic', amount: 200, expectedOn: '2026-09-12', lastSeen: '2026-08-12', accountName: 'Sapphire' }]);
  });

  it('does not call a charge late when its account has reported nothing since', () => {
    const d = buildDueSoon({
      charges: [
        charge({ payee: 'Apollo', amount: 59, nextExpected: '2026-10-10T12:00:00.000Z' }),
        charge({ payee: 'Anthropic', amount: 200, nextExpected: '2026-09-12T12:00:00.000Z' }),
      ],
      now: NOW,
      timezone: TZ,
      lastPosted: { card: '2026-10-06T12:00:00.000Z' },
    });
    // Apollo was due after the feed's last row: no evidence yet. Anthropic was
    // due long before it, and the feed moved on without it: missed.
    expect(d.items.map((i) => [i.payee, i.status])).toEqual([['Apollo', 'awaiting']]);
    expect(d.missed.map((m) => m.payee)).toEqual(['Anthropic']);
    expect(d.totals).toEqual({ due: 0, overdue: 0, unpriced: 0 });
  });

  it('treats an account with no rows at all as not reported yet', () => {
    const d = buildDueSoon({ charges: [charge({ nextExpected: '2026-10-10T12:00:00.000Z' })], now: NOW, timezone: TZ });
    expect(d.items[0].status).toBe('awaiting');
  });

  it('sorts overdue first, then soonest, then largest', () => {
    const d = buildDueSoon({
      charges: [
        charge({ payee: 'B', amount: 5, nextExpected: '2026-10-14T12:00:00.000Z' }),
        charge({ payee: 'A', amount: 50, nextExpected: '2026-10-14T12:00:00.000Z' }),
        charge({ payee: 'Late', amount: 1, nextExpected: '2026-10-10T12:00:00.000Z' }),
      ],
      now: NOW,
      timezone: TZ,
      lastPosted: { card: "2026-10-11T12:00:00.000Z" },
    });
    expect(d.items.map((i) => i.payee)).toEqual(['Late', 'A', 'B']);
  });
});

describe('buildDueSoon — scheduled payments', () => {
  it('lists a statement due day inside the horizon', () => {
    const d = buildDueSoon({ charges: [], scheduled: [scheduled({})], now: NOW, timezone: TZ });
    expect(d.items[0]).toMatchObject({ source: 'scheduled', payee: 'Jeep loan', dueOn: '2026-10-15', daysUntil: 3, amount: 810.46, isDebtService: true });
  });

  it('marks it paid when this cycle already has a payment covering it', () => {
    const d = buildDueSoon({
      charges: [],
      scheduled: [scheduled({ payments: [{ posted: '2026-10-01T12:00:00.000Z', amount: 810.46 }] })],
      now: NOW,
      timezone: TZ,
    });
    expect(d.items).toHaveLength(0);
    expect(d.paid[0]?.status).toBe('paid');
  });

  it('does not count last cycle\'s payment towards this one', () => {
    const d = buildDueSoon({
      charges: [],
      scheduled: [scheduled({ payments: [{ posted: '2026-09-14T12:00:00.000Z', amount: 810.46 }] })],
      now: NOW,
      timezone: TZ,
    });
    expect(d.items).toHaveLength(1);
  });

  it('shows the balance when no fixed amount is set, and does not sum it', () => {
    const d = buildDueSoon({ charges: [], scheduled: [scheduled({ amount: null, owed: 1201.46 })], now: NOW, timezone: TZ });
    expect(d.items[0]).toMatchObject({ amount: null, owed: 1201.46 });
    expect(d.totals).toEqual({ due: 0, overdue: 0, unpriced: 1 });
  });

  it('skips an account that owes nothing', () => {
    const d = buildDueSoon({ charges: [], scheduled: [scheduled({ amount: null, owed: 0 })], now: NOW, timezone: TZ });
    expect(d.items).toHaveLength(0);
  });

  it('ignores a junk due day', () => {
    const d = buildDueSoon({ charges: [], scheduled: [scheduled({ dueDay: 0 }), scheduled({ dueDay: 40 })], now: NOW, timezone: TZ });
    expect(d.items).toHaveLength(0);
  });
});
