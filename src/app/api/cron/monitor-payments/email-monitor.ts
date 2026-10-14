/**
 * Email Monitor
 *
 * Sends escrow-related email notifications:
 * 1. Expiration reminders (24h, 12h, 2h) to depositor
 * 2. Settlement notifications to beneficiary
 * 3. Status change notifications to both parties
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email';
import { fetchAllKeyset } from '@/lib/db/keyset';
import { paymentConfirmedTemplate } from '@/lib/email/templates';
import type { Payment } from '@/lib/supabase/types';

export interface EmailStats {
  reminders_sent: number;
  settlements_sent: number;
  status_change_sent: number;
  deposits_sent: number;
  errors: number;
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'CoinPayPortal <no-reply@coinpayportal.com>';
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com';

const REMINDER_THRESHOLDS = [
  { hours: 24, field: 'reminder_24h_sent', label: '24 hours' },
  { hours: 12, field: 'reminder_12h_sent', label: '12 hours' },
  { hours: 2, field: 'reminder_2h_sent', label: '2 hours' },
] as const;

const STATUS_EMAIL_CONFIG: Record<string, { emoji: string; label: string; description: string }> = {
  funded: { emoji: '✅', label: 'funded', description: 'The escrow has been funded. The deposited amount has been received.' },
  expired: { emoji: '⏰', label: 'expired', description: 'The escrow has expired without being funded in time.' },
  disputed: { emoji: '⚠️', label: 'disputed', description: 'A dispute has been opened on this escrow.' },
  refunded: { emoji: '↩️', label: 'refunded', description: 'The escrow has been refunded to the depositor.' },
  released: { emoji: '🔓', label: 'released', description: 'The escrow has been released. Funds will be settled to the beneficiary.' },
};

const NOTIFIABLE_STATUSES = Object.keys(STATUS_EMAIL_CONFIG);

export async function monitorEmails(
  supabase: SupabaseClient,
  now: Date
): Promise<EmailStats> {
  const stats: EmailStats = { reminders_sent: 0, settlements_sent: 0, status_change_sent: 0, deposits_sent: 0, errors: 0 };

  try {
    await sendExpirationReminders(supabase, now, stats);
  } catch (err) {
    console.error('Expiration reminder error:', err);
    stats.errors++;
  }

  try {
    await sendSettlementNotifications(supabase, stats);
  } catch (err) {
    console.error('Settlement notification error:', err);
    stats.errors++;
  }

  try {
    await sendStatusChangeNotifications(supabase, stats);
  } catch (err) {
    console.error('Status change notification error:', err);
    stats.errors++;
  }

  try {
    await sendDepositNotifications(supabase, now, stats);
  } catch (err) {
    console.error('Deposit notification error:', err);
    stats.errors++;
  }

  return stats;
}

/**
 * How far back a confirmation is still worth announcing. Bounds the first run
 * after deploy, too: older payments are not emailed retroactively.
 */
const DEPOSIT_EMAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Email the merchant when a payment to one of their businesses is received.
 *
 * Driven from `confirmed_at` rather than hooked into each confirm path: a
 * payment is confirmed by the monitor loop, the late-deposit rescan, the
 * merchant-facing balance check and the card/bank rails, and not all of them
 * raise payment.confirmed. Whatever confirmed it, it shows up here once.
 *
 * Opt-out, on by default: `merchant_settings.email_notifications` (and the
 * notifications master switch). A merchant with no settings row gets the email.
 *
 * Exactly once per payment: the `email_queue` row is inserted *before* sending,
 * and a unique index on (payment_id, event_type) makes the insert the claim.
 */
export async function sendDepositNotifications(
  supabase: SupabaseClient,
  now: Date,
  stats: EmailStats
): Promise<void> {
  const since = new Date(now.getTime() - DEPOSIT_EMAIL_LOOKBACK_MS).toISOString();
  const { data: payments, error } = await supabase
    .from('payments')
    .select('id, business_id, amount, currency, blockchain, crypto_amount, crypto_currency, customer_paid_amount, tx_hash, confirmed_at, status')
    .gte('confirmed_at', since)
    .not('business_id', 'is', null)
    .order('confirmed_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  if (!payments?.length) return;

  const { data: already, error: sentError } = await supabase
    .from('email_queue')
    .select('payment_id')
    .eq('event_type', 'payment.confirmed')
    .in('payment_id', payments.map((p) => p.id));
  if (sentError) throw sentError;
  const done = new Set((already || []).map((r: { payment_id: string }) => r.payment_id));

  for (const payment of payments) {
    if (done.has(payment.id)) continue;
    try {
      const { data: business } = await supabase
        .from('businesses')
        .select('id, name, merchant_id')
        .eq('id', payment.business_id)
        .single();
      if (!business?.merchant_id) continue;

      const { data: merchant } = await supabase
        .from('merchants')
        .select('id, email')
        .eq('id', business.merchant_id)
        .single();
      if (!merchant?.email) continue;

      const { data: settings } = await supabase
        .from('merchant_settings')
        .select('notifications_enabled, email_notifications')
        .eq('merchant_id', merchant.id)
        .maybeSingle();
      const optedOut = settings && (!settings.notifications_enabled || !settings.email_notifications);

      const template = paymentConfirmedTemplate(payment as unknown as Payment);
      const subject = `${template.subject} · ${business.name}`;

      // The claim. A unique violation means another worker has it.
      const { data: claimed, error: claimError } = await supabase
        .from('email_queue')
        .insert({
          merchant_id: merchant.id,
          payment_id: payment.id,
          event_type: 'payment.confirmed',
          recipient_email: merchant.email,
          subject,
          html_body: template.html,
          status: optedOut ? 'failed' : 'pending',
          error_message: optedOut ? 'merchant opted out of email notifications' : null,
        })
        .select('id');
      if (claimError || !claimed?.length) continue;
      if (optedOut) continue;

      const result = await sendEmail({ to: merchant.email, from: FROM_EMAIL, subject, html: template.html });
      await supabase
        .from('email_queue')
        .update(
          result.success
            ? { status: 'sent', sent_at: new Date().toISOString(), attempts: 1 }
            : { status: 'failed', error_message: result.error || 'send failed', attempts: 1 }
        )
        .eq('id', claimed[0].id);

      if (result.success) {
        stats.deposits_sent++;
        console.log(`Sent deposit email for payment ${payment.id} to merchant ${merchant.id}`);
      } else {
        stats.errors++;
        console.error(`Deposit email for payment ${payment.id} failed:`, result.error);
      }
    } catch (err) {
      console.error(`Deposit notification failed for payment ${payment.id}:`, err);
      stats.errors++;
    }
  }
}

async function sendExpirationReminders(
  supabase: SupabaseClient,
  now: Date,
  stats: EmailStats
): Promise<void> {
  const { data: escrows, error } = await supabase
    .from('escrows')
    .select('id, depositor_email, escrow_address, amount, chain, expires_at, reminder_24h_sent, reminder_12h_sent, reminder_2h_sent')
    .eq('status', 'pending')
    .not('depositor_email', 'is', null)
    .limit(100);

  if (error || !escrows) return;

  for (const escrow of escrows) {
    const expiresAt = new Date(escrow.expires_at);
    const hoursLeft = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursLeft <= 0) continue; // already expired, skip

    for (const threshold of REMINDER_THRESHOLDS) {
      if (hoursLeft <= threshold.hours && !escrow[threshold.field]) {
        try {
          await sendEmail({
            to: escrow.depositor_email,
            from: FROM_EMAIL,
            subject: `⏰ Your escrow expires in ${threshold.label} — ${escrow.amount} ${escrow.chain}`,
            html: buildReminderHtml(escrow, threshold.label, expiresAt),
          });

          await supabase
            .from('escrows')
            .update({ [threshold.field]: true })
            .eq('id', escrow.id);

          stats.reminders_sent++;
          console.log(`Sent ${threshold.label} reminder for escrow ${escrow.id}`);
        } catch (err) {
          console.error(`Failed to send ${threshold.label} reminder for escrow ${escrow.id}:`, err);
          stats.errors++;
        }
      }
    }
  }
}

async function sendSettlementNotifications(
  supabase: SupabaseClient,
  stats: EmailStats
): Promise<void> {
  const { data: escrows, error } = await supabase
    .from('escrows')
    .select('id, beneficiary_email, amount, chain, settlement_tx_hash')
    .eq('status', 'settled')
    .eq('settled_email_sent', false)
    .not('beneficiary_email', 'is', null)
    .limit(100);

  if (error || !escrows) return;

  for (const escrow of escrows) {
    try {
      await sendEmail({
        to: escrow.beneficiary_email,
        from: FROM_EMAIL,
        subject: `🎉 You've been paid! ${escrow.amount} ${escrow.chain}`,
        html: buildSettlementHtml(escrow),
      });

      await supabase
        .from('escrows')
        .update({ settled_email_sent: true })
        .eq('id', escrow.id);

      stats.settlements_sent++;
      console.log(`Sent settlement notification for escrow ${escrow.id}`);
    } catch (err) {
      console.error(`Failed to send settlement email for escrow ${escrow.id}:`, err);
      stats.errors++;
    }
  }
}

async function sendStatusChangeNotifications(
  supabase: SupabaseClient,
  stats: EmailStats
): Promise<void> {
  // H-R-05: this was `.limit(200)` with no `.order()` and no filter on what had
  // already been sent. All five notifiable statuses are terminal, so an escrow
  // that reaches one stays in this set permanently — and every row in the batch
  // is then skipped by the `alreadySent` check below. Once 200 terminal escrows
  // have accumulated, the batch is entirely made of them and no escrow ever
  // receives a status email again. The job reports success having sent nothing.
  //
  // Walking the whole set means a newly-notifiable escrow is always reached,
  // whatever is ahead of it. The per-row skip stays as the idempotency guard.
  const { rows: escrows, truncated, error } = await fetchAllKeyset<any>(
    (cursor, pageSize) => {
      let q = supabase
        .from('escrows')
        .select('id, status, depositor_email, beneficiary_email, amount, chain, escrow_address, dispute_reason, settlement_tx_hash, status_emails_sent')
        .in('status', NOTIFIABLE_STATUSES)
        .order('id', { ascending: true })
        .limit(pageSize);
      if (cursor) q = q.gt('id', cursor);
      return q as unknown as Promise<{ data: any[] | null; error: { message: string } | null }>;
    }
  );

  if (error) {
    console.error('[Email] Status-change sweep page failed:', error);
    stats.errors++;
  }
  if (truncated) {
    console.warn('[Email] Status-change sweep hit its row ceiling; the tail was not notified this run');
  }
  if (!escrows.length) return;

  for (const escrow of escrows) {
    const alreadySent: string[] = escrow.status_emails_sent || [];
    if (alreadySent.includes(escrow.status)) continue;

    const recipients = [
      escrow.depositor_email,
      escrow.beneficiary_email,
    ].filter(Boolean) as string[];

    if (recipients.length === 0) continue;

    const config = STATUS_EMAIL_CONFIG[escrow.status];
    if (!config) continue;

    const subject = `${config.emoji} Escrow ${config.label} — ${escrow.amount} ${escrow.chain}`;
    const html = buildStatusChangeHtml(escrow, config);

    let allSent = true;
    for (const recipient of recipients) {
      try {
        await sendEmail({ to: recipient, from: FROM_EMAIL, subject, html });
        stats.status_change_sent++;
        console.log(`Sent ${escrow.status} status email to ${recipient} for escrow ${escrow.id}`);
      } catch (err) {
        console.error(`Failed to send ${escrow.status} status email to ${recipient} for escrow ${escrow.id}:`, err);
        stats.errors++;
        allSent = false;
      }
    }

    if (allSent) {
      const updatedSent = [...alreadySent, escrow.status];
      await supabase
        .from('escrows')
        .update({ status_emails_sent: updatedSent })
        .eq('id', escrow.id);
    }
  }
}

// ── HTML Builders ───────────────────────────────────────────

function buildReminderHtml(
  escrow: { id: string; escrow_address: string; amount: number; chain: string; expires_at: string },
  timeframe: string,
  expiresAt: Date
): string {
  const manageUrl = `${APP_URL}/escrow/${escrow.id}`;
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1a1a1a;">⏰ Your Escrow Expires in ${timeframe}</h2>
      <p style="color: #4a4a4a; line-height: 1.6;">
        Your escrow is expiring soon. If you haven't deposited yet, please do so before it expires.
      </p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 8px 0; color: #666;">Escrow ID</td><td style="padding: 8px 0; font-family: monospace;">${escrow.id}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Amount</td><td style="padding: 8px 0; font-weight: bold;">${escrow.amount} ${escrow.chain}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Deposit Address</td><td style="padding: 8px 0; font-family: monospace; word-break: break-all;">${escrow.escrow_address}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Expires At</td><td style="padding: 8px 0;">${expiresAt.toUTCString()}</td></tr>
      </table>
      <a href="${manageUrl}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        View Escrow
      </a>
      <p style="color: #999; font-size: 12px; margin-top: 30px;">
        This is an automated message from CoinPayPortal. Do not reply to this email.
      </p>
    </div>
  `;
}

function buildSettlementHtml(
  escrow: { id: string; amount: number; chain: string; settlement_tx_hash: string | null }
): string {
  const manageUrl = `${APP_URL}/escrow/${escrow.id}`;
  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1a1a1a;">🎉 You've Been Paid!</h2>
      <p style="color: #4a4a4a; line-height: 1.6;">
        Great news! An escrow payment has been settled and the funds have been sent to your wallet.
      </p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 8px 0; color: #666;">Amount</td><td style="padding: 8px 0; font-weight: bold;">${escrow.amount} ${escrow.chain}</td></tr>
        ${escrow.settlement_tx_hash ? `<tr><td style="padding: 8px 0; color: #666;">Transaction</td><td style="padding: 8px 0; font-family: monospace; word-break: break-all;">${escrow.settlement_tx_hash}</td></tr>` : ''}
      </table>
      <a href="${manageUrl}" style="display: inline-block; background: #16a34a; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        View Details
      </a>
      <p style="color: #999; font-size: 12px; margin-top: 30px;">
        This is an automated message from CoinPayPortal. Do not reply to this email.
      </p>
    </div>
  `;
}

function buildStatusChangeHtml(
  escrow: { id: string; status: string; amount: number; chain: string; escrow_address: string; dispute_reason: string | null; settlement_tx_hash: string | null },
  config: { emoji: string; label: string; description: string }
): string {
  const manageUrl = `${APP_URL}/escrow/${escrow.id}`;
  const extraRows: string[] = [];

  if (escrow.dispute_reason && escrow.status === 'disputed') {
    extraRows.push(`<tr><td style="padding: 8px 0; color: #666;">Dispute Reason</td><td style="padding: 8px 0;">${escrow.dispute_reason}</td></tr>`);
  }
  if (escrow.settlement_tx_hash && (escrow.status === 'released' || escrow.status === 'refunded')) {
    extraRows.push(`<tr><td style="padding: 8px 0; color: #666;">Transaction</td><td style="padding: 8px 0; font-family: monospace; word-break: break-all;">${escrow.settlement_tx_hash}</td></tr>`);
  }

  const statusColors: Record<string, string> = {
    funded: '#16a34a',
    expired: '#dc2626',
    disputed: '#d97706',
    refunded: '#6366f1',
    released: '#2563eb',
  };
  const color = statusColors[escrow.status] || '#2563eb';

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #1a1a1a;">${config.emoji} Escrow ${config.label.charAt(0).toUpperCase() + config.label.slice(1)}</h2>
      <p style="color: #4a4a4a; line-height: 1.6;">${config.description}</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr><td style="padding: 8px 0; color: #666;">Escrow ID</td><td style="padding: 8px 0; font-family: monospace;">${escrow.id}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Status</td><td style="padding: 8px 0; font-weight: bold; color: ${color};">${escrow.status.toUpperCase()}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Amount</td><td style="padding: 8px 0; font-weight: bold;">${escrow.amount} ${escrow.chain}</td></tr>
        <tr><td style="padding: 8px 0; color: #666;">Deposit Address</td><td style="padding: 8px 0; font-family: monospace; word-break: break-all;">${escrow.escrow_address}</td></tr>
        ${extraRows.join('\n        ')}
      </table>
      <a href="${manageUrl}" style="display: inline-block; background: ${color}; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 500;">
        View Escrow
      </a>
      <p style="color: #999; font-size: 12px; margin-top: 30px;">
        This is an automated message from CoinPayPortal. Do not reply to this email.
      </p>
    </div>
  `;
}
