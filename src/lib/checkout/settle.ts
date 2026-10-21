import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Mark a hosted checkout session paid. Called from the payment webhook path
 * (crypto confirm/forward and PayPal capture all funnel through
 * sendPaymentWebhook) and lazily from the session read. Conditional on the
 * session not already being paid, so repeats are no-ops.
 */
export async function markCheckoutSessionPaidFromWebhook(
  supabase: SupabaseClient,
  input: { sessionId: string; paymentId: string; method: string | null }
): Promise<boolean> {
  if (!/^cs_[A-Za-z0-9]{16,64}$/.test(input.sessionId)) return false;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('checkout_sessions')
    .update({
      status: 'paid',
      paid_at: now,
      paid_reference: input.paymentId,
      paid_method: input.method ? String(input.method).toUpperCase() : null,
      updated_at: now,
    })
    .eq('id', input.sessionId)
    .neq('status', 'paid')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[Checkout] mark paid failed:', error);
    return false;
  }
  return !!data;
}
