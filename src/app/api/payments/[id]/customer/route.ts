import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateRequest, isBusinessAuth, isMerchantAuth } from '@/lib/auth/middleware';
import { verifyBusinessAccess } from '@/lib/wallets/supported-coins';

/**
 * GET /api/payments/:id/customer
 *
 * Who paid and for which property, for the merchant's dashboard. The public
 * GET /api/payments/:id deliberately leaves these out; this one requires the
 * merchant's session (with access to the business) or the business API key.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const auth = await authenticateRequest(supabase, request.headers.get('authorization'));
    if (!auth.success || !auth.context) {
      return NextResponse.json({ success: false, error: auth.error || 'Authentication required' }, { status: 401 });
    }

    const { data: payment } = await supabase
      .from('payments')
      .select('id, business_id, metadata')
      .eq('id', id)
      .maybeSingle();
    if (!payment) return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 });

    let allowed = false;
    if (isBusinessAuth(auth.context)) allowed = auth.context.businessId === payment.business_id;
    else if (isMerchantAuth(auth.context)) {
      allowed = (await verifyBusinessAccess(supabase, payment.business_id, auth.context.merchantId)).ok;
    }
    if (!allowed) return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 });

    const m = (payment.metadata ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof m[k] === 'string' && m[k] ? (m[k] as string) : null);
    return NextResponse.json({
      success: true,
      customer: {
        customer_email: s('customer_email'),
        account_id: s('account_id'),
        property: s('property'),
        checkout_session_id: s('checkout_session_id'),
      },
    });
  } catch (err) {
    console.error('[Payments] customer lookup error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
