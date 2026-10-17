import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { resolveMerchant } from './merchant';

// Signing keys are generated per run: nothing key-like lives in the source.
const JWT_SECRET = randomUUID();
const OIDC_SECRET = randomUUID();
const supabase = {} as any;

const oauth = (scope: string) =>
  jwt.sign({ sub: 'merchant-9', client_id: 'cp_payagent', scope, token_type: 'access' }, OIDC_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });

const req = (token: string): any =>
  new Request('https://coinpay.dev/api/invoices', { headers: { authorization: `Bearer ${token}` } });

describe('resolveMerchant with OAuth bearers', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', JWT_SECRET);
    vi.stubEnv('OIDC_SIGNING_SECRET', OIDC_SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('resolves a session JWT as before', async () => {
    const token = jwt.sign({ userId: 'merchant-9' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
    expect(await resolveMerchant(supabase, req(token))).toEqual({ merchantId: 'merchant-9', apiKeyBusinessId: null });
  });

  it('maps a merchant-scope OAuth token to its sub when the route opts in', async () => {
    expect(await resolveMerchant(supabase, req(oauth('openid merchant')), { allowOAuth: true })).toEqual({
      merchantId: 'merchant-9',
      apiKeyBusinessId: null,
    });
  });

  it('refuses a merchant-scope OAuth token when the route has not opted in (funds.move callers)', async () => {
    expect(await resolveMerchant(supabase, req(oauth('openid merchant')))).toMatchObject({ status: 403 });
  });

  it('refuses an OAuth token without the merchant scope even when opted in', async () => {
    const result = await resolveMerchant(supabase, req(oauth('openid profile wallet:read')), { allowOAuth: true });
    expect(result).toMatchObject({ status: 403 });
    expect((result as any).error).toMatch(/insufficient_scope/);
  });

  it('401s a forged token', async () => {
    const forged = jwt.sign({ sub: 'merchant-9', scope: 'merchant', token_type: 'access' }, 'nope');
    expect(await resolveMerchant(supabase, req(forged), { allowOAuth: true })).toMatchObject({ status: 401 });
  });
});
