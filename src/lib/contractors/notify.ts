import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email';
import { escapeHtml, escapeUrl } from '@/lib/email/escape';
import { contractorPortalUrl } from './service';

/**
 * Contractor emails. Delivery is best-effort: the state change is committed
 * before we get here, so a bounce is logged and never fails the request.
 */

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com').replace(/\/$/, '');
}

function layout(title: string, body: string, cta?: { href: string; label: string }): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeUrl(cta.href)}" style="background:#7c3aed;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(cta.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;background:#f6f6f9;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;color:#1f2937">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${body}${button}
<p style="color:#6b7280;font-size:12px;margin-top:32px">Sent by CoinPay on behalf of the business named above.</p>
</div></body></html>`;
}

async function send(to: string | null | undefined, subject: string, html: string) {
  if (!to) return;
  try {
    const result = await sendEmail({ to, subject, html });
    if (!result.success) console.error('[contractors] email failed:', subject, result.error);
  } catch (err) {
    console.error('[contractors] email threw:', subject, err);
  }
}

export async function businessContacts(supabase: SupabaseClient, businessId: string) {
  const { data: business } = await supabase.from('businesses').select('name, merchant_id').eq('id', businessId).maybeSingle();
  const { data: owner } = business?.merchant_id
    ? await supabase.from('merchants').select('email').eq('id', business.merchant_id).maybeSingle()
    : { data: null };
  return { name: (business?.name as string) || 'A CoinPay business', ownerEmail: (owner?.email as string) ?? null };
}

export async function sendContractorInvite(
  supabase: SupabaseClient,
  contractor: { business_id: string; name: string; email: string },
  token: string
) {
  const biz = await businessContacts(supabase, contractor.business_id);
  await send(
    contractor.email,
    `${biz.name} invited you to get paid with CoinPay`,
    layout(
      `${biz.name} wants to pay you in crypto`,
      `<p>Hi ${escapeHtml(contractor.name)},</p>
<p>${escapeHtml(biz.name)} added you as a contractor. Open your portal to set the wallet you want to be paid to,
fill in your tax form, review and sign your contract, and submit your hours, milestones and expenses.</p>
<p>No account is needed. Keep this link private: it is your key to the portal.</p>`,
      { href: contractorPortalUrl(token), label: 'Open my contractor portal' }
    )
  );
}

export async function sendContractToSign(
  supabase: SupabaseClient,
  contractor: { business_id: string; name: string; email: string; portal_token: string | null },
  contract: { title: string }
) {
  if (!contractor.portal_token) return;
  const biz = await businessContacts(supabase, contractor.business_id);
  await send(
    contractor.email,
    `Contract to sign: ${contract.title}`,
    layout(
      'A contract is waiting for your signature',
      `<p>${escapeHtml(biz.name)} signed <strong>${escapeHtml(contract.title)}</strong> and sent it to you.
Review the terms and sign in your portal to start getting paid.</p>`,
      { href: contractorPortalUrl(contractor.portal_token), label: 'Review and sign' }
    )
  );
}

export async function notifyBusinessOfSubmission(
  supabase: SupabaseClient,
  businessId: string,
  contractorName: string,
  what: string
) {
  const biz = await businessContacts(supabase, businessId);
  await send(
    biz.ownerEmail,
    `${contractorName} submitted ${what} for approval`,
    layout(
      'Waiting for your approval',
      `<p>${escapeHtml(contractorName)} submitted ${escapeHtml(what)} to ${escapeHtml(biz.name)}.
Approved work goes into the next pay run.</p>`,
      { href: `${appUrl()}/contractors`, label: 'Review submissions' }
    )
  );
}

export async function notifyWalletChanged(
  supabase: SupabaseClient,
  contractor: { business_id: string; name: string; email: string },
  coin: string,
  wallet: string
) {
  const biz = await businessContacts(supabase, contractor.business_id);
  const masked = `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  const body = `<p>The payout wallet for ${escapeHtml(contractor.name)} at ${escapeHtml(biz.name)} was changed to
<strong>${escapeHtml(coin)}</strong> <code>${escapeHtml(masked)}</code>.</p>
<p>If this was not you, tell ${escapeHtml(biz.name)} straight away. Pay runs flag a wallet changed in the last 72 hours.</p>`;
  await send(contractor.email, 'Your payout wallet was changed', layout('Payout wallet changed', body));
  await send(biz.ownerEmail, `${contractor.name} changed their payout wallet`, layout('Contractor payout wallet changed', body));
}

export async function notifyPaid(
  supabase: SupabaseClient,
  item: { business_id: string; amount: string | number; invoice_number: string; tx_hash: string | null; payout_currency: string | null },
  contractor: { name: string; email: string; portal_token: string | null }
) {
  const biz = await businessContacts(supabase, item.business_id);
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(item.amount));
  await send(
    contractor.email,
    `You were paid ${amount} by ${biz.name}`,
    layout(
      `You were paid ${amount}`,
      `<p>${escapeHtml(biz.name)} paid invoice ${escapeHtml(item.invoice_number)}${item.payout_currency ? ` in ${escapeHtml(item.payout_currency)}` : ''}.</p>
${item.tx_hash ? `<p>Transaction: <code>${escapeHtml(item.tx_hash)}</code></p>` : ''}`,
      contractor.portal_token ? { href: contractorPortalUrl(contractor.portal_token), label: 'View payments and invoices' } : undefined
    )
  );
}

export async function notifyPayRunDrafted(supabase: SupabaseClient, businessId: string, run: { id: string; number: number; total: string | number }) {
  const biz = await businessContacts(supabase, businessId);
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(run.total));
  await send(
    biz.ownerEmail,
    `Pay run #${run.number} is ready to review (${amount})`,
    layout(
      `Pay run #${run.number} is ready`,
      `<p>Fixed fees and approved work for ${escapeHtml(biz.name)} add up to <strong>${amount}</strong>.
Nothing is sent until you review the run and press Pay.</p>`,
      { href: `${appUrl()}/contractors/pay-runs/${run.id}`, label: 'Review pay run' }
    )
  );
}
