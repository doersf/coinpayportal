// @vitest-environment node
/**
 * Existing receivers keep verifying after the move onto @profullstack/webhooks.
 *
 * Merchants verify CoinPay webhooks before releasing goods, so the bar here is
 * "zero change on the receiving side". Every delivery below goes through the
 * real hub (package 0.2.1, the real coinpayStore over an in-memory supabase,
 * the real safeFetch adapter) and is then checked by:
 *
 *   - CoinPay's own published SDK (packages/sdk/src/webhooks.js, imported, not
 *     copied): verifyWebhookSignature on the raw body, and createWebhookHandler
 *     behind an express.json()-style parser that only parses application/json;
 *   - the d0rz verifier, copied in contract.test.ts;
 *   - a byte comparison with what the old direct sender (WEBHOOKS_HUB=off)
 *     sends for the same input: same body string, same X-CoinPay-Signature
 *     format, same Content-Type and User-Agent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac, randomBytes } from 'crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifySignature, tV1Header } from '@profullstack/webhooks';
// The published SDK receiver, as merchants run it.
import {
  verifyWebhookSignature as sdkVerify,
  createWebhookHandler as sdkHandler,
  parseWebhookPayload as sdkParse,
} from '../../../packages/sdk/src/webhooks.js';
import { encrypt, deriveKey } from '@/lib/crypto/encryption';
import { fakeSupabase } from './__fixtures__/fake-supabase';

type Captured = { url: string; headers: Headers; body: string };
const captured: Captured[] = [];
let nextStatus: number[] = [];

// The one network boundary both senders use. Captures exactly what would go on the wire.
vi.mock('@/lib/security/ssrf', async (orig) => {
  const actual = await orig<typeof import('@/lib/security/ssrf')>();
  return {
    ...actual,
    safeFetch: vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, headers: new Headers(init.headers as HeadersInit), body: String(init.body) });
      return { ok: true, response: new Response(null, { status: nextStatus.shift() ?? 200 }), finalUrl: url };
    }),
  };
});

const { sendPaymentWebhook, sendEscrowWebhook } = await import('./service');
const { sendWebhook: sendMonitorWebhook } = await import('@/app/api/cron/monitor-payments/webhook');
const hubModule = await import('./hub');
const { createCoinpayHub, RETRY_BACKOFF_MS, businessEndpointId } = hubModule;

const BUSINESS = 'b198c6dc-4c3b-4a54-994c-a750c1a580cd';
const MERCHANT = '0f4b2f2a-8d55-4a8e-9a43-1d6f0b6e2a11';
const PAYMENT = 'd084f959-c33c-4540-82b8-221181347639';
const ESCROW = '5c0f3b8e-7a51-4d0a-9e57-0d3a3b6b9f20';
const URL_ = 'https://merchant.example.com/webhooks/coinpay';
// Generated per run: the same shape business settings issue (whsecret_ + 64 hex).
const PLAIN_SECRET = ['whsecret', randomBytes(32).toString('hex')].join('_');

// --- the receivers ----------------------------------------------------------

function d0rzVerify(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = header.split(',');
  const t = parts.find((p) => p.startsWith('t='))?.slice(2);
  const sig = parts.find((p) => p.startsWith('v1='))?.slice(3);
  if (!t || !sig) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - parseInt(t, 10)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return sig === expected;
}

/** express.json(): parses only application/json; anything else leaves req.body = {}. */
async function runSdkExpressHandler(c: Captured, secret: string) {
  const ct = c.headers.get('content-type') ?? '';
  const req = { headers: Object.fromEntries(c.headers), body: ct.split(';')[0].trim() === 'application/json' ? JSON.parse(c.body) : {} };
  let status = 0;
  const events: any[] = [];
  const res = { status: (s: number) => ((status = s), { json: () => undefined }) };
  await sdkHandler({ secret, onEvent: async (e: any) => void events.push(e) })(req as any, res as any);
  return { status, events };
}

async function assertOldReceiversAccept(c: Captured, secret: string) {
  const header = c.headers.get('x-coinpay-signature');
  expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  expect(sdkVerify({ payload: c.body, signature: header!, secret })).toBe(true);
  expect(d0rzVerify(c.body, header, secret)).toBe(true);
  const viaExpress = await runSdkExpressHandler(c, secret);
  expect(viaExpress.status).toBe(200);
  expect(viaExpress.events).toHaveLength(1);
  expect(c.headers.get('content-type')).toBe('application/json');
  expect(c.headers.get('user-agent')).toBe('CoinPay-Webhook/1.0');
}

// --- setup ------------------------------------------------------------------

let sb: ReturnType<typeof fakeSupabase>;
const env = { ...process.env };

function seedBusiness(storedSecret: string) {
  sb.rows('businesses').push({ id: BUSINESS, webhook_url: URL_, webhook_secret: storedSecret, merchant_id: MERCHANT });
}

function installHub(fetchImpl?: typeof fetch) {
  const hub = createCoinpayHub({ client: sb as any, ...(fetchImpl ? { fetchImpl } : {}) });
  (globalThis as any).__coinpayWebhooksHub = hub;
  return hub;
}

const paymentData = {
  status: 'confirmed',
  amount_usd: 25,
  amount_crypto: '0.01',
  currency: 'ETH',
  confirmations: 12,
  payment_address: '0xabc',
  tx_hash: '0xdef',
  metadata: { order_id: 'A-100', payment_rail: 'crypto' },
};

beforeEach(() => {
  captured.length = 0;
  nextStatus = [];
  sb = fakeSupabase();
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  process.env.WEBHOOKS_HUB = 'on';
});

afterEach(() => {
  process.env = { ...env };
  delete (globalThis as any).__coinpayWebhooksHub;
  vi.useRealTimers();
});

describe('payment webhooks through the hub', () => {
  it('sends the same body and X-CoinPay-Signature as the old sender, and every old receiver verifies', async () => {
    // Encrypted at rest with the per-merchant key, exactly as business settings store it.
    seedBusiness(encrypt(PLAIN_SECRET, deriveKey(process.env.ENCRYPTION_KEY!, MERCHANT)));
    installHub();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T18:00:00.000Z'));

    process.env.WEBHOOKS_HUB = 'off';
    expect((await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData)).success).toBe(true);
    process.env.WEBHOOKS_HUB = 'on';
    expect((await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData)).success).toBe(true);

    expect(captured).toHaveLength(2);
    const [old, viaHub] = captured;
    expect(viaHub.url).toBe(old.url);
    expect(viaHub.body).toBe(old.body); // byte for byte
    const body = JSON.parse(viaHub.body);
    expect(Object.keys(body)).toEqual(['id', 'type', 'data', 'created_at', 'business_id']);
    expect(body.id).toBe(`evt_${PAYMENT}_${Math.floor(Date.now() / 1000)}`);
    expect(body.data).toMatchObject({ payment_id: PAYMENT, amount: 25, metadata: { order_id: 'A-100' } });

    await assertOldReceiversAccept(old, PLAIN_SECRET);
    await assertOldReceiversAccept(viaHub, PLAIN_SECRET);
    // Same legacy headers on both; the hub only adds the Standard Webhooks ones.
    for (const h of ['content-type', 'user-agent']) expect(viaHub.headers.get(h)).toBe(old.headers.get(h));
    expect(viaHub.headers.get('x-coinpay-signature')).toBe(old.headers.get('x-coinpay-signature'));
    expect(viaHub.headers.get('webhook-id')).toBe(body.id);
    expect(viaHub.headers.get('webhook-event')).toBe('payment.confirmed');
    expect(verifySignature({ headers: viaHub.headers, body: viaHub.body, secret: PLAIN_SECRET }).ok).toBe(true);

    // parseWebhookPayload still finds the business and creation time at the top level.
    const parsed = sdkParse(viaHub.body);
    expect(parsed.businessId).toBe(BUSINESS);
    expect(parsed.createdAt.toISOString()).toBe('2026-10-28T18:00:00.000Z');

    // The dashboard log still gets its row.
    const logs = sb.rows('webhook_logs');
    expect(logs.at(-1)).toMatchObject({ business_id: BUSINESS, payment_id: PAYMENT, event: 'payment.confirmed', success: true, attempt_number: 1, webhook_url: URL_ });
  });

  it('whsec_ trap: a business whose secret is a raw whsec_ string still verifies (the package helper would not)', async () => {
    const whsec = `whsec_${randomBytes(24).toString('base64')}`;
    seedBusiness(whsec); // two live businesses store one like this, unencrypted
    installHub();
    await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData);
    expect(captured).toHaveLength(1);
    await assertOldReceiversAccept(captured[0], whsec);

    // Why the header is built in-app: tV1Header keys the HMAC with the base64-decoded bytes.
    const pkgHeader = tV1Header('x-coinpay-signature')({ body: captured[0].body, secret: whsec })['x-coinpay-signature'];
    expect(sdkVerify({ payload: captured[0].body, signature: pkgHeader, secret: whsec })).toBe(false);
  });

  it('retries a failed delivery on the hub backoff (any non-2xx, 4xx included) and logs each attempt', async () => {
    seedBusiness(PLAIN_SECRET);
    let now = Date.now();
    const hub = createCoinpayHub({ client: sb as any, now: () => now });
    (globalThis as any).__coinpayWebhooksHub = hub;
    nextStatus = [503, 400, 200];

    const r = await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData);
    expect(r.success).toBe(false);
    let [row] = sb.rows('hub_webhook_deliveries');
    expect(row).toMatchObject({ status: 'pending', attempts: 1, endpoint_id: businessEndpointId(BUSINESS) });

    now += 1_500;
    await hub.hooks.drain();
    [row] = sb.rows('hub_webhook_deliveries');
    expect(row).toMatchObject({ status: 'pending', attempts: 2, last_status: 400 }); // a 4xx is retried, as before

    now += 2_500;
    await hub.hooks.drain();
    [row] = sb.rows('hub_webhook_deliveries');
    expect(row).toMatchObject({ status: 'delivered', attempts: 3 });

    expect(captured).toHaveLength(3);
    expect(new Set(captured.map((c) => c.body)).size).toBe(1); // the same body every time
    expect(new Set(captured.map((c) => c.headers.get('webhook-id'))).size).toBe(1);
    for (const c of captured) expect(sdkVerify({ payload: c.body, signature: c.headers.get('x-coinpay-signature')!, secret: PLAIN_SECRET })).toBe(true);
    expect(sb.rows('webhook_logs').map((l) => [l.attempt_number, l.success, l.status_code])).toEqual([
      [1, false, 503],
      [2, false, 400],
      [3, true, 200],
    ]);
    // Business webhooks are never switched off for failing.
    expect(await hub.store.getEndpoint(businessEndpointId(BUSINESS))).toMatchObject({ enabled: true });
  });

  it('is at least as generous as the old schedule (11 attempts over ~34 h)', () => {
    const total = RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0);
    expect(RETRY_BACKOFF_MS.length + 1).toBeGreaterThanOrEqual(11);
    expect(total).toBeGreaterThan(34 * 3_600_000);
    // Opening matches the old in-process attempts (0, +1 s, +2 s).
    expect(RETRY_BACKOFF_MS.slice(0, 2)).toEqual([1_000, 2_000]);
  });

  it('a retry after the merchant rotates the secret is signed with the new one (read live, like the old queue)', async () => {
    seedBusiness(PLAIN_SECRET);
    let now = Date.now();
    const hub = createCoinpayHub({ client: sb as any, now: () => now });
    (globalThis as any).__coinpayWebhooksHub = hub;
    nextStatus = [500, 200];
    await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData);
    const rotated = ['whsecret', randomBytes(32).toString('hex')].join('_');
    sb.rows('businesses')[0].webhook_secret = rotated;
    now += 1_500;
    await hub.hooks.drain();
    expect(sdkVerify({ payload: captured[1].body, signature: captured[1].headers.get('x-coinpay-signature')!, secret: rotated })).toBe(true);
  });

  it('falls back to the old direct sender, once, when the hub cannot take the delivery', async () => {
    seedBusiness(PLAIN_SECRET);
    const broken = {
      ...sb,
      from: (t: string) => {
        const q = sb.from(t);
        if (t === 'hub_webhook_deliveries') q.insert = () => Promise.resolve({ data: null, error: { message: 'relation "hub_webhook_deliveries" does not exist' } });
        return q;
      },
    };
    (globalThis as any).__coinpayWebhooksHub = createCoinpayHub({ client: broken as any });
    const r = await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData);
    expect(r.success).toBe(true);
    expect(captured).toHaveLength(1);
    await assertOldReceiversAccept(captured[0], PLAIN_SECRET);
  });

  it('no webhook configured: nothing is sent or queued, as before', async () => {
    sb.rows('businesses').push({ id: BUSINESS, webhook_url: null, webhook_secret: null, merchant_id: MERCHANT });
    installHub();
    expect((await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData)).success).toBe(true);
    expect(captured).toHaveLength(0);
    expect(sb.rows('hub_webhook_deliveries')).toHaveLength(0);
  });
});

describe('the other business senders', () => {
  it('escrow events: same body as before, old receivers verify', async () => {
    seedBusiness(PLAIN_SECRET);
    installHub();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T18:00:00.000Z'));
    const escrow = { status: 'funded', chain: 'ETH', amount: 1, escrow_address: '0x1', metadata: { a: 1 } };
    process.env.WEBHOOKS_HUB = 'off';
    await sendEscrowWebhook(sb as any, BUSINESS, ESCROW, 'escrow.funded', escrow);
    process.env.WEBHOOKS_HUB = 'on';
    await sendEscrowWebhook(sb as any, BUSINESS, ESCROW, 'escrow.funded', escrow);
    expect(captured).toHaveLength(2);
    expect(captured[1].body).toBe(captured[0].body);
    await assertOldReceiversAccept(captured[1], PLAIN_SECRET);
    expect(sb.rows('webhook_logs').at(-1)).toMatchObject({ escrow_id: ESCROW, payment_id: null, event: 'escrow.funded' });
  });

  it('monitor-payments sender: same body as before, old receivers verify', async () => {
    seedBusiness(PLAIN_SECRET);
    installHub();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T18:00:00.000Z'));
    const payment = { id: PAYMENT, business_id: BUSINESS, blockchain: 'ETH', crypto_amount: 0.01, status: 'expired', payment_address: '0xabc' } as any;
    process.env.WEBHOOKS_HUB = 'off';
    await sendMonitorWebhook(sb as any, payment, 'payment.expired', { reason: 'timeout' });
    process.env.WEBHOOKS_HUB = 'on';
    await sendMonitorWebhook(sb as any, payment, 'payment.expired', { reason: 'timeout' });
    expect(captured).toHaveLength(2);
    expect(captured[1].body).toBe(captured[0].body);
    await assertOldReceiversAccept(captured[0], PLAIN_SECRET);
    await assertOldReceiversAccept(captured[1], PLAIN_SECRET);
  });
});

describe('endpoints added through /api/v1/webhooks', () => {
  it('get a Standard Webhooks CloudEvent; the business URL never does', async () => {
    seedBusiness(PLAIN_SECRET);
    const hub = installHub();
    const { endpoint, secret } = await hub.hooks.createEndpoint(BUSINESS, { url: 'https://new.example.com/hook', events: ['payment.*'] });
    // Not listed alongside: the business webhook is managed in settings.
    expect((await hub.hooks.listEndpoints(BUSINESS)).map((e) => e.id)).toEqual([endpoint.id]);
    // Secrets are encrypted at rest.
    expect(String(sb.rows('hub_webhook_endpoints')[0].secret)).toMatch(/^cphub:/);

    await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData);
    await hub.hooks.drain();

    const toBusiness = captured.filter((c) => c.url === URL_);
    const toNew = captured.filter((c) => c.url === 'https://new.example.com/hook');
    expect(toBusiness).toHaveLength(1);
    expect(JSON.parse(toBusiness[0].body).specversion).toBeUndefined();
    expect(toNew).toHaveLength(1);
    const ce = JSON.parse(toNew[0].body);
    expect(ce).toMatchObject({ specversion: '1.0', type: 'payment.confirmed', subject: `payment:${PAYMENT}` });
    expect(ce.data.payment_id).toBe(PAYMENT);
    expect(verifySignature({ headers: toNew[0].headers, body: toNew[0].body, secret }).ok).toBe(true);
  });

  it('the business endpoint cannot be changed, deleted or rotated through the hub', async () => {
    seedBusiness(PLAIN_SECRET);
    const hub = installHub();
    const id = businessEndpointId(BUSINESS);
    await expect(hub.hooks.updateEndpoint(BUSINESS, id, { url: 'https://evil.example.com' })).rejects.toMatchObject({ status: 409 });
    await expect(hub.hooks.deleteEndpoint(BUSINESS, id)).rejects.toMatchObject({ status: 409 });
    await expect(hub.hooks.rotateSecret(BUSINESS, id)).rejects.toMatchObject({ status: 409 });
    // Another business cannot reach it at all.
    await expect(hub.hooks.getEndpoint('11111111-1111-1111-1111-111111111111', id)).rejects.toMatchObject({ status: 404 });
  });
});

describe('on the wire', () => {
  it('a real HTTP receiver gets single-valued headers and the exact body', async () => {
    seedBusiness(PLAIN_SECRET);
    const seen: { headers: http.IncomingHttpHeaders; body: string }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    sb.rows('businesses')[0].webhook_url = `http://127.0.0.1:${port}/coinpay`;
    // Real fetch to the local receiver (safeFetch would rightly refuse 127.0.0.1).
    installHub(globalThis.fetch);
    try {
      const r = await sendPaymentWebhook(sb as any, BUSINESS, PAYMENT, 'payment.confirmed', paymentData);
      expect(r.success).toBe(true);
    } finally {
      server.close();
    }
    expect(seen).toHaveLength(1);
    const [{ headers, body }] = seen;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('CoinPay-Webhook/1.0');
    expect(sdkVerify({ payload: body, signature: String(headers['x-coinpay-signature']), secret: PLAIN_SECRET })).toBe(true);
    expect(d0rzVerify(body, String(headers['x-coinpay-signature']), PLAIN_SECRET)).toBe(true);
  });
});
