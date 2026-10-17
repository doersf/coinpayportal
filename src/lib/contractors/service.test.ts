import { describe, it, expect, beforeAll } from 'vitest';
import {
  businessWorkItemSchema,
  contractSchema,
  hoursAmount,
  nextPayDate,
  openTaxId,
  payoutProfileSchema,
  sealTaxId,
  taxFormSchema,
} from './service';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '3f9c1e7a5b2d8c4e6f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e';
});

describe('nextPayDate (mirrors contractor_next_pay_date in SQL)', () => {
  // The first four match what the SQL function returned on Postgres 15.
  it.each([
    ['2026-10-03', 'semimonthly', '2026-10-15'],
    ['2026-10-15', 'semimonthly', '2026-10-31'],
    ['2026-10-31', 'semimonthly', '2026-11-15'],
    ['2026-02-20', 'semimonthly', '2026-02-28'],
    ['2026-01-31', 'monthly', '2026-02-28'],
    ['2026-10-08', 'weekly', '2026-10-15'],
    ['2026-12-25', 'biweekly', '2027-01-08'],
  ] as const)('%s %s -> %s', (d, f, want) => {
    expect(nextPayDate(d, f)).toBe(want);
  });
});

describe('hoursAmount', () => {
  it('bills exact cents with no float drift', () => {
    expect(hoursAmount(50, 90)).toBe(75);
    expect(hoursAmount('33.33', 20)).toBe(11.11);
    expect(hoursAmount(0.1, 600)).toBe(1);
  });
});

describe('contractSchema', () => {
  it('needs a rate and frequency for a fixed contract', () => {
    expect(contractSchema.safeParse({ title: 'x', kind: 'fixed', rate: 100 }).success).toBe(false);
    expect(contractSchema.safeParse({ title: 'x', kind: 'fixed', rate: 100, frequency: 'monthly' }).success).toBe(true);
  });
  it('needs milestones for a milestone contract', () => {
    expect(contractSchema.safeParse({ title: 'x', kind: 'milestone' }).success).toBe(false);
    expect(contractSchema.safeParse({ title: 'x', kind: 'milestone', milestones: [{ title: 'M1', amount: 500 }] }).success).toBe(true);
  });
  it('rejects sub-cent rates and an end before the start', () => {
    expect(contractSchema.safeParse({ title: 'x', kind: 'hourly', rate: 10.001 }).success).toBe(false);
    expect(contractSchema.safeParse({ title: 'x', kind: 'hourly', rate: 10, start_date: '2026-10-10', end_date: '2026-10-01' }).success).toBe(false);
  });
});

describe('businessWorkItemSchema', () => {
  it('only lets the business add bonuses and expenses', () => {
    const base = { contract_id: '6f1c2d3e-0000-4000-8000-000000000001', amount: 10, description: 'thanks' };
    expect(businessWorkItemSchema.safeParse({ ...base, kind: 'bonus' }).success).toBe(true);
    expect(businessWorkItemSchema.safeParse({ ...base, kind: 'hours' }).success).toBe(false);
    expect(businessWorkItemSchema.safeParse({ ...base, kind: 'bonus', receipt_url: 'javascript:alert(1)' }).success).toBe(false);
  });
});

describe('payoutProfileSchema', () => {
  it('checks the address format against the coin', () => {
    expect(payoutProfileSchema.safeParse({ payout_currency: 'USDC_POL', payout_wallet: '0x' + 'a'.repeat(40) }).success).toBe(true);
    expect(payoutProfileSchema.safeParse({ payout_currency: 'USDC_POL', payout_wallet: 'So1anaAddre55So1anaAddre55So1anaAddr' }).success).toBe(false);
    expect(payoutProfileSchema.safeParse({ payout_currency: 'DOGECOIN', payout_wallet: '0x' + 'a'.repeat(40) }).success).toBe(false);
  });
});

describe('taxFormSchema', () => {
  const w9 = {
    tax_form: 'W9',
    legal_name: 'Ada Lovelace',
    address: '1 Main St, Springfield, IL',
    country: 'US',
    tax_id: '123-45-6789',
    signature: 'ada lovelace',
    certify: true,
  };
  it('accepts a complete W-9', () => {
    expect(taxFormSchema.safeParse(w9).success).toBe(true);
  });
  it('requires a 9-digit TIN, a US address, a matching signature and the certification', () => {
    expect(taxFormSchema.safeParse({ ...w9, tax_id: '1234' }).success).toBe(false);
    expect(taxFormSchema.safeParse({ ...w9, country: 'GB' }).success).toBe(false);
    expect(taxFormSchema.safeParse({ ...w9, signature: 'Someone Else' }).success).toBe(false);
    expect(taxFormSchema.safeParse({ ...w9, certify: false }).success).toBe(false);
  });
  it('lets a W-8BEN omit the tax id', () => {
    const { tax_id: _t, ...rest } = w9;
    expect(taxFormSchema.safeParse({ ...rest, tax_form: 'W8BEN', country: 'DE' }).success).toBe(true);
  });
});

describe('sealTaxId', () => {
  it('stores only ciphertext and the last four', () => {
    const sealed = sealTaxId('123-45-6789');
    expect(sealed.tax_id_last4).toBe('6789');
    expect(sealed.tax_id_encrypted).not.toContain('123456789');
    expect(openTaxId(sealed.tax_id_encrypted)).toBe('123456789');
    expect(openTaxId(null)).toBeNull();
  });
});
