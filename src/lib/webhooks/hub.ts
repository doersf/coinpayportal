/**
 * Merchant webhooks on @profullstack/webhooks (the "hub").
 *
 * What changes: delivery. Every business webhook is written to a durable outbox
 * (hub_webhook_deliveries), attempted once at once — inline, like before — and
 * then retried by the hub's drainer on a backoff that is longer than the old
 * three-in-process-plus-cron-queue schedule on every axis. Every attempt is
 * still written to `webhook_logs`, which the dashboard reads.
 *
 * What does NOT change, deliberately, because merchants verify these to
 * release goods:
 *
 * - The body. Senders build exactly the JSON they always built; the hub sends
 *   that string as-is. It is NOT wrapped in a CloudEvent (no `specversion`,
 *   `source`, `time` keys added; `created_at`/`business_id` kept).
 * - `X-CoinPay-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`, keyed with
 *   the business's plaintext secret as UTF-8 bytes — built here by
 *   `signWebhookBody`, the same function the old sender used. The package's
 *   `tV1Header` is NOT used: it runs the secret through `secretToKey`, which
 *   base64-decodes anything starting with `whsec_` (two live businesses have
 *   such secrets), so it would silently sign with different key bytes.
 * - `Content-Type: application/json` (the package would send
 *   application/cloudevents+json, which express.json() and similar parsers
 *   ignore, so the SDK's createWebhookHandler would see an empty body) and
 *   `User-Agent: CoinPay-Webhook/1.0`.
 * - The URL and secret: the business webhook is not copied into the hub. It is
 *   the virtual endpoint `biz_<business id>`, read live from `businesses` on
 *   every attempt, so a URL change or secret rotation in settings applies to
 *   queued retries too (as the old queue did).
 * - Transport: requests go through `safeFetch`, the existing SSRF boundary,
 *   which also keeps following (re-validated) redirects the way the old sender
 *   did. The package's own fetch refuses every 3xx.
 * - No auto-disable: a business webhook was never switched off for failing.
 *
 * Added alongside: the Standard Webhooks headers (`webhook-id`, stable across
 * retries; `webhook-timestamp`; `webhook-signature`) and `webhook-event`.
 *
 * Merchants can also add extra endpoints through /api/v1/webhooks. Those are
 * ordinary hub endpoints and receive CloudEvents (Standard Webhooks) — they are
 * new, so nobody depends on an older shape there.
 *
 * Kill switch: WEBHOOKS_HUB=off sends through the old direct path again.
 */
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { Webhooks, WebhookError } from '@profullstack/webhooks';
import type { Delivery, Endpoint, PublicDelivery, PublicEndpoint, WebhookStore } from '@profullstack/webhooks';
import { safeFetch } from '@/lib/security/ssrf';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { decrypt, deriveKey, encrypt } from '@/lib/crypto/encryption';
import { requireEncryptionKey } from '@/lib/crypto/require-key';
import { resolveWebhookSecret } from './secret';
import { supabaseStore, type SupabaseLike } from './supabase-store';

/** Off only when explicitly switched off. */
export function webhooksHubEnabled(): boolean {
  return (process.env.WEBHOOKS_HUB ?? '').toLowerCase() !== 'off';
}

/** The legacy signature header, exactly as CoinPay has always sent it. */
export const COINPAY_SIGNATURE_HEADER = 'x-coinpay-signature';
export const COINPAY_USER_AGENT = 'CoinPay-Webhook/1.0';

/**
 * `t=<unix>,v1=<hex HMAC-SHA256("<t>.<body>")>` keyed with `secret` as UTF-8.
 * The one implementation of CoinPay's wire signature; signWebhookPayload in
 * service.ts calls this too.
 */
export function signWebhookBody(body: string, secret: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${signature}`;
}

/** Every event CoinPay emits, for endpoint subscriptions. */
export const COINPAY_EVENT_TYPES = [
  'payment.confirmed',
  'payment.forwarded',
  'payment.expired',
  'payment.failed',
  'payment.disputed',
  'payment.dispute_resolved',
  'escrow.created',
  'escrow.funded',
  'escrow.released',
  'escrow.settled',
  'escrow.disputed',
  'escrow.resolved',
  'escrow.refunded',
  'escrow.expired',
  'invoice.paid',
  'invoice.payment_returned',
  'business_collection.forwarded',
  'lightning.payment.settled',
];

/**
 * Wait before attempt 2, 3, ...
 *
 * The old schedule was 3 in-process attempts (0, +1 s, +2 s), then the cron
 * queue at +1, +5, +15, +60, +180, +360, +720, +720 minutes: 11 attempts over
 * about 34 hours, and only for payment events (escrow and monitor events got
 * one attempt, business collection three). This keeps the same opening and then
 * keeps going: 13 attempts over about 4.4 days, for every event.
 */
export const RETRY_BACKOFF_MS = [
  1_000,
  2_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
  48 * 3_600_000,
];

/** Same per-request timeout the old sender used. */
export const DELIVERY_TIMEOUT_MS = 30_000;

/** How long an inline attempt holds its row before a drainer may take it. */
const INLINE_LEASE_MS = 5 * 60_000;

export const BUSINESS_ENDPOINT_PREFIX = 'biz_';
export const businessEndpointId = (businessId: string) => `${BUSINESS_ENDPOINT_PREFIX}${businessId}`;
export const isBusinessEndpointId = (id: string) => id.startsWith(BUSINESS_ENDPOINT_PREFIX);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- secrets ---------------------------------------------------------------

// The hub stores an endpoint's secret opaquely and asks the secretBox to open
// it. Two kinds pass through here:
//   cpbiz:<merchant id>:<businesses.webhook_secret>  the business webhook, opened
//       with the existing per-merchant decryption (resolveWebhookSecret), so its
//       plaintext is exactly what the old sender signed with;
//   cphub:<ciphertext>  a /api/v1/webhooks endpoint's whsec_ secret, AES-GCM
//       under a key derived from ENCRYPTION_KEY.
const BIZ_TAG = 'cpbiz:';
const HUB_TAG = 'cphub:';

let hubKey: string | null = null;
function hubSecretKey(): string {
  if (!hubKey) hubKey = deriveKey(requireEncryptionKey('webhook secret'), 'webhooks-hub');
  return hubKey;
}

export const secretBox = {
  seal(secret: string): string {
    return `${HUB_TAG}${encrypt(secret, hubSecretKey())}`;
  },
  open(sealed: string): string {
    if (sealed.startsWith(BIZ_TAG)) {
      const rest = sealed.slice(BIZ_TAG.length);
      const i = rest.indexOf(':');
      const merchantId = rest.slice(0, i);
      return resolveWebhookSecret(rest.slice(i + 1), merchantId || null);
    }
    if (sealed.startsWith(HUB_TAG)) return decrypt(sealed.slice(HUB_TAG.length), hubSecretKey());
    return sealed;
  },
};

// ---- store -----------------------------------------------------------------

/**
 * The hub store: hub_ tables for the outbox and for extra endpoints, plus the
 * business's own webhook as the read-only virtual endpoint `biz_<id>`.
 *
 * `listEndpoints` deliberately does NOT include the virtual endpoint: `emit`
 * fans a CloudEvent out to listed endpoints, and the business URL must only
 * ever get the legacy body.
 */
export function coinpayStore(client: SupabaseLike): WebhookStore {
  const base = supabaseStore(client);

  async function businessEndpoint(businessId: string): Promise<Endpoint | null> {
    if (!UUID.test(businessId)) return null;
    const { data, error } = await client
      .from('businesses')
      .select('webhook_url, webhook_secret, merchant_id')
      .eq('id', businessId)
      .maybeSingle();
    if (error) throw new Error(`webhooks store: business ${businessId}: ${error.message}`);
    if (!data?.webhook_url || !data?.webhook_secret) return null;
    return {
      id: businessEndpointId(businessId),
      owner: businessId,
      url: String(data.webhook_url),
      secret: `${BIZ_TAG}${data.merchant_id ?? ''}:${data.webhook_secret}`,
      events: ['*'],
      description: 'Business webhook (managed in business settings)',
      enabled: true,
      failures: 0,
      disabledReason: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  const readOnly = () => new WebhookError('the business webhook is managed in business settings', 409);

  return {
    ...base,
    async getEndpoint(id) {
      return isBusinessEndpointId(id) ? businessEndpoint(id.slice(BUSINESS_ENDPOINT_PREFIX.length)) : base.getEndpoint(id);
    },
    async insertEndpoint(e) {
      if (isBusinessEndpointId(e.id)) throw readOnly();
      return base.insertEndpoint(e);
    },
    async updateEndpoint(id, patch) {
      if (!isBusinessEndpointId(id)) return base.updateEndpoint(id, patch);
      // The hub bumps failure counters after each attempt; there is nowhere to
      // keep them for the business webhook and nothing reads them (it is never
      // auto-disabled). Anything else is a settings change and belongs there.
      const other = Object.keys(patch).filter((k) => k !== 'failures' && k !== 'updatedAt');
      if (other.length) throw readOnly();
    },
    async deleteEndpoint(id) {
      if (isBusinessEndpointId(id)) throw readOnly();
      return base.deleteEndpoint(id);
    },
  };
}

// ---- transport -------------------------------------------------------------

/** fetch through safeFetch: SSRF checks on every hop, redirects followed as before. */
export const safeFetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const r = await safeFetch(String(input), {
    method: init?.method ?? 'POST',
    headers: init?.headers,
    body: init?.body,
    timeoutMs: DELIVERY_TIMEOUT_MS,
  });
  if (!r.ok) throw new Error(r.kind === 'blocked' ? `Refused: ${r.reason}` : r.reason);
  return r.response;
}) as typeof fetch;

/** The headers CoinPay receivers already check, next to the Standard Webhooks ones. */
export function legacyHeaders({ body, secret, endpoint }: { body: string; secret: string; endpoint: PublicEndpoint }) {
  const headers: Record<string, string> = { [COINPAY_SIGNATURE_HEADER]: signWebhookBody(body, secret) };
  if (isBusinessEndpointId(endpoint.id)) {
    // Lower-case keys: they replace the package's own content-type/user-agent
    // instead of being appended next to them.
    headers['content-type'] = 'application/json';
    headers['user-agent'] = COINPAY_USER_AGENT;
  }
  return headers;
}

// ---- delivery log ----------------------------------------------------------

function parse(s: string | undefined): any {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** One webhook_logs row per hub attempt (the table the dashboard shows). */
async function logAttempt(
  client: SupabaseLike,
  store: WebhookStore,
  info: { delivery: PublicDelivery; endpoint: PublicEndpoint; ok: boolean }
) {
  const full = await store.getDelivery(info.delivery.id);
  if (!full || !UUID.test(full.owner)) return;
  const body = parse(full.payload);
  const data = body?.data && typeof body.data === 'object' ? body.data : body;
  const isEscrow = full.eventType.startsWith('escrow.');
  const paymentId = !isEscrow && typeof data?.payment_id === 'string' && UUID.test(data.payment_id) ? data.payment_id : null;
  const escrowId = isEscrow && typeof data?.escrow_id === 'string' && UUID.test(data.escrow_id) ? data.escrow_id : null;
  const row = {
    id: randomUUID(),
    business_id: full.owner,
    payment_id: paymentId,
    escrow_id: escrowId,
    event: full.eventType,
    url: info.endpoint.url,
    webhook_url: info.endpoint.url,
    payload: body ?? {},
    success: info.ok,
    status_code: info.delivery.last_status ?? undefined,
    response_status: info.delivery.last_status ?? undefined,
    error_message: info.ok ? undefined : info.delivery.last_error ?? undefined,
    attempt_number: info.delivery.attempts,
    attempt: info.delivery.attempts,
    created_at: new Date().toISOString(),
  };
  let { error } = await client.from('webhook_logs').insert(row);
  // payment_id references payments(id); invoice, PayPal and Lightning events
  // carry other ids there. Keep the row rather than lose it.
  if (error && /foreign key/i.test(error.message) && row.payment_id) {
    ({ error } = await client.from('webhook_logs').insert({ ...row, payment_id: null }));
  }
  if (error) console.error('[Webhook] Could not record delivery attempt:', error.message);
}

// ---- the hub ---------------------------------------------------------------

export interface CoinpayHub {
  hooks: Webhooks;
  store: WebhookStore;
}

export function createCoinpayHub({
  client,
  fetchImpl = safeFetchImpl,
  now,
}: {
  client: SupabaseLike;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): CoinpayHub {
  const store = coinpayStore(client);
  const hooks = new Webhooks({
    store,
    source: process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com',
    eventTypes: COINPAY_EVENT_TYPES,
    backoffMs: RETRY_BACKOFF_MS,
    disableAfter: Number.POSITIVE_INFINITY,
    timeoutMs: DELIVERY_TIMEOUT_MS,
    // safeFetch (fetchImpl) is the SSRF boundary, exactly as before: it resolves
    // the host and re-validates every redirect hop. The package's pre-check is
    // relaxed so it cannot refuse a URL the old sender delivered to.
    guard: { allowPrivate: true, allowHttp: process.env.NODE_ENV !== 'production' },
    fetchImpl,
    secretBox,
    extraHeaders: legacyHeaders,
    onDelivery: (info) => logAttempt(client, store, info).catch((e) => console.error('[Webhook] log failed:', e)),
    log: (m) => console.log(`[Webhooks hub] ${m}`),
    ...(now ? { now } : {}),
  });
  return { hooks, store };
}

const g = globalThis as { __coinpayWebhooksHub?: CoinpayHub };

/** The process-wide hub on the service-role client. */
export function getWebhooksHub(): CoinpayHub {
  if (!g.__coinpayWebhooksHub) {
    g.__coinpayWebhooksHub = createCoinpayHub({ client: getSupabaseAdmin() as unknown as SupabaseLike });
  }
  return g.__coinpayWebhooksHub;
}

/** Start the background drainer once per process (instrumentation.ts). */
export function startWebhooksHub(): void {
  getWebhooksHub().hooks.start({ intervalMs: 5_000, keepDays: 90 });
}

export interface QueueBusinessWebhookInput {
  businessId: string;
  event: string;
  /** The exact body the business receives, as the old sender built it. */
  payload: Record<string, unknown>;
  /** CloudEvents subject for /api/v1/webhooks endpoints, e.g. "payment:<id>". */
  subject?: string;
}

export interface QueueResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

/**
 * Send a business webhook through the hub: record it durably, attempt it now,
 * leave any retries to the drainer. Also fans the event out (as a CloudEvent)
 * to endpoints made through /api/v1/webhooks.
 *
 * Returns null if the hub could not take the delivery at all (tables missing,
 * database down) — the caller then sends the old way, so a hub problem can
 * never cost a merchant a webhook. Once the row is written it never returns
 * null, so nothing is sent twice.
 */
export async function queueBusinessWebhook(
  input: QueueBusinessWebhookInput,
  hub: CoinpayHub = getWebhooksHub()
): Promise<QueueResult | null> {
  const { hooks, store } = hub;
  const endpointId = businessEndpointId(input.businessId);
  let endpoint: Endpoint | null;
  let delivery: Delivery;
  try {
    endpoint = await store.getEndpoint(endpointId);
    if (!endpoint) return { success: true }; // no webhook configured: same as before
    const at = Date.now();
    const id = `dlv_${randomBytes(12).toString('base64url')}`;
    delivery = {
      id,
      endpointId,
      owner: input.businessId,
      eventId: typeof input.payload.id === 'string' && input.payload.id ? input.payload.id : id,
      eventType: input.event,
      payload: JSON.stringify(input.payload),
      status: 'pending',
      attempts: 0,
      // Held for the inline attempt below; the drainer takes it only if this
      // process dies before recording the result.
      nextAt: at + INLINE_LEASE_MS,
      lastStatus: null,
      lastError: null,
      createdAt: at,
      updatedAt: at,
    };
    await store.insertDeliveries([delivery]);
  } catch (err) {
    console.error('[Webhook] hub unavailable, sending directly:', err instanceof Error ? err.message : err);
    return null;
  }

  // Endpoints added through /api/v1/webhooks get a CloudEvent. Never the business URL (see coinpayStore).
  try {
    const data = input.payload.data && typeof input.payload.data === 'object' ? input.payload.data : input.payload;
    await hooks.emit(input.businessId, input.event, data, input.subject ? { subject: input.subject } : {});
  } catch (err) {
    console.error('[Webhook] hub emit failed:', err instanceof Error ? err.message : err);
  }

  try {
    // The package's single-attempt step (record result, schedule the next try).
    const attempt = (hooks as unknown as {
      attempt(e: Endpoint, d: Delivery): Promise<{ ok: boolean; status: number | null; error?: string }>;
    }).attempt.bind(hooks);
    const r = await attempt(endpoint, delivery);
    return { success: r.ok, statusCode: r.status ?? undefined, error: r.ok ? undefined : r.error ?? `HTTP ${r.status}` };
  } catch (err) {
    // The row stays pending; the drainer retries it when the lease runs out.
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}
