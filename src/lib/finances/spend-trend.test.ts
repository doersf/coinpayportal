import { describe, it, expect } from 'vitest';

import type { PositionAccount, PositionTransaction } from './position';
import { buildSpendTrend } from './spend-trend';

const NOW = new Date('2026-10-17T12:00:00.000Z');

function account(partial: Partial<PositionAccount>): PositionAccount {
  return {
    id: partial.id ?? 'chk',
    name: partial.name ?? 'Checking',
    org_name: 'Test Bank',
    currency: 'USD',
    balance: 0,
    available_balance: null,
    effective_kind: partial.effective_kind ?? 'checking',
    is_liability: partial.is_liability ?? false,
    scope_override: null,
  };
}

function tx(account_id: string, posted: string, amount: number, payee: string, category: string | null = null): PositionTransaction {
  return { account_id, posted: `${posted}T12:00:00.000Z`, amount, category, payee, description: null };
}

/** A charge on the same day of each listed month of 2026 (1 = January). */
function monthly(account_id: string, payee: string, amount: number, day: number, months: number[]): PositionTransaction[] {
  return months.map((m) => tx(account_id, `2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`, -amount, payee));
}

const ACCOUNTS = [
  account({ id: 'chk' }),
  account({ id: 'card', name: 'Amex', effective_kind: 'credit', is_liability: true }),
  account({ id: 'brk', name: 'Brokerage', effective_kind: 'investment' }),
];

const TRANSACTIONS: PositionTransaction[] = [
  // Still running: in both snapshots, so neither stopped nor started.
  ...monthly('card', 'NETFLIX.COM', 22.99, 12, [4, 5, 6, 7, 8, 9, 10]),
  // Cancelled after August: listed a month ago, gone now.
  ...monthly('chk', 'Equinox Gym', 260, 10, [4, 5, 6, 7, 8]),
  // Started in August: three sightings now, only two a month ago.
  ...monthly('card', 'Linear App', 40, 1, [8, 9, 10]),
  // Due around October 3 and not seen since September 3: missed.
  ...monthly('card', 'Spotify USA', 11.99, 3, [4, 5, 6, 7, 8, 9]),
  // One-off spending in each window.
  tx('chk', '2026-10-05', -180, 'Costco Wholesale'),
  tx('card', '2026-10-08', -120, 'Delta Air Lines'),
  tx('card', '2026-10-09', 50, 'Delta Air Lines'), // a refund on the card
  tx('chk', '2026-09-02', -400, 'Costco Wholesale'),
  // None of these is spending.
  tx('chk', '2026-10-06', -1500, 'Transfer to Savings', 'transfer'),
  tx('chk', '2026-10-07', -900, 'AMEX EPAYMENT', 'payment'),
  tx('card', '2026-10-07', 900, 'Payment received', 'payment'),
  tx('brk', '2026-10-02', -1000, 'VTI purchase'),
  tx('chk', '2026-10-01', 5000, 'Payroll'),
];

describe('buildSpendTrend', () => {
  const trend = buildSpendTrend({ accounts: ACCOUNTS, transactions: TRANSACTIONS, now: NOW });

  it('nets refunds and leaves transfers, card payments, investments and income out of spending', () => {
    // Last 30 days (Sep 17 to Oct 17): Netflix 22.99 + Linear 40 + Costco 180 + Delta 120 - refund 50.
    expect(trend.spent).toBe(312.99);
    // Sep 17 back to Aug 18: Netflix 22.99 (Sep 12) + Linear 40 (Sep 1) + Spotify 11.99 (Sep 3) + Costco 400.
    expect(trend.previous).toBe(474.98);
    expect(trend.change).toBeCloseTo(312.99 / 474.98 - 1, 6);
  });

  it('diffs the recurring run-rate a month apart: what stopped, what started', () => {
    expect(trend.stopped.map((c) => c.payee)).toEqual(['Equinox Gym']);
    expect(trend.stopped[0]).toMatchObject({ monthly: 260, cadence: 'monthly', key: 'charge:equinox gym' });
    expect(trend.started.map((c) => c.payee)).toEqual(['Linear App']);
    expect(trend.runRateBefore).toBeCloseTo(260 + 22.99 + 11.99, 2);
    expect(trend.runRate).toBeCloseTo(22.99 + 40 + 11.99, 2);
  });

  it('flags a listed charge that did not arrive when due, before the detector drops it', () => {
    expect(trend.missed.map((c) => c.payee)).toEqual(['Spotify USA']);
    expect(trend.stopped.map((c) => c.payee)).not.toContain('Spotify USA');
  });

  it('ranks vendors by net-positive spending in the window, named by their latest payee', () => {
    expect(trend.topVendors[0]).toEqual({ name: 'Costco Wholesale', spent: 180, count: 1 });
    expect(trend.topVendors.map((v) => v.name)).toContain('Delta Air Lines');
    expect(trend.topVendors.map((v) => v.name)).not.toContain('Transfer to Savings');
    expect(trend.topVendors.map((v) => v.name)).not.toContain('VTI purchase');
  });

  it('has nothing to compare against on a new account', () => {
    const fresh = buildSpendTrend({ accounts: ACCOUNTS, transactions: [tx('chk', '2026-10-10', -10, 'Coffee')], now: NOW });
    expect(fresh).toMatchObject({ spent: 10, previous: 0, change: null, runRate: 0, stopped: [], started: [], missed: [] });
  });
});
