import { NextRequest, NextResponse } from 'next/server';
import { getPaypalDispute } from '@/lib/paypal/disputes';
import { authorizeDisputeRequest, disputeErrorResponse } from '@/lib/paypal/dispute-route';

/** GET /api/paypal/disputes/:id?business_id= — one dispute with its messages. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await authorizeDisputeRequest(request, request.nextUrl.searchParams.get('business_id'), 'billing.manage');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ success: true, dispute: await getPaypalDispute(auth.paypal, id) });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
