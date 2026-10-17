import { describe, it, expect } from 'vitest';
import { hasScope, type MerchantAuthContext, type BusinessAuthContext } from './middleware';
import { authorizeBusiness } from './authz';
import { refuseOAuthFundsMove, withoutApiKeyForOAuth, OAUTH_CANNOT_MOVE_FUNDS } from './oauth-funds';

const session: MerchantAuthContext = { type: 'merchant', merchantId: 'm-1', email: 'a@example.test', via: 'session' };
const legacySession: MerchantAuthContext = { type: 'merchant', merchantId: 'm-1', email: 'a@example.test' };
const oauth: MerchantAuthContext = { ...session, via: 'oauth', oauthClientId: 'cp_fixture_app' };
const apiKey: BusinessAuthContext = { type: 'business', businessId: 'b-1', merchantId: 'm-1', businessName: 'B', scopes: ['*'] };

// The owner of b-1 is m-1, with no memberships.
const supabase: any = {
  from: () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: { merchant_id: 'm-1', organization_id: null } }),
    };
    return chain;
  },
};

describe('hasScope', () => {
  it('denies funds-moving scopes to an OAuth merchant context only', () => {
    expect(hasScope(oauth, 'payouts:create')).toBe(false);
    expect(hasScope(oauth, 'payments:refund')).toBe(false);
    expect(hasScope(oauth, 'payments:create')).toBe(true);
    for (const ctx of [session, legacySession, apiKey]) {
      expect(hasScope(ctx, 'payouts:create')).toBe(true);
    }
  });
});

describe('authorizeBusiness funds.move', () => {
  it('refuses an OAuth actor even as owner, with oauth_cannot_move_funds', async () => {
    const r = await authorizeBusiness(supabase, { merchantId: 'm-1', via: 'oauth' }, 'b-1', 'funds.move');
    expect(r).toMatchObject({ ok: false, status: 403, code: OAUTH_CANNOT_MOVE_FUNDS });
  });

  it('lets an OAuth actor through for non-funds capabilities', async () => {
    expect(await authorizeBusiness(supabase, { merchantId: 'm-1', via: 'oauth' }, 'b-1', 'invoice.write')).toMatchObject({ ok: true });
  });

  it('is unchanged for a session (object or legacy string form)', async () => {
    expect(await authorizeBusiness(supabase, 'm-1', 'b-1', 'funds.move')).toEqual({ ok: true, role: 'owner' });
    expect(await authorizeBusiness(supabase, { merchantId: 'm-1', via: 'session' }, 'b-1', 'funds.move')).toEqual({ ok: true, role: 'owner' });
  });
});

describe('helpers', () => {
  it('refuseOAuthFundsMove only answers OAuth contexts', async () => {
    expect(refuseOAuthFundsMove(session)).toBeNull();
    expect(refuseOAuthFundsMove(apiKey)).toBeNull();
    expect(refuseOAuthFundsMove(null)).toBeNull();
    const res = refuseOAuthFundsMove(oauth)!;
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe(OAUTH_CANNOT_MOVE_FUNDS);
  });

  it('withoutApiKeyForOAuth strips the key for OAuth only', () => {
    const row = { id: 'b-1', api_key: 'fixture-business-key' };
    expect(withoutApiKeyForOAuth(row, oauth)).toEqual({ id: 'b-1' });
    expect(withoutApiKeyForOAuth(row, session)).toBe(row);
  });
});
