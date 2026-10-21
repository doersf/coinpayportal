import type { SupabaseClient } from '@supabase/supabase-js';
import { createPaypalOrder } from '@/lib/paypal/client';
import { resolvePaypalContext } from '@/lib/paypal/accounts';
import { screenCheckout } from '@/lib/fraud/screen';
import { isBusinessPaidTier } from '@/lib/entitlements/service';
import { getFeePercentage } from '@/lib/payments/fees';

/**
 * Open a PayPal order for a business. Shared by POST /api/paypal/payments/create
 * (after it has authorized the caller) and by hosted checkout sessions, which
 * open the order on the business's behalf when the buyer picks PayPal.
 *
 * The caller is responsible for authorization. Everything after that (fraud
 * screen, fee tier, the pending row, the order, binding the order id) lives
 * here so both paths behave identically.
 */
export interface CreatePaypalPaymentInput {
  businessId: string;
  /** Major units, already rounded to 2 decimals. */
  amount: number;
  currency?: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  /** Merchant return links stored on the row for the hosted button page. */
  successUrl?: string | null;
  cancelUrl?: string | null;
  /**
   * Where PayPal itself sends the payer. Defaults to the merchant success/cancel
   * URL, else CoinPay's /pay/paypal/return page. Receives the new row id.
   */
  paypalReturnUrl?: (transactionId: string) => string;
  paypalCancelUrl?: (transactionId: string) => string;
  customerEmail?: string | null;
  customerName?: string | null;
  invoiceNumber?: string | null;
  clientIp?: string | null;
}

export type CreatePaypalPaymentResult =
  | {
      ok: true;
      response: {
        invoice_number: string;
        transaction_id: string;
        order_id: string;
        approve_url: string;
        hosted_checkout_url: string;
        checkout_url: string;
        amount: number;
        currency: string;
        platform_fee_amount: number;
        platform_fee_supported: boolean;
        connection_mode: string;
      };
    }
  | { ok: false; status: number; error: string };

export async function createPaypalPaymentForBusiness(
  supabase: SupabaseClient,
  input: CreatePaypalPaymentInput
): Promise<CreatePaypalPaymentResult> {
  const { businessId, amount } = input;
  const currency = input.currency || 'USD';
  const description = input.description ?? undefined;
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const customerEmailValue = input.customerEmail?.trim() || null;
  const customerNameValue = input.customerName?.trim() || null;

  const { data: business, error: bizError } = await supabase
    .from('businesses')
    .select('merchant_id, name')
    .eq('id', businessId)
    .single();

  if (bizError || !business) {
    console.error('[PayPal] Business lookup failed:', bizError);
    return { ok: false, status: 404, error: 'Business not found' };
  }

  const context = await resolvePaypalContext(supabase, businessId);
  if ('error' in context) {
    return { ok: false, status: context.status, error: context.error };
  }

  // Screen before the order exists: the last point at which we can stop a
  // payment without PayPal ever seeing it.
  const screening = await screenCheckout(supabase, {
    businessId,
    email: customerEmailValue,
    ip: input.clientIp ?? null,
    amount,
    currency,
    description,
  });

  if (screening.decision === 'block') {
    console.warn('[Fraud] Blocked PayPal checkout', {
      businessId,
      score: screening.score,
      findings: screening.findings.map((f) => f.code).join(', '),
    });
    return { ok: false, status: 403, error: screening.buyerMessage || 'This payment could not be processed. Please contact the merchant.' };
  }

  // PayPal has no per-order 3-D Secure lever, so an elevated score is recorded
  // and allowed through rather than silently treated as stepped up.
  if (screening.decision === 'verify') {
    console.warn('[Fraud] Elevated-risk PayPal checkout allowed (no 3DS equivalent)', {
      businessId,
      score: screening.score,
      findings: screening.findings.map((f) => f.code).join(', '),
    });
  }

  // Platform fee at the merchant's real tier. isBusinessPaidTier is the single
  // source of truth and already enforces subscription expiry.
  const isPaidTier = await isBusinessPaidTier(supabase, businessId);
  const platformFeeRate = getFeePercentage(isPaidTier);
  const platformFeeAmount = context.supportsPlatformFee
    ? Math.round(amount * platformFeeRate * 100) / 100
    : 0;

  const invoiceNumber =
    (typeof input.invoiceNumber === 'string' && input.invoiceNumber.trim()) ||
    `INV-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com';
  const merchantSuccessUrl = input.successUrl || null;
  const merchantCancelUrl = input.cancelUrl || null;

  // The row is written BEFORE the order so its id can travel to PayPal as
  // custom_id. That id is what the webhook uses to find this row without
  // trusting anything the payer's browser sends back.
  const { data: inserted, error: insertError } = await supabase
    .from('paypal_transactions')
    .insert({
      merchant_id: business.merchant_id,
      business_id: businessId,
      // Placeholder: replaced with the real order id immediately below. The
      // column is NOT NULL UNIQUE, so it needs a unique value now.
      paypal_order_id: `pending:${invoiceNumber}`,
      connection_mode: context.mode,
      amount,
      currency: String(currency).toUpperCase(),
      platform_fee_amount: platformFeeAmount,
      status: 'pending',
      invoice_number: invoiceNumber,
      description: typeof description === 'string' ? description.slice(0, 500) : null,
      customer_email: customerEmailValue,
      customer_name: customerNameValue,
      payee_merchant_id: context.payeeMerchantId,
      metadata: {
        ...metadata,
        business_id: businessId,
        merchant_id: business.merchant_id,
        fraud_score: screening.score,
        fraud_decision: screening.decision,
        // Where the hosted button page sends the payer after capture/cancel.
        ...(merchantSuccessUrl ? { paypal_success_url: merchantSuccessUrl } : {}),
        ...(merchantCancelUrl ? { paypal_cancel_url: merchantCancelUrl } : {}),
      },
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    console.error('[PayPal] transaction insert error:', insertError);
    return { ok: false, status: 500, error: 'Failed to record payment' };
  }

  const returnUrl = input.paypalReturnUrl
    ? input.paypalReturnUrl(inserted.id)
    : merchantSuccessUrl || `${appUrl}/pay/paypal/return?transaction_id=${inserted.id}`;
  const cancelUrl = input.paypalCancelUrl
    ? input.paypalCancelUrl(inserted.id)
    : merchantCancelUrl || `${appUrl}/pay/paypal/return?cancelled=1&transaction_id=${inserted.id}`;

  let order;
  try {
    order = await createPaypalOrder({
      ...context.creds,
      ...context.callContext,
      // Idempotency: a retried create with the same row never opens a second
      // order on the merchant's account.
      requestId: inserted.id,
      amount,
      currency,
      referenceId: invoiceNumber,
      description: description || `Payment to ${business.name || 'merchant'}`,
      brandName: business.name || 'CoinPay',
      customId: inserted.id,
      invoiceId: invoiceNumber,
      payerEmail: customerEmailValue,
      returnUrl,
      cancelUrl,
      payeeMerchantId: context.payeeMerchantId,
      platformFee: platformFeeAmount > 0 ? platformFeeAmount : null,
      platformFeePayeeMerchantId: context.platformFeePayeeMerchantId,
    });
  } catch (err) {
    // Mark the placeholder failed rather than leaving a permanently pending
    // row that no webhook will ever resolve.
    await supabase
      .from('paypal_transactions')
      .update({
        status: 'failed',
        failure_reason: err instanceof Error ? err.message.slice(0, 500) : 'PayPal order creation failed',
        updated_at: new Date().toISOString(),
      })
      .eq('id', inserted.id);

    console.error('[PayPal] Order creation failed:', err);
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Failed to create PayPal order',
    };
  }

  const { error: bindError } = await supabase
    .from('paypal_transactions')
    .update({ paypal_order_id: order.orderId, updated_at: new Date().toISOString() })
    .eq('id', inserted.id);

  if (bindError) {
    // The order exists at PayPal but we could not bind it. Capture would then
    // have no row to settle, so refuse the checkout rather than hand the payer
    // a URL that pays into a void.
    console.error('[PayPal] Failed to bind order id to transaction:', bindError);
    return { ok: false, status: 500, error: 'Failed to record PayPal order' };
  }

  return {
    ok: true,
    response: {
      invoice_number: invoiceNumber,
      transaction_id: inserted.id,
      order_id: order.orderId,
      // PayPal's redirect checkout, unchanged.
      approve_url: order.approveUrl,
      // CoinPay's hosted page with PayPal's JS SDK buttons (falls back to the
      // redirect when the SDK can't load). `checkout_url` points here so an
      // integration written against the Stripe rail reads the same field name.
      hosted_checkout_url: `${appUrl}/pay/paypal/${inserted.id}`,
      checkout_url: `${appUrl}/pay/paypal/${inserted.id}`,
      amount,
      currency: String(currency).toUpperCase(),
      platform_fee_amount: platformFeeAmount,
      platform_fee_supported: context.supportsPlatformFee,
      connection_mode: context.mode,
    },
  };
}
