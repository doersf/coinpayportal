/**
 * /api/v1/webhooks — the @profullstack/webhooks API for a business.
 *
 *   GET    /api/v1/webhooks                       endpoints + event types
 *   POST   /api/v1/webhooks                       { url, events?, description? } -> { endpoint, secret }
 *   GET    /api/v1/webhooks/:id                   PATCH, DELETE
 *   GET    /api/v1/webhooks/:id/secret            POST /:id/rotate, POST /:id/test
 *   GET    /api/v1/webhooks/:id/deliveries        GET /deliveries, POST /deliveries/:id/retry
 *
 * Endpoints made here are extra, Standard Webhooks (CloudEvents) receivers.
 * The business's own webhook (URL + secret in business settings, legacy body
 * and X-CoinPay-Signature) is unchanged and keeps being managed there; it shows
 * up here only as `biz_<business id>` in the delivery log, read-only.
 *
 * Authenticated with the business API key (Authorization: Bearer, or
 * x-api-key). Managing webhooks is not one of the scoped-key scopes, so it
 * needs a full-access key, like the business settings it sits next to.
 */
import { NextRequest, NextResponse } from 'next/server';
import { webhooksApi } from '@profullstack/webhooks';
import { authenticateRequest } from '@/lib/auth/middleware';
import { WILDCARD_SCOPE } from '@/lib/auth/scoped-keys';
import { getSupabaseAdmin } from '@/lib/supabase/server';
import { getWebhooksHub, isBusinessEndpointId } from '@/lib/webhooks/hub';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE = '/api/v1/webhooks';

async function businessFrom(req: Request): Promise<string | null> {
  const header = req.headers.get('authorization') ?? (req.headers.get('x-api-key') ? `Bearer ${req.headers.get('x-api-key')}` : null);
  if (!header) return null;
  const auth = await authenticateRequest(getSupabaseAdmin(), header);
  if (!auth.success || auth.context?.type !== 'business') return null;
  if (!auth.context.scopes.includes(WILDCARD_SCOPE)) return null;
  return auth.context.businessId;
}

async function handle(req: NextRequest): Promise<Response> {
  const parts = new URL(req.url).pathname.slice(BASE.length).split('/').filter(Boolean);
  // The business webhook is read-only here: GET it, or its deliveries.
  if (parts[0] && isBusinessEndpointId(parts[0])) {
    const readable = req.method === 'GET' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'deliveries'));
    if (!readable) {
      if (!(await businessFrom(req))) return NextResponse.json({ error: 'sign in or send an API key' }, { status: 401 });
      return NextResponse.json({ error: 'the business webhook is managed in business settings (/api/businesses/:id)' }, { status: 409 });
    }
  }
  try {
    const api = webhooksApi(getWebhooksHub().hooks, { basePath: BASE, owner: businessFrom });
    return (await api(req)) ?? NextResponse.json({ error: 'not found' }, { status: 404 });
  } catch (err) {
    console.error('[api/v1/webhooks]', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
