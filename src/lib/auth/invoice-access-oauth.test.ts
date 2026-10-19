import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

vi.mock('./authz', () => ({
  authorizeBusiness: vi.fn(async (_s: unknown, caller: { via?: string }, _b: string, capability: string) =>
    capability === 'funds.move' && caller.via === 'oauth'
      ? { ok: false, status: 403, error: 'oauth_cannot_move_funds' }
      : { ok: true, role: 'owner' }),
}));

import { authorizeInvoice } from './invoice-access';

const OIDC_SECRET = randomUUID();
const supabase = {
  from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: 'inv-1', business_id: 'biz-1' }, error: null }) }) }) }),
} as any;

const oauth = () =>
  jwt.sign({ sub: 'merchant-9', client_id: 'cp_payagent', scope: 'openid merchant', token_type: 'access' }, OIDC_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
const req = (): any => new Request('https://coinpay.dev/api/invoices/inv-1/publish', { headers: { authorization: `Bearer ${oauth()}` } });

describe('authorizeInvoice with a merchant-scope OAuth token', () => {
  beforeEach(() => {
    vi.stubEnv('JWT_SECRET', randomUUID());
    vi.stubEnv('OIDC_SIGNING_SECRET', OIDC_SECRET);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('is refused unless the route opts in', async () => {
    expect(await authorizeInvoice(supabase, req(), 'inv-1', 'invoice.write')).toMatchObject({ ok: false, status: 403 });
  });

  it('publishes (invoice.write) when the route opts in', async () => {
    expect(await authorizeInvoice(supabase, req(), 'inv-1', 'invoice.write', '*', { allowOAuth: true })).toMatchObject({
      ok: true,
      via: 'oauth',
      merchantId: 'merchant-9',
    });
  });

  it('still cannot move funds when the route opts in', async () => {
    expect(await authorizeInvoice(supabase, req(), 'inv-1', 'funds.move', '*', { allowOAuth: true })).toMatchObject({ ok: false, status: 403 });
  });
});
