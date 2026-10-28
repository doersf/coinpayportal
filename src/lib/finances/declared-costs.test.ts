import { describe, it, expect } from 'vitest';
import { toCoinPayCosts } from '@profullstack/fleet';

import { DeclaredCostError, mergeDeclaredCosts, normalizeDeclaredCosts, payeeKey, type DeclaredCost } from './declared-costs';
import { buildPosition, type PositionAccount, type PositionTransaction, type RecurringCharge } from './position';
import { buildDueSoon } from './due-soon';

const NOW = new Date('2026-10-28T15:00:00.000Z');

function charge(partial: Partial<RecurringCharge>): RecurringCharge {
  const payee = partial.payee ?? 'DigitalOcean';
  return {
    key: partial.key ?? `charge:${payeeKey(payee)}`,
    payee,
    amount: partial.amount ?? 369.96,
    cadence: partial.cadence ?? 'monthly',
    occurrences: 5,
    lastSeen: '2026-10-01T12:00:00.000Z',
    nextExpected: '2026-11-01T12:00:00.000Z',
    monthlyEquivalent: partial.monthlyEquivalent ?? partial.amount ?? 369.96,
    scope: 'business',
    isDebtService: partial.isDebtService ?? false,
    accountId: 'card',
    accountName: 'Card (1234)',
  };
}

function cost(partial: Partial<DeclaredCost>): DeclaredCost {
  return normalizeDeclaredCosts(
    [{ key: 'device:dev2', payee: 'DEDIROCK', amount: 149, currency: 'USD', cadence: 'monthly', ...partial }],
    'opendevice',
  )[0];
}

const INVENTORY = {
  opendevice: '0.1',
  devices: [
    { id: 'dev2', name: 'dev2', profile: 'server', provider: { name: 'DediRock' }, cost: { amount: 149, currency: 'USD', interval: 'month', payee: 'DEDIROCK', paid_with: 'paypal', scope: 'business' } },
    { id: 'vienna', name: 'vienna', profile: 'server', provider: { name: 'netcup' }, cost: { amount: 53, currency: 'USD', interval: 'month', payee: 'NETCUP' } },
    { id: 'dev3', name: 'dev3', profile: 'server', provider: { name: 'Servitro' }, cost: { amount: 388, currency: 'USD', interval: 'month', payee: 'SERVITRO', paid_with: 'card', next_due: '2026-11-01' } },
    { id: 'laptop', name: 'laptop', profile: 'desktop' },
  ],
};

describe('normalizeDeclaredCosts', () => {
  it('accepts toCoinPayCosts rows from an OpenDevice inventory', () => {
    const rows = normalizeDeclaredCosts(toCoinPayCosts(INVENTORY, { now: NOW }), 'opendevice');
    expect(rows.map((r) => [r.key, r.payee, r.monthlyEquivalent, r.cadence, r.scope])).toEqual([
      ['device:dev2', 'DEDIROCK', 149, 'monthly', 'business'],
      ['device:vienna', 'NETCUP', 53, 'monthly', 'business'],
      ['device:dev3', 'SERVITRO', 388, 'monthly', 'business'],
    ]);
    expect(rows[0].paidWith).toBe('paypal');
    expect((rows[0].meta.device as { provider: string }).provider).toBe('DediRock');
  });

  it('derives the monthly equivalent of a yearly cost', () => {
    expect(cost({ cadence: 'yearly', amount: 120, monthlyEquivalent: undefined }).monthlyEquivalent).toBe(10);
  });

  it('rejects bad rows by name', () => {
    expect(() => normalizeDeclaredCosts([{ key: 'a', payee: 'X', amount: -1, cadence: 'monthly' }], 'opendevice')).toThrow(DeclaredCostError);
    expect(() => normalizeDeclaredCosts([{ key: 'a', payee: 'X', amount: 1, cadence: 'weekly' }], 'opendevice')).toThrow(/cadence/);
    expect(() => normalizeDeclaredCosts([{ key: 'a', payee: 'X', amount: 1, cadence: 'monthly' }, { key: 'a', payee: 'Y', amount: 1, cadence: 'monthly' }], 'opendevice')).toThrow(/duplicate/);
    expect(() => normalizeDeclaredCosts([], 'Bad Source')).toThrow(/source/);
    expect(() => normalizeDeclaredCosts({}, 'opendevice')).toThrow(/array/);
  });
});

describe('mergeDeclaredCosts', () => {
  it('adds an unmatched declared cost as origin declared', () => {
    const { charges } = mergeDeclaredCosts([charge({})], [cost({})], { now: NOW, currency: 'USD' });
    expect(charges.map((c) => [c.payee, c.origin])).toEqual([
      ['DigitalOcean', 'observed'],
      ['DEDIROCK', 'declared'],
    ]);
    const declared = charges[1];
    expect(declared.key).toBe('declared:opendevice:device:dev2');
    expect(declared.occurrences).toBe(0);
    expect(declared.accountId).toBe('');
    expect(declared.nextExpected).toBe('');
  });

  it('counts a matched cost once, keeping the observed charge', () => {
    const observed = charge({ payee: 'DEDIROCK LLC', amount: 155 });
    const { charges } = mergeDeclaredCosts([observed], [cost({})], { now: NOW, currency: 'USD' });
    expect(charges).toHaveLength(1);
    expect(charges[0].origin).toBe('matched');
    expect(charges[0].amount).toBe(155);
    expect(charges[0].declared?.key).toBe('device:dev2');
  });

  it('matches on the provider name when the payee differs', () => {
    const { charges } = mergeDeclaredCosts([charge({ payee: 'PAYPAL *DEDIROCK', amount: 149 })], [cost({ payee: 'Rack 4' , device: { provider: 'DediRock' } } as Partial<DeclaredCost>)], { now: NOW });
    expect(charges.map((c) => c.origin)).toEqual(['matched']);
  });

  it('does not match past 10 percent, on another interval, or a debt payment', () => {
    const d = [cost({})];
    expect(mergeDeclaredCosts([charge({ payee: 'DEDIROCK', amount: 170 })], d).charges.map((c) => c.origin)).toEqual(['observed', 'declared']);
    expect(mergeDeclaredCosts([charge({ payee: 'DEDIROCK', amount: 149, cadence: 'annual' })], d).charges.map((c) => c.origin)).toEqual(['observed', 'declared']);
    expect(mergeDeclaredCosts([charge({ payee: 'DEDIROCK', amount: 149, isDebtService: true })], d).charges.map((c) => c.origin)).toEqual(['observed', 'declared']);
  });

  it('matches each observed charge at most once, closest amount first', () => {
    const { charges } = mergeDeclaredCosts(
      [charge({ payee: 'HETZNER', amount: 40 }), charge({ payee: 'HETZNER', key: 'charge:hetzner2', amount: 60 })],
      [cost({ key: 'a', payee: 'HETZNER', amount: 58 }), cost({ key: 'b', payee: 'HETZNER', amount: 41 })],
    );
    expect(charges.map((c) => [c.amount, c.origin, c.declared?.key])).toEqual([
      [60, 'matched', 'a'],
      [40, 'matched', 'b'],
    ]);
  });

  it('leaves out other currencies and reports them', () => {
    const { charges, skipped } = mergeDeclaredCosts([], [cost({ currency: 'EUR' })], { currency: 'USD' });
    expect(charges).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it('rolls a stated billing date forward to the next one', () => {
    const { charges } = mergeDeclaredCosts([], [cost({ nextExpected: '2026-08-01T00:00:00.000Z' })], { now: NOW });
    expect(charges[0].nextExpected).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('buildPosition with declared costs', () => {
  const accounts: PositionAccount[] = [
    { id: 'card', name: 'Business Card', org_name: 'Bank', currency: 'USD', balance: -100, effective_kind: 'credit', is_liability: true },
  ];
  const tx = (posted: string, amount: number, payee: string): PositionTransaction => ({ account_id: 'card', posted, amount, category: 'software', payee });
  const transactions = [
    tx('2026-07-28T12:00:00Z', -388, 'SERVITRO'),
    tx('2026-08-28T12:00:00Z', -388, 'SERVITRO'),
    tx('2026-09-28T12:00:00Z', -388, 'SERVITRO'),
    tx('2026-10-27T12:00:00Z', -388, 'SERVITRO'),
  ];

  it('adds declared costs to monthlyTotal once, matched ones not again', () => {
    const declared = normalizeDeclaredCosts(toCoinPayCosts(INVENTORY, { now: NOW }), 'opendevice');
    const observedOnly = buildPosition({ accounts, transactions, lookbackDays: 180, now: NOW });
    const withDeclared = buildPosition({ accounts, transactions, lookbackDays: 180, now: NOW, declared });
    expect(observedOnly.recurring.monthlyTotal).toBe(388);
    // dev3 (SERVITRO) is seen on the card: matched. dev2 + vienna are declared.
    expect(withDeclared.recurring.monthlyTotal).toBe(388 + 149 + 53);
    expect(withDeclared.recurring.monthlyDeclared).toBe(202);
    expect(withDeclared.recurring.charges.map((c) => [c.payee, c.origin])).toEqual([
      ['SERVITRO', 'matched'],
      ['DEDIROCK', 'declared'],
      ['NETCUP', 'declared'],
    ]);
  });

  it('due soon skips a declared cost with no date and lists one with a date', () => {
    const declared = [cost({}), cost({ key: 'device:x', payee: 'NETCUP', amount: 53, nextExpected: '2026-10-30T12:00:00.000Z' })];
    const p = buildPosition({ accounts: [], transactions: [], lookbackDays: 180, now: NOW, declared });
    const due = buildDueSoon({ charges: p.recurring.charges, now: NOW, timezone: 'UTC', horizonDays: 7 });
    expect(due.items.map((i) => [i.payee, i.dueOn, i.status])).toEqual([['NETCUP', '2026-10-30', 'soon']]);
  });
});
