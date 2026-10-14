import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPaymentWebhook } from '@/lib/webhooks/service';
import { normalizeDispute } from './disputes';

/**
 * CUSTOMER.DISPUTE.*: find the CoinPay payment the dispute reverses (by the
 * seller-side capture id) and tell the merchant. The dispute itself is read
 * live from PayPal by the dashboard, so nothing is stored here beyond the
 * ledger row the caller writes.
 */
export async function handleDisputeEvent(
  supabase: SupabaseClient | any,
  eventType: string,
  event: any
): Promise<string | null> {
  const dispute = normalizeDispute(event?.resource);
  if (!dispute.sellerTransactionId) return null;

  const { data: transaction } = await supabase
    .from('paypal_transactions')
    .select('id, business_id, amount, currency, invoice_number')
    .eq('paypal_capture_id', dispute.sellerTransactionId)
    .maybeSingle();
  if (!transaction?.business_id) return null;

  try {
    await sendPaymentWebhook(
      supabase,
      transaction.business_id,
      transaction.id,
      eventType === 'CUSTOMER.DISPUTE.RESOLVED' ? 'payment.dispute_resolved' : 'payment.disputed',
      {
        status: dispute.status,
        amount_crypto: dispute.amount,
        amount_usd: dispute.amount,
        currency: dispute.currency,
        rail: 'paypal',
        dispute_id: dispute.id,
        reason: dispute.reason,
        respond_by: dispute.respondBy,
        outcome: dispute.outcome,
      }
    );
  } catch (error) {
    console.error('[PayPal] dispute webhook to merchant failed:', error);
  }
  return transaction.business_id;
}
