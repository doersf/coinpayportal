import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authenticateRequest, isBusinessAuth, isMerchantAuth, hasScope } from '@/lib/auth/middleware';
import { verifyBusinessAccess } from '@/lib/wallets/supported-coins';
import {
  generateSessionId,
  validateCreateSessionInput,
  eligibleMethods,
} from '@/lib/checkout/sessions';

/**
 * POST /api/checkout/sessions
 *
 * Create a hosted checkout session. The site redirects the buyer to the
 * returned `url`, where they choose any coin this business can receive (or
 * PayPal). Auth: the business API key as `Authorization: Bearer cp_live_...`,
 * the same as /api/payments/create. A merchant session token also works with
 * an explicit business_id.
 */
export async function POST(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json({ success: false, error: 'Server configuration error' }, { status: 500 });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    const auth = await authenticateRequest(supabase, request.headers.get('authorization'));
    if (!auth.success || !auth.context) {
      return NextResponse.json({ success: false, error: auth.error || 'Authentication required' }, { status: 401 });
    }
    if (!hasScope(auth.context, 'payments:create')) {
      return NextResponse.json(
        { success: false, error: 'API key missing required scope: payments:create' },
        { status: 403 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: 'Request body must be JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ success: false, error: 'Request body must be a JSON object' }, { status: 400 });
    }

    let businessId: string;
    let merchantId: string;
    if (isBusinessAuth(auth.context)) {
      businessId = auth.context.businessId;
      merchantId = auth.context.merchantId;
      if (body.business_id && body.business_id !== businessId) {
        return NextResponse.json({ success: false, error: 'business_id does not match API key scope' }, { status: 403 });
      }
    } else if (isMerchantAuth(auth.context)) {
      merchantId = auth.context.merchantId;
      if (typeof body.business_id !== 'string' || !body.business_id) {
        return NextResponse.json({ success: false, error: 'business_id is required' }, { status: 400 });
      }
      businessId = body.business_id;
      const access = await verifyBusinessAccess(supabase, businessId, merchantId);
      if (!access.ok) {
        return NextResponse.json({ success: false, error: access.error }, { status: access.status ?? 404 });
      }
    } else {
      return NextResponse.json({ success: false, error: 'Invalid authentication context' }, { status: 401 });
    }

    const { data: business } = await supabase
      .from('businesses')
      .select('id, name, merchant_id')
      .eq('id', businessId)
      .maybeSingle();
    if (!business) {
      return NextResponse.json({ success: false, error: 'Business not found' }, { status: 404 });
    }

    const parsed = validateCreateSessionInput(body, { businessName: business.name });
    if (!parsed.ok) {
      return NextResponse.json({ success: false, error: parsed.error, code: parsed.code }, { status: 400 });
    }
    const input = parsed.value;

    // The business owner's wallets decide which coins are offered; a teammate
    // creating a session does not change that.
    const ownerId = (business.merchant_id as string) || merchantId;

    // Refuse a session nobody could pay rather than hand the buyer an empty picker.
    const methods = await eligibleMethods(supabase, {
      business_id: businessId,
      merchant_id: ownerId,
      allowed_methods: input.allowed_methods,
    });
    if (methods.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'No payment method is available: add a wallet for at least one coin (or connect PayPal) for this business',
          code: 'NO_PAYMENT_METHODS',
        },
        { status: 400 }
      );
    }

    const id = generateSessionId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expires_in_minutes * 60_000);
    const { error } = await supabase.from('checkout_sessions').insert({
      id,
      business_id: businessId,
      merchant_id: ownerId,
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      customer_email: input.customer_email,
      account_id: input.account_id,
      property: input.property,
      metadata: input.metadata,
      success_url: input.success_url,
      cancel_url: input.cancel_url,
      allowed_methods: input.allowed_methods,
      expires_in_minutes: input.expires_in_minutes,
      status: 'open',
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    if (error) {
      console.error('[Checkout] session insert failed:', error);
      return NextResponse.json({ success: false, error: 'Failed to create checkout session' }, { status: 500 });
    }

    const base = process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com';
    return NextResponse.json(
      {
        success: true,
        id,
        url: `${base}/checkout/${id}`,
        status: 'open',
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        customer_email: input.customer_email,
        account_id: input.account_id,
        property: input.property,
        metadata: input.metadata,
        success_url: input.success_url,
        cancel_url: input.cancel_url,
        expires_at: expiresAt.toISOString(),
        methods: methods.map((m) => m.code),
      },
      { status: 201 }
    );
  } catch (err) {
    console.error('[Checkout] create session error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
