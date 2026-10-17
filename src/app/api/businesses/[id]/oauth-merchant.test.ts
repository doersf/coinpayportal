/**
 * Business onboarding routes accept a `merchant`-scope OAuth bearer exactly as a
 * dashboard session (a third-party app like pay.agent signing users in with
 * CoinPay), with the same ownership checks — and refuse OAuth tokens without
 * that scope.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const OWNERS: Record<string, string> = {
  'biz-mine': 'merchant-9',
  'biz-other': 'merchant-other',
};

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => {
    let id: string | undefined;
    const chain: any = {
      select: () => chain,
      eq: (_col: string, value: string) => {
        id = value;
        return chain;
      },
      maybeSingle: async () => ({ data: id && OWNERS[id] ? { merchant_id: OWNERS[id] } : null }),
    };
    return { from: () => chain };
  }),
}));

vi.mock('@/lib/auth/authz', () => {
  const check = (userId: string, businessId: string) =>
    OWNERS[businessId] && OWNERS[businessId] === userId;
  return {
    authorizeBusiness: vi.fn(async (_s: unknown, userId: string, businessId: string) =>
      check(userId, businessId)
        ? { ok: true, role: 'owner' }
        : { ok: false, status: 404, error: 'Business not found' }
    ),
    authorizeBusinessOwner: vi.fn(async (_s: unknown, userId: string, businessId: string) =>
      check(userId, businessId)
        ? { ok: true, role: 'owner', ownerId: OWNERS[businessId] }
        : { ok: false, status: 404, error: 'Business not found' }
    ),
  };
});

vi.mock('@/lib/business/service', () => ({
  getBusiness: vi.fn(async () => ({ success: true, business: { id: 'biz-mine', api_key: 'cp_live_x' } })),
  updateBusiness: vi.fn(async () => ({ success: true, business: { id: 'biz-mine' } })),
  deleteBusiness: vi.fn(async () => ({ success: true })),
  getWebhookSecret: vi.fn(async () => ({ success: true, secret: 'whsec_test' })),
  regenerateWebhookSecret: vi.fn(async () => ({ success: true, secret: 'whsec_new' })),
}));

vi.mock('@/lib/wallets/service', () => ({
  createWallet: vi.fn(async () => ({ success: true, wallet: { id: 'bw-1' } })),
  listWallets: vi.fn(async () => ({ success: true, wallets: [] })),
}));

vi.mock('@/lib/wallets/merchant-service', () => ({
  importWalletsToBusiness: vi.fn(async () => ({ success: true, imported: 2, skipped: 0 })),
}));

import * as businessRoute from './route';
import * as walletsRoute from './wallets/route';
import * as importRoute from './wallets/import/route';
import * as webhookSecretRoute from './webhook-secret/route';
import { updateBusiness, deleteBusiness, getWebhookSecret } from '@/lib/business/service';
import { createWallet } from '@/lib/wallets/service';
import { importWalletsToBusiness } from '@/lib/wallets/merchant-service';

const JWT_SECRET = 'session-secret-for-tests';
const OIDC_SECRET = 'oidc-secret-for-tests';

const sessionToken = (userId = 'merchant-9') =>
  jwt.sign({ userId }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

const oauthToken = (scope: string, sub = 'merchant-9') =>
  jwt.sign({ sub, client_id: 'cp_payagent', scope, token_type: 'access' }, OIDC_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });

const MERCHANT_SCOPES = 'openid profile email wallet:read merchant';
const NO_MERCHANT_SCOPES = 'openid profile email wallet:read';

function req(token: string, method = 'POST', body?: unknown): any {
  return new Request('https://coinpay.dev/api/businesses/x', {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('JWT_SECRET', JWT_SECRET);
  vi.stubEnv('OIDC_SIGNING_SECRET', OIDC_SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PATCH /api/businesses/[id]', () => {
  const patch = { webhook_url: 'https://pay.example/webhooks/coinpay' };

  it('updates for a merchant-scope OAuth token on its own business', async () => {
    const res = await businessRoute.PATCH(req(oauthToken(MERCHANT_SCOPES), 'PATCH', patch), params('biz-mine'));
    expect(res.status).toBe(200);
    expect(updateBusiness).toHaveBeenCalledWith(expect.anything(), 'biz-mine', 'merchant-9', patch);
  });

  it('still works for a dashboard session', async () => {
    const res = await businessRoute.PATCH(req(sessionToken(), 'PATCH', patch), params('biz-mine'));
    expect(res.status).toBe(200);
  });

  it('refuses an OAuth token without the merchant scope', async () => {
    const res = await businessRoute.PATCH(req(oauthToken(NO_MERCHANT_SCOPES), 'PATCH', patch), params('biz-mine'));
    expect(res.status).toBe(403);
    expect(updateBusiness).not.toHaveBeenCalled();
  });

  it("refuses another merchant's business", async () => {
    const res = await businessRoute.PATCH(req(oauthToken(MERCHANT_SCOPES), 'PATCH', patch), params('biz-other'));
    expect(res.status).toBe(404);
    expect(updateBusiness).not.toHaveBeenCalled();
  });

  it('keeps DELETE and GET dashboard-only even with the merchant scope', async () => {
    const del = await businessRoute.DELETE(req(oauthToken(MERCHANT_SCOPES), 'DELETE'), params('biz-mine'));
    expect(del.status).toBe(403);
    expect(deleteBusiness).not.toHaveBeenCalled();
    const get = await businessRoute.GET(req(oauthToken(MERCHANT_SCOPES), 'GET'), params('biz-mine'));
    expect(get.status).toBe(403);
  });
});

describe('POST /api/businesses/[id]/wallets', () => {
  const body = { cryptocurrency: 'USDC_SOL', wallet_address: 'So1anaTestAddress111111111111111111111111111' };

  it('adds a payout address for a merchant-scope OAuth token', async () => {
    const res = await walletsRoute.POST(req(oauthToken(MERCHANT_SCOPES), 'POST', body), params('biz-mine'));
    expect(res.status).toBe(201);
    expect(createWallet).toHaveBeenCalledWith(
      expect.anything(),
      'biz-mine',
      'merchant-9',
      expect.objectContaining({ cryptocurrency: 'USDC_SOL' })
    );
  });

  it('refuses an OAuth token without the merchant scope', async () => {
    const res = await walletsRoute.POST(req(oauthToken(NO_MERCHANT_SCOPES), 'POST', body), params('biz-mine'));
    expect(res.status).toBe(403);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it("refuses another merchant's business", async () => {
    const res = await walletsRoute.POST(req(oauthToken(MERCHANT_SCOPES), 'POST', body), params('biz-other'));
    expect(res.status).toBe(404);
    expect(createWallet).not.toHaveBeenCalled();
  });

  it('lists wallets (GET) for a merchant-scope OAuth token', async () => {
    const res = await walletsRoute.GET(req(oauthToken(MERCHANT_SCOPES), 'GET'), params('biz-mine'));
    expect(res.status).toBe(200);
  });
});

describe('POST /api/businesses/[id]/wallets/import', () => {
  it('imports account wallets for a merchant-scope OAuth token', async () => {
    const res = await importRoute.POST(req(oauthToken(MERCHANT_SCOPES), 'POST', { all: true }), params('biz-mine'));
    expect(res.status).toBe(200);
    expect(importWalletsToBusiness).toHaveBeenCalledWith(expect.anything(), 'merchant-9', 'biz-mine', undefined);
  });

  it('passes a cryptocurrencies list through', async () => {
    await importRoute.POST(
      req(oauthToken(MERCHANT_SCOPES), 'POST', { cryptocurrencies: ['BTC', 'ETH'] }),
      params('biz-mine')
    );
    expect(importWalletsToBusiness).toHaveBeenCalledWith(expect.anything(), 'merchant-9', 'biz-mine', ['BTC', 'ETH']);
  });

  it('refuses an OAuth token without the merchant scope', async () => {
    const res = await importRoute.POST(req(oauthToken(NO_MERCHANT_SCOPES), 'POST', { all: true }), params('biz-mine'));
    expect(res.status).toBe(403);
    expect(importWalletsToBusiness).not.toHaveBeenCalled();
  });

  it("refuses another merchant's business", async () => {
    const res = await importRoute.POST(req(oauthToken(MERCHANT_SCOPES), 'POST', { all: true }), params('biz-other'));
    expect(res.status).toBe(404);
    expect(importWalletsToBusiness).not.toHaveBeenCalled();
  });
});

describe('GET /api/businesses/[id]/webhook-secret', () => {
  it('returns the secret for a merchant-scope OAuth token', async () => {
    const res = await webhookSecretRoute.GET(req(oauthToken(MERCHANT_SCOPES), 'GET'), params('biz-mine'));
    expect(res.status).toBe(200);
    expect((await res.json()).secret).toBe('whsec_test');
  });

  it('refuses an OAuth token without the merchant scope', async () => {
    const res = await webhookSecretRoute.GET(req(oauthToken(NO_MERCHANT_SCOPES), 'GET'), params('biz-mine'));
    expect(res.status).toBe(403);
    expect(getWebhookSecret).not.toHaveBeenCalled();
  });

  it("refuses another merchant's business", async () => {
    const res = await webhookSecretRoute.GET(req(oauthToken(MERCHANT_SCOPES, 'merchant-9'), 'GET'), params('biz-other'));
    expect(res.status).toBe(404);
    expect(getWebhookSecret).not.toHaveBeenCalled();
  });
});
