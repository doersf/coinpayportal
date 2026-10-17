/**
 * Apps signed in with CoinPay cannot move funds.
 *
 * A `merchant`-scope OAuth access token acts as the merchant on the onboarding
 * routes, but every funds-moving point refuses it with 403
 * `oauth_cannot_move_funds`: crypto payouts, bank transfers and linked bank
 * accounts, a custom payout address on a payment or an invoice, and business
 * API keys (which can send payouts). A dashboard session and a business API
 * key keep working exactly as before.
 *
 * Auth runs for real (middleware, merchant-guard, resolveMerchant, authz);
 * only the database and the money-moving services are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

const MERCHANT_ID = 'merchant-1';
const BUSINESS_ID = 'biz-1';
// A syntactically valid Polygon/EVM address made of a repeated nibble: no real wallet.
const PAYOUT_ADDRESS = '0x' + '1'.repeat(40);

// ── fake database ───────────────────────────────────────────────────────────

type Row = Record<string, unknown> | null;

const BUSINESS_ROW = {
  id: BUSINESS_ID,
  merchant_id: MERCHANT_ID,
  organization_id: null,
  name: 'Fixture Business',
  // Generated per run: nothing key-like lives in the source.
  api_key: randomUUID(),
};

const TABLES: Record<string, Row> = {
  merchants: { id: MERCHANT_ID, email: 'owner@example.test', is_admin: false },
  businesses: BUSINESS_ROW,
  business_members: null,
  organization_members: null,
};

function fakeSupabase() {
  return {
    from: (table: string) => {
      const row = Object.prototype.hasOwnProperty.call(TABLES, table) ? TABLES[table] : null;
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        single: async () => ({ data: row, error: row ? null : { message: 'not found' } }),
        maybeSingle: async () => ({ data: row, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: row ? [row] : [], error: null }),
      };
      return chain;
    },
  };
}

vi.mock('server-only', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => fakeSupabase()) }));
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: vi.fn(() => fakeSupabase()),
  supabaseAdmin: {},
}));

// Business API keys: one legacy all-scope key for BUSINESS_ID.
const API_KEY = 'cp_live_' + 'f'.repeat(32);
vi.mock('@/lib/auth/apikey', () => ({
  isApiKey: (t: string) => typeof t === 'string' && t.startsWith('cp_live_'),
  getBusinessByApiKey: vi.fn(async (_s: unknown, key: string) =>
    key === API_KEY
      ? { success: true, business: { id: BUSINESS_ID, merchant_id: MERCHANT_ID, name: 'Fixture Business' } }
      : { success: false, error: 'Invalid API key' },
  ),
}));
vi.mock('@/lib/auth/scoped-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/scoped-keys')>()),
  resolveScopedKey: vi.fn(async () => null),
}));

// ── money-moving services, faked ─────────────────────────────────────────────

vi.mock('@/lib/payouts/service', () => ({
  createPayout: vi.fn(async () => ({ success: true, payout: { id: 'payout-1' } })),
}));

vi.mock('@/lib/banking/providers', () => ({ bankTransfersEnabled: () => true }));
vi.mock('@/lib/banking/service', () => ({
  originateTransfer: vi.fn(async () => ({ id: 'transfer-1' })),
  publicTransfer: (row: unknown) => row,
  linkBankAccount: vi.fn(async () => ({ id: 'cp-1' })),
  publicCounterparty: (row: unknown) => row,
}));
vi.mock('@/lib/banking/http', async () => {
  const { NextResponse } = await import('next/server');
  return {
    bankingDeps: () => ({ store: { findTransferByIdempotencyKey: async () => null } }),
    bankingErrorResponse: () => NextResponse.json({ error: 'banking failed' }, { status: 500 }),
    resolveBusinessId: async (_m: string, b: unknown) => (typeof b === 'string' ? b : null),
    NO_STORE: {},
  };
});

vi.mock('@/lib/entitlements/middleware', () => ({
  withTransactionLimit: vi.fn(async () => ({ allowed: true, limit: null })),
  createEntitlementErrorResponse: vi.fn(),
}));
vi.mock('@/lib/entitlements/service', () => ({
  consumeTransactionQuota: vi.fn(async () => ({ allowed: true })),
  releaseTransactionQuota: vi.fn(async () => undefined),
  isBusinessPaidTier: vi.fn(async () => false),
}));
vi.mock('@/lib/wallets/supported-coins', () => ({
  verifyBusinessAccess: vi.fn(async () => ({ ok: true })),
  getPaymentReceivingWallet: vi.fn(async () => ({ walletAddress: '0x' + '2'.repeat(40), source: 'business' })),
}));
vi.mock('@/lib/payments/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/service')>()),
  // Stop just past every auth gate: reaching createPayment means the caller was allowed.
  createPayment: vi.fn(async () => ({ success: false, error: 'stopped after auth (fixture)' })),
}));
vi.mock('@/lib/payments/payee', () => ({
  // Same for invoices: reaching resolvePayee means the funds gate let it through.
  resolvePayee: vi.fn(async () => ({ ok: false, status: 418, error: 'stopped after auth (fixture)', code: 'FIXTURE_STOP' })),
}));

import * as payoutsCreate from './payouts/create/route';
import * as bankingTransfers from './banking/transfers/route';
import * as bankingAccounts from './banking/accounts/route';
import * as paymentsCreate from './payments/create/route';
import * as invoices from './invoices/route';
import * as businesses from './businesses/route';
import * as businessById from './businesses/[id]/route';
import * as merchantApiKey from './merchant/api-key/route';
import { createPayout } from '@/lib/payouts/service';
import { originateTransfer, linkBankAccount } from '@/lib/banking/service';
import { createPayment } from '@/lib/payments/service';
import { resolvePayee } from '@/lib/payments/payee';

// ── credentials (keys generated per run; nothing key-like in the source) ────

const JWT_SECRET = randomUUID();
const OIDC_SECRET = randomUUID();

const sessionToken = () =>
  jwt.sign({ userId: MERCHANT_ID, email: 'owner@example.test' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const oauthToken = (scope = 'openid profile email wallet:read merchant', secret = OIDC_SECRET) =>
  jwt.sign(
    { sub: MERCHANT_ID, client_id: 'cp_fixture_app', scope, token_type: 'access' },
    secret,
    { algorithm: 'HS256', expiresIn: '1h' },
  );

const CREDENTIALS = {
  session: () => sessionToken(),
  'API key': () => API_KEY,
} as const;

function req(path: string, token: string, body?: unknown, method = 'POST') {
  return new NextRequest(`https://coinpay.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function expectOAuthRefusal(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.code).toBe('oauth_cannot_move_funds');
  expect(body.error).toBe('Moving funds needs the CoinPay dashboard; apps signed in with CoinPay cannot do this');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', JWT_SECRET);
  vi.stubEnv('OIDC_SIGNING_SECRET', OIDC_SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.example.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-role');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── POST /api/payouts/create ────────────────────────────────────────────────

describe('POST /api/payouts/create', () => {
  const payout = {
    business_id: BUSINESS_ID,
    recipient_email: 'payee@example.test',
    recipient_wallet: PAYOUT_ADDRESS,
    amount_usd: 5,
  };

  it('refuses a merchant-scope OAuth token', async () => {
    await expectOAuthRefusal(await payoutsCreate.POST(req('/api/payouts/create', oauthToken(), payout)));
    expect(createPayout).not.toHaveBeenCalled();
  });

  it('refuses it also when OAuth tokens share the session secret', async () => {
    vi.stubEnv('OIDC_SIGNING_SECRET', '');
    await expectOAuthRefusal(
      await payoutsCreate.POST(req('/api/payouts/create', oauthToken(undefined, JWT_SECRET), payout)),
    );
    expect(createPayout).not.toHaveBeenCalled();
  });

  it.each(Object.entries(CREDENTIALS))('still pays out for a %s', async (_name, token) => {
    const res = await payoutsCreate.POST(req('/api/payouts/create', token(), payout));
    expect(res.status).toBe(201);
    expect(createPayout).toHaveBeenCalledWith(expect.anything(), BUSINESS_ID, expect.objectContaining({ amount_usd: 5 }));
  });
});

// ── /api/banking ────────────────────────────────────────────────────────────

describe('POST /api/banking/transfers', () => {
  const transfer = {
    accountId: 'cp-1',
    direction: 'credit',
    amountMinor: 500,
    businessId: BUSINESS_ID,
    idempotencyKey: 'fixture-idem-1',
  };

  it('refuses a merchant-scope OAuth token', async () => {
    await expectOAuthRefusal(await bankingTransfers.POST(req('/api/banking/transfers', oauthToken(), transfer)));
    expect(originateTransfer).not.toHaveBeenCalled();
  });

  it('still originates for a dashboard session', async () => {
    const res = await bankingTransfers.POST(req('/api/banking/transfers', sessionToken(), transfer));
    expect(res.status).toBe(201);
    expect(originateTransfer).toHaveBeenCalled();
  });
});

describe('POST /api/banking/accounts', () => {
  const account = { holderName: 'Fixture Holder', routingNumber: '000000000', accountNumber: '0000', businessId: BUSINESS_ID };

  it('refuses to link a transfer destination for a merchant-scope OAuth token', async () => {
    await expectOAuthRefusal(await bankingAccounts.POST(req('/api/banking/accounts', oauthToken(), account)));
    expect(linkBankAccount).not.toHaveBeenCalled();
  });

  it('still links for a dashboard session', async () => {
    const res = await bankingAccounts.POST(req('/api/banking/accounts', sessionToken(), account));
    expect(res.status).not.toBe(403);
    expect(linkBankAccount).toHaveBeenCalled();
  });
});

// ── POST /api/payments/create with a custom payout address ─────────────────

describe('POST /api/payments/create', () => {
  const payment = (extra: Record<string, unknown> = {}) => ({
    business_id: BUSINESS_ID,
    amount_usd: 5,
    currency: 'usdc_pol',
    ...extra,
  });

  it('refuses a custom merchant_wallet_address for a merchant-scope OAuth token', async () => {
    await expectOAuthRefusal(
      await paymentsCreate.POST(req('/api/payments/create', oauthToken(), payment({ merchant_wallet_address: PAYOUT_ADDRESS }))),
    );
    expect(createPayment).not.toHaveBeenCalled();
  });

  it('still lets the OAuth token create a payment to the business wallet (onboarding)', async () => {
    await paymentsCreate.POST(req('/api/payments/create', oauthToken(), payment()));
    expect(createPayment).toHaveBeenCalled();
  });

  it.each(Object.entries(CREDENTIALS))('still accepts a custom payout address from a %s', async (_name, token) => {
    const res = await paymentsCreate.POST(
      req('/api/payments/create', token(), payment({ merchant_wallet_address: PAYOUT_ADDRESS })),
    );
    expect(res.status).not.toBe(403);
    expect(createPayment).toHaveBeenCalled();
  });
});

// ── POST /api/invoices with a custom payout address ─────────────────────────

describe('POST /api/invoices', () => {
  const invoice = (extra: Record<string, unknown> = {}) => ({
    business_id: BUSINESS_ID,
    amount: 25,
    currency: 'USD',
    crypto_currency: 'USDC_POL',
    ...extra,
  });

  it('refuses a custom merchant_wallet_address for a merchant-scope OAuth token', async () => {
    await expectOAuthRefusal(
      await invoices.POST(req('/api/invoices', oauthToken(), invoice({ merchant_wallet_address: PAYOUT_ADDRESS }))),
    );
    expect(resolvePayee).not.toHaveBeenCalled();
  });

  it('still lets the OAuth token create an invoice paying the business wallet', async () => {
    const res = await invoices.POST(req('/api/invoices', oauthToken(), invoice()));
    expect(res.status).toBe(418);
    expect(resolvePayee).toHaveBeenCalled();
  });

  it.each(Object.entries(CREDENTIALS))('still accepts a custom payout address from a %s', async (_name, token) => {
    const res = await invoices.POST(req('/api/invoices', token(), invoice({ merchant_wallet_address: PAYOUT_ADDRESS })));
    expect(res.status).toBe(418);
    expect(resolvePayee).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestedAddress: PAYOUT_ADDRESS }));
  });
});

// ── business API keys (they can send payouts) ───────────────────────────────

describe('business API keys are never handed to an OAuth app', () => {
  it('GET /api/businesses omits api_key for OAuth and keeps it for a session', async () => {
    const oauth = await (await businesses.GET(req('/api/businesses', oauthToken(), undefined, 'GET'))).json();
    expect(oauth.success).toBe(true);
    expect(oauth.businesses.length).toBeGreaterThan(0);
    expect(oauth.businesses[0]).not.toHaveProperty('api_key');

    const session = await (await businesses.GET(req('/api/businesses', sessionToken(), undefined, 'GET'))).json();
    expect(session.businesses[0].api_key).toBe(BUSINESS_ROW.api_key);
  });

  it('GET and POST /api/merchant/api-key refuse OAuth and keep working for a session', async () => {
    await expectOAuthRefusal(await merchantApiKey.GET(req('/api/merchant/api-key', oauthToken(), undefined, 'GET')));
    await expectOAuthRefusal(await merchantApiKey.POST(req('/api/merchant/api-key', oauthToken())));

    const session = await merchantApiKey.GET(req('/api/merchant/api-key', sessionToken(), undefined, 'GET'));
    expect(session.status).toBe(200);
    expect((await session.json()).apiKey).toBe(BUSINESS_ROW.api_key);
  });

  it('PATCH /api/businesses/[id] (onboarding) still works for OAuth, without the api_key in the reply', async () => {
    const service = await import('@/lib/business/service');
    const spy = vi.spyOn(service, 'updateBusiness').mockResolvedValue({ success: true, business: { ...BUSINESS_ROW } as any });
    const params = { params: Promise.resolve({ id: BUSINESS_ID }) };
    const patch = { webhook_url: 'https://app.example.test/hooks/coinpay' };

    const oauth = await businessById.PATCH(req(`/api/businesses/${BUSINESS_ID}`, oauthToken(), patch, 'PATCH'), params);
    expect(oauth.status).toBe(200);
    expect((await oauth.json()).business).not.toHaveProperty('api_key');

    const session = await businessById.PATCH(req(`/api/businesses/${BUSINESS_ID}`, sessionToken(), patch, 'PATCH'), params);
    expect((await session.json()).business.api_key).toBe(BUSINESS_ROW.api_key);
    spy.mockRestore();
  });
});
