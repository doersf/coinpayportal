import { NextRequest, NextResponse } from 'next/server';
import { listPaypalDisputes } from '@/lib/paypal/disputes';
import { authorizeDisputeRequest, disputeErrorResponse } from '@/lib/paypal/dispute-route';

/**
 * GET /api/paypal/disputes?business_id= — the business's PayPal disputes, read
 * live from PayPal (the analogue of GET /api/stripe/disputes).
 */
export async function GET(request: NextRequest) {
  const businessId = request.nextUrl.searchParams.get('business_id');
  const auth = await authorizeDisputeRequest(request, businessId, 'billing.manage');
  if (!auth.ok) return auth.response;

  try {
    const disputes = await listPaypalDisputes(auth.paypal);
    // Link each dispute to the CoinPay transaction it reverses, when we have it.
    const captureIds = disputes.map((d) => d.sellerTransactionId).filter(Boolean) as string[];
    const byCapture = new Map<string, { id: string; invoice_number: string | null }>();
    if (captureIds.length) {
      const { data } = await auth.supabase
        .from('paypal_transactions')
        .select('id, invoice_number, paypal_capture_id')
        .eq('business_id', businessId)
        .in('paypal_capture_id', captureIds);
      for (const row of data ?? []) byCapture.set(row.paypal_capture_id, row);
    }
    return NextResponse.json({
      success: true,
      disputes: disputes.map((d) => {
        const tx = d.sellerTransactionId ? byCapture.get(d.sellerTransactionId) : undefined;
        return { ...d, transactionId: tx?.id ?? null, invoiceNumber: tx?.invoice_number ?? null };
      }),
    });
  } catch (error) {
    return disputeErrorResponse(error);
  }
}
