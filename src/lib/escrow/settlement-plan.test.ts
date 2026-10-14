import { describe, it, expect } from 'vitest';
import { planSettlement } from './settlement-plan';

const escrow = {
  amount: 1,
  deposited_amount: 1,
  fee_amount: 0.01,
  marketplace_fee_amount: 0.05,
  marketplace_fee_address: 'MarketplaceWallet',
  depositor_address: 'Depositor',
  beneficiary_address: 'Beneficiary',
};

describe('planSettlement', () => {
  it('pays beneficiary, platform fee and marketplace fee on release', () => {
    const plan = planSettlement(escrow, 'release', 'CommissionWallet');
    expect(plan.legs.map((l) => [l.kind, l.address])).toEqual([
      ['beneficiary', 'Beneficiary'],
      ['platform_fee', 'CommissionWallet'],
      ['marketplace_fee', 'MarketplaceWallet'],
    ]);
    expect(plan.primary.amount).toBeCloseTo(0.94);
    const total = plan.legs.reduce((sum, l) => sum + l.amount, 0);
    expect(total).toBeCloseTo(1);
  });

  it('refunds the full deposit and pays no fee', () => {
    const plan = planSettlement(escrow, 'refund', 'CommissionWallet');
    expect(plan.legs).toEqual([{ kind: 'refund', address: 'Depositor', amount: 1 }]);
  });

  it('leaves out the platform leg without a commission wallet but still withholds it', () => {
    const plan = planSettlement(escrow, 'release', null);
    expect(plan.legs.map((l) => l.kind)).toEqual(['beneficiary', 'marketplace_fee']);
    expect(plan.primary.amount).toBeCloseTo(0.94);
  });

  it('behaves as before for escrows with no marketplace fee', () => {
    const plan = planSettlement(
      { ...escrow, marketplace_fee_amount: 0, marketplace_fee_address: null },
      'release',
      'CommissionWallet',
    );
    expect(plan.legs.map((l) => l.kind)).toEqual(['beneficiary', 'platform_fee']);
    expect(plan.primary.amount).toBeCloseTo(0.99);
  });

  it('ignores a fee amount that has no payee', () => {
    const plan = planSettlement({ ...escrow, marketplace_fee_address: null }, 'release', 'CommissionWallet');
    expect(plan.legs.map((l) => l.kind)).toEqual(['beneficiary', 'platform_fee']);
    expect(plan.primary.amount).toBeCloseTo(0.99);
  });

  it('uses the escrow amount when nothing was recorded as deposited', () => {
    const plan = planSettlement({ ...escrow, deposited_amount: null }, 'release', 'CommissionWallet');
    expect(plan.primary.amount).toBeCloseTo(0.94);
  });

  it('throws when fees would consume the whole escrow', () => {
    expect(() =>
      planSettlement({ ...escrow, fee_amount: 0.5, marketplace_fee_amount: 0.5 }, 'release', 'CommissionWallet'),
    ).toThrow(/nothing for the beneficiary/);
  });
});
