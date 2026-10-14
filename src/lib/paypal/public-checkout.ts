import type { SupabaseClient } from '@supabase/supabase-js';
import { resolvePaypalContext } from './accounts';
import type { PaypalEnvironment } from './client';

/** Statuses a buyer can still pay from the hosted button page. */
const PAYABLE = new Set(['pending', 'approved']);

/**
 * What the browser needs to render PayPal's JS SDK buttons for one payment.
 *
 * Everything here is public by PayPal's design: the client id is embedded in
 * every PayPal checkout page, and in partner mode the SDK is loaded with the
 * platform's client id plus the seller's `merchant-id`. No secret, no internal
 * row data beyond what the merchant chose to show the payer.
 */
export interface PublicPaypalCheckout {
  transactionId: string;
  orderId: string;
  status: string;
  amount: number;
  currency: string;
  description: string | null;
  businessName: string | null;
  clientId: string;
  environment: PaypalEnvironment;
  mode: 'self_serve' | 'partner';
  /** Partner mode: the seller, passed to the SDK as `merchant-id`. */
  merchantId: string | null;
  /** Partner mode: BN code, passed to the SDK as `data-partner-attribution-id`. */
  partnerAttributionId: string | null;
  /** Redirect-flow URL, the fallback when the SDK can't load. */
  approveUrl: string;
  successUrl: string | null;
  cancelUrl: string | null;
}

export type PublicCheckoutResult =
  | { ok: true; checkout: PublicPaypalCheckout }
  | { ok: false; status: number; error: string };

export function paypalApproveUrl(environment: PaypalEnvironment, orderId: string): string {
  const host = environment === 'sandbox' ? 'https://www.sandbox.paypal.com' : 'https://www.paypal.com';
  return `${host}/checkoutnow?token=${encodeURIComponent(orderId)}`;
}

export async function getPublicPaypalCheckout(
  supabase: SupabaseClient,
  transactionId: string
): Promise<PublicCheckoutResult> {
  const { data: row } = await supabase
    .from('paypal_transactions')
    .select('id, business_id, paypal_order_id, status, amount, currency, description, metadata')
    .eq('id', transactionId)
    .maybeSingle();

  if (!row || !row.business_id) return { ok: false, status: 404, error: 'Payment not found' };
  if (String(row.paypal_order_id || '').startsWith('pending:')) {
    return { ok: false, status: 409, error: 'This payment has no PayPal order yet' };
  }
  if (!PAYABLE.has(row.status)) {
    return { ok: false, status: 409, error: `This payment is ${row.status}` };
  }

  const context = await resolvePaypalContext(supabase, row.business_id);
  if ('error' in context) return { ok: false, status: context.status, error: context.error };

  const { data: business } = await supabase
    .from('businesses')
    .select('name')
    .eq('id', row.business_id)
    .maybeSingle();

  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const url = (value: unknown) => (typeof value === 'string' && /^https?:\/\//.test(value) ? value : null);

  return {
    ok: true,
    checkout: {
      transactionId: row.id,
      orderId: row.paypal_order_id,
      status: row.status,
      amount: Number(row.amount),
      currency: String(row.currency || 'USD').toUpperCase(),
      description: row.description ?? null,
      businessName: business?.name ?? null,
      clientId: context.creds.clientId,
      environment: context.environment,
      mode: context.mode,
      merchantId: context.mode === 'partner' ? context.payeeMerchantId : null,
      partnerAttributionId: context.mode === 'partner' ? context.callContext.bnCode ?? null : null,
      approveUrl: paypalApproveUrl(context.environment, row.paypal_order_id),
      successUrl: url(metadata.paypal_success_url),
      cancelUrl: url(metadata.paypal_cancel_url),
    },
  };
}
