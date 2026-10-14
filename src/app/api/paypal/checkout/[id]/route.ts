/**
 * GET /api/paypal/checkout/:id — public config for the hosted PayPal button page.
 *
 * Public on purpose, like the capture route: the transaction id is an
 * unguessable UUID the merchant hands to its payer, and the response carries
 * only what PayPal's JS SDK needs in the browser (never a secret).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getPublicPaypalCheckout } from '@/lib/paypal/public-checkout';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) {
    return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return NextResponse.json({ success: false, error: 'Server not configured' }, { status: 500 });
  }

  const result = await getPublicPaypalCheckout(createClient(url, key), id);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ success: true, checkout: result.checkout });
}
