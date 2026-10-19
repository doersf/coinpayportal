import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email';
import { escapeHtml, escapeUrl } from '@/lib/email/escape';
import { businessContacts } from '@/lib/contractors/notify';
import { signUrl } from './service';

/**
 * Document emails. Delivery is best-effort: the state change is committed
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
    if (!result.success) console.error('[documents] email failed:', subject, result.error);
  } catch (err) {
    console.error('[documents] email threw:', subject, err);
  }
}

/**
 * The invite. Documents are end-to-end encrypted, so by default the link here
 * cannot open the file: the sender passes the full link (with its `#k=` key)
 * on another channel. Only when the sender opts in does `documentKey` arrive,
 * and then it goes into this one email and nowhere else.
 */
export async function sendDocumentInvite(
  supabase: SupabaseClient,
  doc: { business_id: string; title: string; message: string | null },
  recipient: { name: string; email: string; role: 'signer' | 'viewer' },
  token: string,
  documentKey: string | null
) {
  const biz = await businessContacts(supabase, doc.business_id);
  const signer = recipient.role === 'signer';
  const note = doc.message
    ? `<blockquote style="margin:16px 0;padding:12px 16px;background:#f3f4f6;border-radius:8px;white-space:pre-wrap">${escapeHtml(doc.message)}</blockquote>`
    : '';
  const keyNote = documentKey
    ? '<p>This document is end-to-end encrypted; the key is part of the link below. This link is personal to you; please do not forward it.</p>'
    : `<p><strong>This document is end-to-end encrypted.</strong> ${escapeHtml(biz.name)} will send you the full link, which contains the key, separately (for example by text or chat). The button below opens the document page, where you can paste that link if you have it.</p>`;
  await send(
    recipient.email,
    signer ? `${biz.name} sent you "${doc.title}" to sign` : `${biz.name} shared "${doc.title}" with you`,
    layout(
      signer ? `Please sign: ${doc.title}` : doc.title,
      `<p>Hi ${escapeHtml(recipient.name)},</p>
<p>${escapeHtml(biz.name)} ${signer ? 'asked you to review and sign' : 'shared'} <strong>${escapeHtml(doc.title)}</strong>.</p>${note}${keyNote}
<p>No account is needed.</p>`,
      { href: documentKey ? `${signUrl(token)}#k=${documentKey}` : signUrl(token), label: signer ? 'Review and sign' : 'View document' }
    )
  );
}

export async function notifyOwnerSigned(supabase: SupabaseClient, doc: { id: string; business_id: string; title: string }, who: string, remaining: number) {
  const biz = await businessContacts(supabase, doc.business_id);
  await send(
    biz.ownerEmail,
    `${who} signed "${doc.title}"`,
    layout(
      `${who} signed`,
      `<p>${escapeHtml(who)} signed <strong>${escapeHtml(doc.title)}</strong>.</p>
<p>${remaining > 0 ? `Waiting on ${remaining} more signer${remaining === 1 ? '' : 's'}.` : 'That was the last signature; the signed copy is on its way.'}</p>`,
      { href: `${appUrl()}/documents/${doc.id}`, label: 'Open the document' }
    )
  );
}

export async function notifyOwnerDeclined(
  supabase: SupabaseClient,
  doc: { id: string; business_id: string; title: string },
  who: string,
  reason: string
) {
  const biz = await businessContacts(supabase, doc.business_id);
  await send(
    biz.ownerEmail,
    `${who} declined to sign "${doc.title}"`,
    layout(
      `${who} declined to sign`,
      `<p>${escapeHtml(who)} declined to sign <strong>${escapeHtml(doc.title)}</strong>. Their reason:</p>
<blockquote style="margin:16px 0;padding:12px 16px;background:#f3f4f6;border-radius:8px;white-space:pre-wrap">${escapeHtml(reason)}</blockquote>
<p>No one else can sign this copy now. Upload a revised document to start again.</p>`,
      { href: `${appUrl()}/documents/${doc.id}`, label: 'Open the document' }
    )
  );
}

/**
 * Everyone hears it is done. The signed copy is encrypted under the document
 * key, so it cannot be attached; each person downloads it with their own link.
 */
export async function sendCompletedNotices(
  supabase: SupabaseClient,
  doc: { id: string; business_id: string; title: string },
  recipients: { name: string; email: string }[]
) {
  const biz = await businessContacts(supabase, doc.business_id);
  const body = `<p>Everyone has signed <strong>${escapeHtml(doc.title)}</strong>.</p>
<p>The signed copy, with a certificate of completion at the end, is end-to-end encrypted. Open the document with the full link you were given to download it.</p>`;
  const seen = new Set<string>();
  for (const r of recipients) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    await send(r.email, `Completed: ${doc.title}`, layout(`Completed: ${doc.title}`, `<p>Hi ${escapeHtml(r.name)},</p>${body}`));
  }
  if (biz.ownerEmail && !seen.has(biz.ownerEmail.toLowerCase())) {
    const link = `${appUrl()}/documents/${doc.id}`;
    await send(biz.ownerEmail, `Completed: ${doc.title}`, layout(`Completed: ${doc.title}`, `<p>Everyone has signed <strong>${escapeHtml(doc.title)}</strong>.</p>`, { href: link, label: 'Open the document' }));
  }
}
