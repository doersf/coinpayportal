import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWallets, mockTronEnabled } = vi.hoisted(() => ({
  mockWallets: vi.fn(),
  mockTronEnabled: vi.fn(),
}));

vi.mock('@/lib/wallets/supported-coins', () => ({
  getSupportedWalletsForBusiness: mockWallets,
  getPaymentReceivingWallet: vi.fn(),
}));
vi.mock('@/lib/wallets/system-wallet', () => ({ isUsdtTronEnabled: mockTronEnabled }));
vi.mock('@/lib/payments/service', () => ({ createPayment: vi.fn() }));
vi.mock('@/lib/entitlements/middleware', () => ({ withTransactionLimit: vi.fn() }));
vi.mock('@/lib/entitlements/service', () => ({ consumeTransactionQuota: vi.fn(), releaseTransactionQuota: vi.fn() }));
vi.mock('@/lib/paypal/create-payment', () => ({ createPaypalPaymentForBusiness: vi.fn() }));

import {
  validateCreateSessionInput,
  parseAllowedMethods,
  sessionReturnUrl,
  resolvedSuccessUrl,
  eligibleMethods,
  generateSessionId,
  isSessionId,
  paymentMetadataFor,
  paymentWindowFor,
  CHECKOUT_COINS,
  type CheckoutSessionRow,
} from './sessions';
import { customerMetadata, webhookCustomerFields } from './customer';

const base = {
  amount: 9.99,
  customer_email: 'Buyer@Example.com',
  account_id: 'user_123',
  property: 'https://smshub.dev/numbers',
};

describe('validateCreateSessionInput', () => {
  it('accepts a minimal body and normalizes fields', () => {
    const r = validateCreateSessionInput(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      amount: 9.99,
      currency: 'USD',
      customer_email: 'buyer@example.com',
      account_id: 'user_123',
      property: 'smshub.dev',
      expires_in_minutes: 60,
      allowed_methods: null,
    });
  });

  it('rejects a missing customer_email with a clear 400 code', () => {
    const r = validateCreateSessionInput({ ...base, customer_email: undefined });
    expect(r).toMatchObject({ ok: false, code: 'MISSING_CUSTOMER_EMAIL' });
    if (!r.ok) expect(r.error).toMatch(/customer_email is required/);
  });

  it('rejects a missing account_id', () => {
    expect(validateCreateSessionInput({ ...base, account_id: '' })).toMatchObject({ ok: false, code: 'MISSING_ACCOUNT_ID' });
  });

  it('rejects a malformed email', () => {
    expect(validateCreateSessionInput({ ...base, customer_email: 'nope' })).toMatchObject({ ok: false, code: 'INVALID_CUSTOMER_EMAIL' });
  });

  it('defaults property from the business name', () => {
    const r = validateCreateSessionInput({ ...base, property: undefined }, { businessName: 'smshub.dev' });
    expect(r.ok && r.value.property).toBe('smshub.dev');
  });

  it('refuses non-USD and bad amounts', () => {
    expect(validateCreateSessionInput({ ...base, currency: 'EUR' })).toMatchObject({ ok: false, code: 'INVALID_CURRENCY' });
    expect(validateCreateSessionInput({ ...base, amount: 0 })).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    expect(validateCreateSessionInput({ ...base, amount: 2_000_000 })).toMatchObject({ ok: false, code: 'AMOUNT_TOO_LARGE' });
  });

  it('clamps expires_in_minutes into 15..120', () => {
    const lo = validateCreateSessionInput({ ...base, expires_in_minutes: 5 });
    const hi = validateCreateSessionInput({ ...base, expires_in_minutes: 500 });
    expect(lo.ok && lo.value.expires_in_minutes).toBe(15);
    expect(hi.ok && hi.value.expires_in_minutes).toBe(120);
    expect(validateCreateSessionInput({ ...base, expires_in_minutes: 'x' })).toMatchObject({ ok: false });
  });

  it('refuses unsafe return urls and non-object metadata', () => {
    expect(validateCreateSessionInput({ ...base, success_url: 'javascript:alert(1)' })).toMatchObject({ ok: false, code: 'INVALID_SUCCESS_URL' });
    expect(validateCreateSessionInput({ ...base, cancel_url: '/relative' })).toMatchObject({ ok: false, code: 'INVALID_CANCEL_URL' });
    expect(validateCreateSessionInput({ ...base, metadata: [1] })).toMatchObject({ ok: false, code: 'INVALID_METADATA' });
  });
});

describe('parseAllowedMethods', () => {
  it('expands CRYPTO and accepts PAYPAL', () => {
    const r = parseAllowedMethods(['crypto', 'paypal']);
    expect(r.ok && r.methods?.length).toBe(CHECKOUT_COINS.length + 1);
  });
  it('rejects card and unknown codes', () => {
    expect(parseAllowedMethods(['card']).ok).toBe(false);
    expect(parseAllowedMethods(['STRIPE']).ok).toBe(false);
  });
});

describe('return urls', () => {
  it('fills the session id and leaves the payment id for the pay page', () => {
    expect(sessionReturnUrl('https://e.com/t?s={CHECKOUT_SESSION_ID}&p={PAYMENT_ID}', 'cs_abc')).toBe(
      'https://e.com/t?s=cs_abc&p={PAYMENT_ID}'
    );
  });
  it('resolves both placeholders once paid, encoded or not', () => {
    expect(
      resolvedSuccessUrl({ id: 'cs_abc', success_url: 'https://e.com/%7BCHECKOUT_SESSION_ID%7D?p={PAYMENT_ID}', paid_reference: 'pay-1' })
    ).toBe('https://e.com/cs_abc?p=pay-1');
  });
});

describe('session ids', () => {
  it('generates unguessable ids that match the DB check', () => {
    const id = generateSessionId();
    expect(isSessionId(id)).toBe(true);
    expect(id).toMatch(/^cs_[A-Za-z0-9]{24}$/);
    expect(generateSessionId()).not.toBe(id);
  });
});

function supabaseWithPaypal(connected: boolean) {
  return {
    from: (table: string) => {
      if (table !== 'paypal_accounts') throw new Error(`unexpected ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: connected ? { connected: true } : null }) }) }) };
    },
  } as any;
}

describe('eligibleMethods', () => {
  beforeEach(() => {
    mockTronEnabled.mockReturnValue(false);
    mockWallets.mockResolvedValue({
      wallets: ['BTC', 'ETH', 'USDC_POL', 'USDT_TRON', 'USDC', 'USDC_ETH', 'SOL'].map((c) => ({
        cryptocurrency: c,
        wallet_address: 'addr',
        is_active: true,
      })),
    });
  });

  it('offers only coins with a wallet, stablecoins first, plus PayPal when connected', async () => {
    const methods = await eligibleMethods(supabaseWithPaypal(true), { business_id: 'b', merchant_id: 'm', allowed_methods: null });
    expect(methods.map((m) => m.code)).toEqual(['USDC_POL', 'USDC_ETH', 'BTC', 'ETH', 'SOL', 'PAYPAL']);
  });

  it('hides USDT_TRON until enabled, and shows it once enabled', async () => {
    mockTronEnabled.mockReturnValue(true);
    const methods = await eligibleMethods(supabaseWithPaypal(false), { business_id: 'b', merchant_id: 'm', allowed_methods: null });
    expect(methods.map((m) => m.code)).toContain('USDT_TRON');
    expect(methods.map((m) => m.code)).not.toContain('PAYPAL');
  });

  it('respects allowed_methods', async () => {
    const methods = await eligibleMethods(supabaseWithPaypal(true), { business_id: 'b', merchant_id: 'm', allowed_methods: ['BTC'] });
    expect(methods.map((m) => m.code)).toEqual(['BTC']);
  });
});

describe('payment metadata', () => {
  const session = {
    id: 'cs_abcdefghijklmnopqrstuvwx',
    metadata: { plan: 'pro' },
    customer_email: 'b@e.com',
    account_id: 'u1',
    property: 'e.com',
    description: 'Pro',
    expires_at: new Date(Date.now() + 50 * 60_000).toISOString(),
  } as unknown as CheckoutSessionRow;

  it('copies who paid and which property onto the payment', () => {
    expect(paymentMetadataFor(session)).toEqual({
      plan: 'pro',
      checkout_session_id: session.id,
      customer_email: 'b@e.com',
      account_id: 'u1',
      property: 'e.com',
      description: 'Pro',
    });
  });

  it('gives the payment the rest of the session window, at least 15 minutes', () => {
    expect(paymentWindowFor(session)).toBe(50);
    expect(paymentWindowFor({ expires_at: new Date(Date.now() + 60_000).toISOString() })).toBe(15);
  });

  it('lifts the fields to the top of webhook data', () => {
    expect(webhookCustomerFields(paymentMetadataFor(session))).toEqual({
      checkout_session_id: session.id,
      customer_email: 'b@e.com',
      account_id: 'u1',
      property: 'e.com',
    });
    expect(webhookCustomerFields(undefined)).toEqual({});
  });
});

describe('customerMetadata (non-strict, for /api/payments/create)', () => {
  it('drops malformed values instead of failing a live integration', () => {
    expect(customerMetadata({ customer_email: 'not-an-email', account_id: 42 })).toEqual({
      ok: true,
      metadata: { account_id: '42' },
    });
  });
});
