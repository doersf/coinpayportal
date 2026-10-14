import { NextRequest, NextResponse } from 'next/server';
import { providePaypalDisputeEvidence } from '@/lib/paypal/disputes';
import { authorizeDisputeRequest, disputeErrorResponse } from '@/lib/paypal/dispute-route';

/**
 * POST /api/paypal/disputes/:id/evidence — written evidence for PayPal's
 * review. Body: `{ business_id, notes, tracking_number?, carrier? }`.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const auth = await authorizeDisputeRequest(request, body?.business_id, 'billing.manage');
  if (!auth.ok) return auth.response;
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
  if (notes.length < 10) {
    return NextResponse.json({ success: false, error: 'Describe your evidence (at least 10 characters)' }, { status: 400 });
  }
  try {
    await providePaypalDisputeEvidence(auth.paypal, id, {
      notes,
      trackingNumber: typeof body?.tracking_number === 'string' ? body.tracking_number.trim() : null,
      carrier: typeof body?.carrier === 'string' ? body.carrier.trim() : null,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
