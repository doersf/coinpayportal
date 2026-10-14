import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { verifyToken } from '@/lib/auth/jwt';
import { authorizeBusinessOwner } from '@/lib/auth/authz';
import type { Capability } from '@/lib/auth/permissions';
import { getJwtSecret } from '@/lib/secrets';
import { resolvePaypalContext } from './accounts';
import type { DisputeCallParams } from './disputes';

/**
 * Shared front half of every PayPal dispute route: a dashboard JWT, the
 * caller's capability on the business, and that business's PayPal context.
 * Reading and answering a dispute needs `billing.manage` (as on the Stripe
 * rail); accepting a claim refunds the buyer, so it needs `funds.move`.
 */
export async function authorizeDisputeRequest(
  request: NextRequest,
  businessId: string | null | undefined,
  capability: Capability
): Promise<{ ok: true; supabase: SupabaseClient; paypal: DisputeCallParams } | { ok: false; response: NextResponse }> {
  const fail = (status: number, error: string) => ({
    ok: false as const,
    response: NextResponse.json({ success: false, error }, { status }),
  });

  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) return fail(401, 'Missing authorization header');
  const jwtSecret = getJwtSecret();
  if (!jwtSecret) return fail(500, 'Server configuration error');

  let decoded: { userId: string };
  try {
    decoded = verifyToken(authHeader.substring(7), jwtSecret) as { userId: string };
  } catch {
    return fail(401, 'Invalid or expired token');
  }

  if (!businessId) return fail(400, 'business_id is required');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return fail(500, 'Server configuration error');
  const supabase = createClient(url, key);

  const authz = await authorizeBusinessOwner(supabase, decoded.userId, businessId, capability);
  if (!authz.ok) return fail(authz.status, authz.status === 404 ? 'Business not found' : authz.error);

  const context = await resolvePaypalContext(supabase, businessId);
  if ('error' in context) return fail(context.status, context.error);

  return { ok: true, supabase, paypal: { ...context.creds, ...context.callContext } };
}

/** PayPal's 404 means "not this merchant's dispute"; anything else is upstream. */
export function disputeErrorResponse(error: unknown): NextResponse {
  const status = (error as { status?: number })?.status;
  if (status === 404) {
    return NextResponse.json({ success: false, error: 'Dispute not found' }, { status: 404 });
  }
  if (status === 422 || status === 400) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'PayPal rejected the request' },
      { status: 422 }
    );
  }
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : 'PayPal request failed' },
    { status: 502 }
  );
}
