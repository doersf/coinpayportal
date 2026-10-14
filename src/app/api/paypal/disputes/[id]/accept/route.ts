import { NextRequest, NextResponse } from 'next/server';
import { acceptPaypalClaim } from '@/lib/paypal/disputes';
import { authorizeDisputeRequest, disputeErrorResponse } from '@/lib/paypal/dispute-route';

/**
 * POST /api/paypal/disputes/:id/accept — accept the buyer's claim. PayPal
 * refunds the buyer from the merchant's balance, so this is owner-only
 * (`funds.move`), like a refund. Body: `{ business_id, note? }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const auth = await authorizeDisputeRequest(request, body?.business_id, 'funds.move');
  if (!auth.ok) return auth.response;
  const note = typeof body?.note === 'string' && body.note.trim() ? body.note.trim() : 'Claim accepted by the merchant.';
  try {
    await acceptPaypalClaim(auth.paypal, id, note);
    return NextResponse.json({ success: true });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
