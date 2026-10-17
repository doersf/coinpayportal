import { NextRequest } from 'next/server';
import { serviceClient } from '@/lib/invoices/catalog';
import { fail, json, readJson } from '@/lib/contractors/service';
import { loadContractorPortal, runPortalAction } from '@/lib/contractors/portal';

type Ctx = { params: Promise<{ token: string }> };

const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

/** GET /api/contractor-portal/[token]: the contractor's own view. */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const portal = await loadContractorPortal(serviceClient(), token);
  if (!portal) return fail('This portal link is no longer valid', 404);
  const res = json({ success: true, ...portal });
  for (const [k, v] of Object.entries(noStore)) res.headers.set(k, v);
  return res;
}

/**
 * POST /api/contractor-portal/[token] { action, ... }
 * Actions: payout, tax_form, sign, hours, milestone, expense, withdraw.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const result = await runPortalAction(serviceClient(), token, body);
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true });
}
