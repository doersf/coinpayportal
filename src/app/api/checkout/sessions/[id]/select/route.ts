import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getClientIp } from '@/lib/web-wallet/client-ip';
import { loadSession, refreshSessionStatus, selectCheckoutMethod } from '@/lib/checkout/sessions';

/**
 * POST /api/checkout/sessions/:id/select  { "method": "USDC_POL" | "BTC" | ... | "PAYPAL" }
 *
 * Public (the session id is the capability). Creates the underlying payment
 * with the session's customer fields in its metadata and answers with where
 * to send the buyer: /pay/<paymentId> for a coin, PayPal's approve URL for
 * PayPal. Picking a different method later starts a new payment.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    const found = await loadSession(supabase, id);
    if (!found) {
      return NextResponse.json({ success: false, error: 'Checkout session not found' }, { status: 404 });
    }
    const session = await refreshSessionStatus(supabase, found);

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // handled below as a missing method
    }

    const result = await selectCheckoutMethod(supabase, session, body?.method, { clientIp: getClientIp(request) });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error, ...(result.code ? { code: result.code } : {}) },
        { status: result.status }
      );
    }
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error('[Checkout] select method error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
