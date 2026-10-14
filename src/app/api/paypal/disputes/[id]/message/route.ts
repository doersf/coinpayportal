import { NextRequest, NextResponse } from 'next/server';
import { sendPaypalDisputeMessage } from '@/lib/paypal/disputes';
import { authorizeDisputeRequest, disputeErrorResponse } from '@/lib/paypal/dispute-route';

/** POST /api/paypal/disputes/:id/message — message the buyer. Body: `{ business_id, message }`. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const auth = await authorizeDisputeRequest(request, body?.business_id, 'billing.manage');
  if (!auth.ok) return auth.response;
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message) return NextResponse.json({ success: false, error: 'message is required' }, { status: 400 });
  try {
    await sendPaypalDisputeMessage(auth.paypal, id, message);
    return NextResponse.json({ success: true });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
