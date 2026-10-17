import { describe, it, expect } from 'vitest';
import { feeKind, isCardPayoff, isInvestmentBuy, spendDelta } from './spend-rules';

const checking = { is_liability: false, effective_kind: 'checking' };
const card = { is_liability: true, effective_kind: 'credit_card' };
const brokerage = { is_liability: false, effective_kind: 'investment' };

describe('spend rules: what is not spending', () => {
  // Real payee shapes from the feed. None of them is categorised `payment`
  // reliably: the first reads as a cash withdrawal, the rest match no rule.
  const payoffs = [
    { payee: 'ELECTRONIC WITHDRAWAL AMEX EPAYMENT', category: 'cash' },
    { payee: 'CAPITAL ONE', category: 'other' },
    { payee: 'DISCOVER', category: null },
    { payee: 'CHASE CR CRD AUTOPAY', category: 'other' },
    { payee: 'CHASE CR', description: 'CHASE CREDIT CRD EPAY', category: 'shopping' },
    { payee: 'Online Payment Thank You', category: null },
  ];

  it.each(payoffs)('a card payoff from checking is not spending: $payee', (row) => {
    const tx = { amount: -812.5, ...row };
    expect(isCardPayoff(tx, checking)).toBe(true);
    expect(spendDelta(tx, checking)).toBe(0);
  });

  it('the payment landing on the card is not a refund either', () => {
    const tx = { amount: 812.5, payee: 'AUTOPAY PAYMENT - THANK YOU', category: 'other' };
    expect(isCardPayoff(tx, card)).toBe(true);
    expect(spendDelta(tx, card)).toBe(0);
  });

  it('an issuer name on a card purchase is still a purchase', () => {
    const tx = { amount: -320, payee: 'AMEX TRAVEL', category: 'travel' };
    expect(isCardPayoff(tx, card)).toBe(false);
    expect(spendDelta(tx, card)).toBe(320);
  });

  it('brokerage and exchange buys are not spending, and investment accounts never count', () => {
    for (const payee of ['ROBINHOOD DEBITS', 'Coinbase.com', 'VANGUARD BUY INVESTMENT', 'SCHWAB BROKERAGE MONEYLINK']) {
      const tx = { amount: -500, payee, category: 'other' };
      expect(isInvestmentBuy(tx, checking)).toBe(true);
      expect(spendDelta(tx, checking)).toBe(0);
    }
    expect(spendDelta({ amount: -500, payee: 'VTI', category: null }, brokerage)).toBe(0);
  });

  it('income and transfers are not spending; a card refund is negative spending', () => {
    expect(spendDelta({ amount: 4000, payee: 'PAYROLL', category: 'income' }, checking)).toBe(0);
    expect(spendDelta({ amount: -300, payee: 'Zelle to Mom', category: 'transfer' }, checking)).toBe(0);
    expect(spendDelta({ amount: 25, payee: 'Costco refund', category: 'shopping' }, card)).toBe(-25);
    expect(spendDelta({ amount: -60, payee: 'Costco', category: 'groceries' }, checking)).toBe(60);
  });

  it('a loan instalment is debt service, not spending', () => {
    expect(spendDelta({ amount: -410.22, payee: 'TOYOTA FINANCIAL PMT', category: 'other' }, checking)).toBe(0);
  });
});

describe('spend rules: fees and interest', () => {
  it('names each kind, and fees count as spending even when categorised as a payment', () => {
    expect(feeKind({ amount: -35, payee: 'RETURNED PAYMENT FEE', category: 'payment' })).toBe('returned_payment');
    expect(spendDelta({ amount: -35, payee: 'RETURNED PAYMENT FEE', category: 'payment' }, card)).toBe(35);
    expect(feeKind({ amount: -34, payee: 'OVERDRAFT ITEM FEE' })).toBe('overdraft');
    expect(feeKind({ amount: -34, payee: 'NSF CHARGE' })).toBe('returned_payment');
    expect(feeKind({ amount: -41, payee: 'LATE FEE' })).toBe('late');
    expect(feeKind({ amount: -88.12, payee: 'INTEREST CHARGE ON PURCHASES' })).toBe('interest');
    expect(feeKind({ amount: -95, payee: 'ANNUAL MEMBERSHIP FEE' })).toBe('fee');
  });

  it('a bare returned payment is the payment being undone, not a fee; a fee reversal is not a fee', () => {
    expect(feeKind({ amount: -812.5, payee: 'RETURNED PAYMENT', category: 'payment' })).toBeNull();
    expect(feeKind({ amount: 35, payee: 'RETURNED PAYMENT FEE REVERSAL' })).toBeNull();
    expect(feeKind({ amount: -6, payee: 'Blue Bottle Coffee' })).toBeNull();
  });
});
