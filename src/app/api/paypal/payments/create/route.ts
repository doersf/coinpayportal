import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { authorizePaymentCreation } from '@/lib/auth/payment-auth';
import { getClientIp } from '@/lib/web-wallet/client-ip';
import { createPaypalPaymentForBusiness } from '@/lib/paypal/create-payment';
import { customerMetadata } from '@/lib/checkout/customer';

function getSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Resolve the requested amount into major units.
 *
 * MONEY UNITS, read this before changing anything here. The Stripe rail takes
 * `amount` in MINOR units (cents) because that is Stripe's API. PayPal's API is
 * decimal-string MAJOR units. An integration that switches rails and reposts the
 * same body would otherwise be charged 100x or 1/100th with no error anywhere.
 *
 * So: `amount_cents` is explicit and wins. Bare `amount` is MAJOR units, which
 * matches PayPal and matches what `paypal_transactions.amount` stores. Passing
 * both is a caller bug and is rejected rather than guessed at.
 */
function resolveAmount(body: any): { amount: number } | { error: string } {
  const hasCents = body.amount_cents !== undefined && body.amount_cents !== null;
  const hasMajor = body.amount !== undefined && body.amount !== null;

  if (hasCents && hasMajor) {
    return { error: 'Pass either amount (major units) or amount_cents, not both' };
  }
  if (!hasCents && !hasMajor) {
    return { error: 'amount is required' };
  }

  const raw = hasCents ? Number(body.amount_cents) : Number(body.amount);
  if (!Number.isFinite(raw) || raw <= 0) {
    return { error: 'amount must be a positive number' };
  }
  if (hasCents && !Number.isInteger(raw)) {
    return { error: 'amount_cents must be a whole number of minor units' };
  }

  const amount = hasCents ? raw / 100 : raw;
  // PayPal rejects more than 2 decimal places on every currency we support.
  const rounded = Math.round(amount * 100) / 100;
  if (rounded <= 0) {
    return { error: 'amount is too small to charge' };
  }
  return { amount: rounded };
}

/**
 * POST /api/paypal/payments/create
 *
 * Open a PayPal order for a business and return the approval URL — the PayPal
 * analogue of POST /api/stripe/payments/create.
 *
 * On a partner-onboarded business this is a multiparty order: funds go straight
 * to the merchant's PayPal account and CoinPay's commission rides along as a
 * `platform_fees` entry, the same economics as the Stripe destination charge.
 * On a self-serve business PayPal treats the call as first-party and forbids a
 * platform fee, so the commission is 0 and the response says so.
 */
export async function POST(request: NextRequest) {
  const supabase = getSupabase();
  try {
    const body = await request.json();
    const {
      businessId: rawBusinessId,
      business_id: snakeBusinessId,
      currency = 'USD',
      description,
      metadata = {},
      successUrl,
      success_url,
      cancelUrl,
      cancel_url,
      customerEmail,
      customer_email,
      customerName,
      customer_name,
      invoiceNumber: callerInvoiceNumber,
    } = body;

    const businessId = rawBusinessId || snakeBusinessId;
    if (!businessId) {
      return NextResponse.json({ error: 'businessId is required' }, { status: 400 });
    }

    const amountResult = resolveAmount(body);
    if ('error' in amountResult) {
      return NextResponse.json({ error: amountResult.error }, { status: 400 });
    }
    const { amount } = amountResult;

    // Only the merchant being charged for (or the platform) may open an order
    // against their PayPal account. Same gate as the Stripe rail.
    const auth = await authorizePaymentCreation(supabase, request, businessId);
    if (!auth.ok) {
      return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const customerEmailValue =
      typeof (customerEmail ?? customer_email) === 'string' && (customerEmail ?? customer_email).trim()
        ? (customerEmail ?? customer_email).trim()
        : null;
    const customerNameValue =
      typeof (customerName ?? customer_name) === 'string' && (customerName ?? customer_name).trim()
        ? (customerName ?? customer_name).trim()
        : null;

    const merchantSuccessUrl =
      typeof (successUrl ?? success_url) === 'string' && (successUrl ?? success_url)
        ? String(successUrl ?? success_url)
        : null;
    const merchantCancelUrl =
      typeof (cancelUrl ?? cancel_url) === 'string' && (cancelUrl ?? cancel_url)
        ? String(cancelUrl ?? cancel_url)
        : null;

    // Who paid and for which property, Stripe-style. Optional here, and kept
    // in the row's metadata so the merchant webhook carries them.
    const customerFields = customerMetadata(body);
    if (!customerFields.ok) {
      return NextResponse.json({ error: customerFields.error }, { status: 400 });
    }

    const result = await createPaypalPaymentForBusiness(supabase, {
      businessId,
      amount,
      currency,
      description,
      metadata: {
        ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
        ...customerFields.metadata,
      },
      successUrl: merchantSuccessUrl,
      cancelUrl: merchantCancelUrl,
      customerEmail: customerEmailValue ?? customerFields.metadata.customer_email ?? null,
      customerName: customerNameValue,
      invoiceNumber: callerInvoiceNumber,
      clientIp: getClientIp(request),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json(result.response);
  } catch (error: any) {
    console.error('PayPal payment creation error:', error);
    return NextResponse.json(
      { error: error?.message || 'Failed to create payment' },
      { status: 500 }
    );
  }
}
