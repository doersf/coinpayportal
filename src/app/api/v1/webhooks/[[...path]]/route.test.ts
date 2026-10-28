// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { randomBytes } from 'crypto';
import { fakeSupabase } from '@/lib/webhooks/__fixtures__/fake-supabase';

const BUSINESS = 'b198c6dc-4c3b-4a54-994c-a750c1a580cd';

vi.mock('@/lib/auth/middleware', () => ({
  authenticateRequest: vi.fn(async (_sb: unknown, header: string | null) => {
    if (header === 'Bearer cp_live_full') return { success: true, context: { type: 'business', businessId: BUSINESS, merchantId: 'm', businessName: 'b', scopes: ['*'] } };
    if (header === 'Bearer cp_live_scoped') return { success: true, context: { type: 'business', businessId: BUSINESS, merchantId: 'm', businessName: 'b', scopes: ['payments:read'] } };
    return { success: false, error: 'Invalid API key' };
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => ({}) }));

const { createCoinpayHub } = await import('@/lib/webhooks/hub');
const route = await import('./route');

const req = (path: string, init: { method?: string; key?: string; body?: unknown } = {}) =>
  new NextRequest(`https://coinpayportal.com/api/v1/webhooks${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.key ? { authorization: `Bearer ${init.key}` } : {}), 'content-type': 'application/json' },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

beforeEach(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const sb = fakeSupabase();
  sb.rows('businesses').push({ id: BUSINESS, webhook_url: 'https://m.example.com/h', webhook_secret: `whsecret_${randomBytes(8).toString('hex')}`, merchant_id: 'm' });
  (globalThis as any).__coinpayWebhooksHub = createCoinpayHub({ client: sb as any, fetchImpl: (async () => new Response(null, { status: 204 })) as any });
});

describe('/api/v1/webhooks', () => {
  it('401 without a key, or with a key that is not full-access', async () => {
    expect((await route.GET(req(''))).status).toBe(401);
    expect((await route.GET(req('', { key: 'cp_live_nope' }))).status).toBe(401);
    expect((await route.GET(req('', { key: 'cp_live_scoped' }))).status).toBe(401);
    expect((await route.POST(req(`/biz_${BUSINESS}/rotate`, { method: 'POST' }))).status).toBe(401);
  });

  it('creates, lists and tests an endpoint with a full-access key', async () => {
    const created = await route.POST(req('', { method: 'POST', key: 'cp_live_full', body: { url: 'https://n.example.com/h', events: ['payment.*'] } }));
    expect(created.status).toBe(201);
    const { endpoint, secret } = await created.json();
    expect(secret).toMatch(/^whsec_/);
    const list = await (await route.GET(req('', { key: 'cp_live_full' }))).json();
    expect(list.endpoints.map((e: any) => e.id)).toEqual([endpoint.id]);
    expect(list.event_types).toContain('payment.confirmed');
    const test = await (await route.POST(req(`/${endpoint.id}/test`, { method: 'POST', key: 'cp_live_full' }))).json();
    expect(test.ok).toBe(true);
  });

  it('the business webhook is read-only here', async () => {
    const id = `biz_${BUSINESS}`;
    expect((await route.GET(req(`/${id}`, { key: 'cp_live_full' }))).status).toBe(200);
    expect((await route.GET(req(`/${id}/deliveries`, { key: 'cp_live_full' }))).status).toBe(200);
    for (const [m, p] of [['GET', '/secret'], ['POST', '/rotate'], ['POST', '/test'], ['DELETE', ''], ['PATCH', '']] as const) {
      expect((await (route as any)[m](req(`/${id}${p}`, { method: m, key: 'cp_live_full', body: m === 'PATCH' ? { url: 'https://x.example.com' } : undefined }))).status).toBe(409);
    }
  });
});
