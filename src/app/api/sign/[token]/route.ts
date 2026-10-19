import { NextRequest } from 'next/server';
import { serviceClient } from '@/lib/invoices/catalog';
import { fail, json, readJson, requestMeta } from '@/lib/documents/service';
import { loadSigningView, runSignAction } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ token: string }> };

export const dynamic = 'force-dynamic';

const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/** GET /api/sign/[token] — what the recipient's page shows (never the key; that is in their link). */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const view = await loadSigningView(serviceClient(), token, requestMeta(request));
  if (!view.ok) return fail(view.error, view.status);
  const res = json({ success: true, ...view.data });
  for (const [k, v] of Object.entries(noStore)) res.headers.set(k, v);
  return res;
}

/**
 * POST /api/sign/[token]
 * { action: 'sign', signature_name, signature_image?, document_sha256, consent: true } | { action: 'decline', reason }
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const result = await runSignAction(serviceClient(), token, body, requestMeta(request));
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data });
}
