import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockSupabase, mockAuth, mockEligible, inserted } = vi.hoisted(() => ({
  mockSupabase: { from: vi.fn() },
  mockAuth: vi.fn(),
  mockEligible: vi.fn(),
  inserted: { row: null as any },
}));

vi.mock('@supabase/supabase-js', () => ({ createClient: () => mockSupabase }));
vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: mockAuth,
  isBusinessAuth: (c: any) => c.type === 'business',
  isMerchantAuth: (c: any) => c.type === 'merchant',
  hasScope: () => true,
}));
vi.mock('@/lib/wallets/supported-coins', () => ({ verifyBusinessAccess: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/lib/checkout/sessions', async (orig) => ({
  ...(await orig<typeof import('@/lib/checkout/sessions')>()),
  eligibleMethods: mockEligible,
}));

import { POST } from './route';

function req(body: unknown) {
  return new NextRequest('http://localhost/api/checkout/sessions', {
    method: 'POST',
    headers: { authorization: 'Bearer cp_live_x', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  process.env.NEXT_PUBLIC_APP_URL = 'https://coinpayportal.com';
  inserted.row = null;
  mockAuth.mockResolvedValue({ success: true, context: { type: 'business', businessId: 'biz-1', merchantId: 'm-1' } });
  mockEligible.mockResolvedValue([{ code: 'USDC_POL' }, { code: 'PAYPAL' }]);
  mockSupabase.from.mockImplementation((table: string) => {
    if (table === 'businesses') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'biz-1', name: 'smshub.dev', merchant_id: 'm-1' } }) }) }) };
    }
    if (table === 'checkout_sessions') {
      return { insert: async (row: any) => { inserted.row = row; return { error: null }; } };
    }
    throw new Error(table);
  });
});

describe('POST /api/checkout/sessions', () => {
  it('400s without customer_email', async () => {
    const res = await POST(req({ amount: 1, account_id: 'u1' }));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('MISSING_CUSTOMER_EMAIL');
    expect(inserted.row).toBeNull();
  });

  it('400s without account_id', async () => {
    const res = await POST(req({ amount: 1, customer_email: 'a@b.co' }));
    expect((await res.json()).code).toBe('MISSING_ACCOUNT_ID');
  });

  it('401s without auth', async () => {
    mockAuth.mockResolvedValue({ success: false, error: 'Missing authorization header' });
    expect((await POST(req({}))).status).toBe(401);
  });

  it('creates a session and returns id + url', async () => {
    const res = await POST(req({ amount: 1, customer_email: 'a@b.co', account_id: 'u1', metadata: { k: 'v' } }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.id).toMatch(/^cs_[A-Za-z0-9]{24}$/);
    expect(data.url).toBe(`https://coinpayportal.com/checkout/${data.id}`);
    expect(data.property).toBe('smshub.dev');
    expect(data.methods).toEqual(['USDC_POL', 'PAYPAL']);
    expect(inserted.row).toMatchObject({ business_id: 'biz-1', customer_email: 'a@b.co', account_id: 'u1', status: 'open', metadata: { k: 'v' } });
  });

  it('refuses a session nobody could pay', async () => {
    mockEligible.mockResolvedValue([]);
    const res = await POST(req({ amount: 1, customer_email: 'a@b.co', account_id: 'u1' }));
    expect((await res.json()).code).toBe('NO_PAYMENT_METHODS');
  });
});
