import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateRequest, isBusinessAuth, isMerchantAuth } from '@/lib/auth/middleware';
import { verifyBusinessAccess } from '@/lib/wallets/supported-coins';
import {
  eligibleMethods,
  loadSession,
  refreshSessionStatus,
  resolvedSuccessUrl,
  sessionReturnUrl,
  PAYPAL_METHOD,
} from '@/lib/checkout/sessions';

/**
 * GET /api/checkout/sessions/:id
 *
 * Public: what the hosted page needs (amount, description, property, the
 * methods to offer, status, where to go next). The payer's email and account
 * id are NOT in the public view. With the business's API key (or a merchant
 * session with access) the response also carries the customer fields,
 * metadata and the underlying payment references, so a site can poll it.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const found = await loadSession(supabase, id);
    if (!found) {
      return NextResponse.json({ success: false, error: 'Checkout session not found' }, { status: 404 });
    }
    const session = await refreshSessionStatus(supabase, found);

    const { data: business } = await supabase
      .from('businesses')
      .select('name')
      .eq('id', session.business_id)
      .maybeSingle();

    const methods = session.status === 'open' ? await eligibleMethods(supabase, session) : [];
    const base = process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com';

    const current =
      session.status === 'open' && session.selected_method
        ? {
            method: session.selected_method,
            payment_id: session.payment_id,
            ...(session.selected_method !== PAYPAL_METHOD && session.payment_id
              ? { pay_url: `${base}/pay/${session.payment_id}` }
              : {}),
          }
        : null;

    const view: Record<string, unknown> = {
      id: session.id,
      object: 'checkout.session',
      status: session.status,
      amount: Number(session.amount),
      currency: session.currency,
      description: session.description,
      property: session.property,
      merchant_name: business?.name ?? null,
      expires_at: session.expires_at,
      methods,
      current,
      success_url: session.status === 'paid' ? resolvedSuccessUrl(session) : null,
      cancel_url: sessionReturnUrl(session.cancel_url, session.id),
      paid_at: session.paid_at,
      paid_method: session.paid_method,
    };

    // Owner view.
    const authHeader = request.headers.get('authorization');
    if (authHeader) {
      const auth = await authenticateRequest(supabase, authHeader);
      let allowed = false;
      if (auth.success && auth.context) {
        if (isBusinessAuth(auth.context)) allowed = auth.context.businessId === session.business_id;
        else if (isMerchantAuth(auth.context)) {
          allowed = (await verifyBusinessAccess(supabase, session.business_id, auth.context.merchantId)).ok;
        }
      }
      if (allowed) {
        Object.assign(view, {
          business_id: session.business_id,
          customer_email: session.customer_email,
          account_id: session.account_id,
          metadata: session.metadata,
          success_url_template: session.success_url,
          selected_method: session.selected_method,
          payment_id: session.payment_id,
          paypal_transaction_id: session.paypal_transaction_id,
          paid_reference: session.paid_reference,
          attempt_count: session.attempt_count,
          created_at: session.created_at,
        });
      }
    }

    return NextResponse.json(
      { success: true, session: view },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('[Checkout] get session error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
