import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deleteObject, getObject, putObject } from '@/lib/finances/files';
import { notifyOwnerDeclined, notifyOwnerNewVersion, notifyOwnerSigned, sendCompletedNotices, sendDocumentInvite } from './notify';
import {
  DOCUMENT_COLUMNS,
  EVENT_COLUMNS,
  hashToken,
  newSignToken,
  recordEvent,
  RECIPIENT_COLUMNS,
  SIGN_TOKEN_PATTERN,
  SEAL_OVERHEAD,
  signActionSchema,
  VERSION_COLUMNS,
  signUrl,
  statusFor,
  zodError,
  type DocumentRow,
  type RecipientRow,
  type RequestMeta,
} from './service';
import type { z } from 'zod';
import type { shareSchema } from './service';

/**
 * Everything that moves a document between states. API routes authorize and
 * parse; this module owns the transitions so the rules live in one place.
 *
 * Documents are end-to-end encrypted: every file this module stores or
 * returns is ciphertext, and it never holds a document key except the one a
 * sender explicitly hands over to put full links in invite emails.
 */

type Result<T = unknown> = { ok: true; data: T } | { ok: false; status: number; error: string };
const bad = (error: string, status = 400): { ok: false; status: number; error: string } => ({ ok: false, status, error });

const FULL_DOCUMENT = `${DOCUMENT_COLUMNS}, object_key, signed_object_key`;
const FULL_RECIPIENT = `${RECIPIENT_COLUMNS}, business_id, signature_image, signature_user_agent`;

export async function loadDocument(supabase: SupabaseClient, id: string): Promise<DocumentRow | null> {
  const { data } = await supabase.from('documents').select(FULL_DOCUMENT).eq('id', id).maybeSingle();
  return (data as unknown as DocumentRow) ?? null;
}

async function loadRecipients(supabase: SupabaseClient, documentId: string): Promise<RecipientRow[]> {
  const { data } = await supabase.from('document_recipients').select(FULL_RECIPIENT).eq('document_id', documentId).order('created_at');
  return (data as unknown as RecipientRow[]) ?? [];
}

/** The owner's label for the audit trail: their email, which is what a counterparty would recognise. */
export async function ownerLabel(supabase: SupabaseClient, merchantId: string): Promise<string | null> {
  const { data } = await supabase.from('merchants').select('email').eq('id', merchantId).maybeSingle();
  return (data?.email as string) ?? null;
}

async function setStatus(supabase: SupabaseClient, doc: DocumentRow): Promise<DocumentRow['status']> {
  const next = statusFor(doc.status, await loadRecipients(supabase, doc.id));
  if (next === 'completed') {
    await finalizeIfComplete(supabase, doc.id);
    return 'completed';
  }
  if (next !== doc.status) {
    await supabase.from('documents').update({ status: next, updated_at: new Date().toISOString() }).eq('id', doc.id).eq('status', doc.status);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Owner side
// ---------------------------------------------------------------------------

export async function shareDocument(
  supabase: SupabaseClient,
  doc: DocumentRow,
  input: z.infer<typeof shareSchema>,
  actor: { label: string | null; meta: RequestMeta }
): Promise<Result<{ recipients: (Record<string, unknown> & { url: string })[]; status: string }>> {
  if (doc.status === 'voided') return bad('This document was voided', 409);
  if (doc.status === 'declined') return bad('A signer declined this document; upload a new copy to start again', 409);
  if (doc.status === 'completed' && input.recipients.some((r) => r.role !== 'viewer')) {
    return bad('Every signer has signed; you can still share the signed copy with viewers', 409);
  }

  const emails = input.recipients.map((r) => r.email);
  if (new Set(emails).size !== emails.length) return bad('The same email is listed twice');
  const existing = (await loadRecipients(supabase, doc.id)).filter((r) => !r.revoked_at);
  const clash = existing.find((r) => emails.includes(r.email.toLowerCase()));
  if (clash) return bad(`${clash.email} already has access; re-send their link instead`, 409);

  const sendEmail = input.send_email !== false;
  const now = new Date();
  const rows = input.recipients.map((r) => {
    const token = newSignToken();
    return {
      token,
      row: {
        document_id: doc.id,
        business_id: doc.business_id,
        name: r.name,
        email: r.email,
        role: r.role,
        token_hash: hashToken(token),
        sent_at: sendEmail ? now.toISOString() : null,
        expires_at: r.expires_in_days ? new Date(now.getTime() + r.expires_in_days * 86_400_000).toISOString() : null,
      },
    };
  });
  const { data, error } = await supabase.from('document_recipients').insert(rows.map((r) => r.row)).select(RECIPIENT_COLUMNS);
  if (error?.code === '23505') return bad('One of those people already has access', 409);
  if (error || !data) return bad('Could not share the document', 500);

  if (input.message !== undefined) {
    await supabase.from('documents').update({ message: input.message || null }).eq('id', doc.id);
    doc.message = input.message || null;
  }
  const inserted = data as unknown as RecipientRow[];
  const out: (Record<string, unknown> & { url: string })[] = [];
  for (const r of inserted) {
    const token = rows.find((x) => x.row.email === r.email)!.token;
    await recordEvent(supabase, doc, 'shared', {
      actor: 'owner',
      recipientId: r.id,
      label: actor.label,
      meta: actor.meta,
      detail: { to: r.email, role: r.role, emailed: sendEmail },
    });
    if (sendEmail) await sendDocumentInvite(supabase, doc, r, token, input.email_document_key ?? null);
    out.push({ ...r, url: signUrl(token) });
  }
  const status = await setStatus(supabase, doc);
  return { ok: true, data: { recipients: out, status } };
}

/** A fresh link (the old one stops working), emailed again unless asked not to. */
export async function resendRecipient(
  supabase: SupabaseClient,
  doc: DocumentRow,
  recipientId: string,
  opts: { email: boolean; documentKey: string | null; label: string | null; meta: RequestMeta }
): Promise<Result<{ url: string }>> {
  if (doc.status === 'voided') return bad('This document was voided', 409);
  const token = newSignToken();
  const { data } = await supabase
    .from('document_recipients')
    .update({ token_hash: hashToken(token), sent_at: opts.email ? new Date().toISOString() : undefined })
    .eq('id', recipientId)
    .eq('document_id', doc.id)
    .is('revoked_at', null)
    .select(RECIPIENT_COLUMNS)
    .maybeSingle();
  if (!data) return bad('Recipient not found', 404);
  const r = data as unknown as RecipientRow;
  await recordEvent(supabase, doc, 'resent', { actor: 'owner', recipientId: r.id, label: opts.label, meta: opts.meta, detail: { to: r.email } });
  return { ok: true, data: { url: signUrl(token) } };
}

export async function revokeRecipient(
  supabase: SupabaseClient,
  doc: DocumentRow,
  recipientId: string,
  opts: { label: string | null; meta: RequestMeta }
): Promise<Result<{ status: string }>> {
  const { data } = await supabase
    .from('document_recipients')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', recipientId)
    .eq('document_id', doc.id)
    .is('revoked_at', null)
    .neq('status', 'signed')
    .select('id, email')
    .maybeSingle();
  if (!data) return bad('Only someone who has not signed yet can lose access', 409);
  await recordEvent(supabase, doc, 'revoked', { actor: 'owner', recipientId: data.id, label: opts.label, meta: opts.meta, detail: { to: data.email } });
  // Removing the last unsigned signer can complete the document.
  return { ok: true, data: { status: await setStatus(supabase, doc) } };
}

export async function voidDocument(
  supabase: SupabaseClient,
  doc: DocumentRow,
  reason: string | undefined,
  opts: { label: string | null; meta: RequestMeta }
): Promise<Result<null>> {
  if (doc.status === 'completed') return bad('A completed document cannot be voided', 409);
  if (doc.status === 'voided') return { ok: true, data: null };
  const now = new Date().toISOString();
  const { data } = await supabase
    .from('documents')
    .update({ status: 'voided', voided_at: now, void_reason: reason || null, updated_at: now })
    .eq('id', doc.id)
    .neq('status', 'completed')
    .select('id')
    .maybeSingle();
  if (!data) return bad('A completed document cannot be voided', 409);
  await recordEvent(supabase, doc, 'voided', { actor: 'owner', label: opts.label, meta: opts.meta, detail: reason ? { reason } : undefined });
  return { ok: true, data: null };
}

export async function deleteDocument(supabase: SupabaseClient, doc: DocumentRow): Promise<void> {
  const { data: versions } = await supabase.from('document_versions').select('object_key').eq('document_id', doc.id);
  await supabase.from('documents').delete().eq('id', doc.id);
  const keys = new Set([doc.object_key, ...((versions ?? []) as { object_key: string }[]).map((v) => v.object_key)]);
  for (const key of keys) await deleteObject(key).catch(() => undefined);
  if (doc.signed_object_key) await deleteObject(doc.signed_object_key).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function listVersions(supabase: SupabaseClient, documentId: string) {
  const { data } = await supabase.from('document_versions').select(VERSION_COLUMNS).eq('document_id', documentId).order('version', { ascending: false });
  return data ?? [];
}

/** Why a new version cannot be added right now, or null if it can. */
async function versionBlocker(supabase: SupabaseClient, doc: DocumentRow): Promise<string | null> {
  if (['completed', 'declined', 'voided'].includes(doc.status)) return `A ${doc.status} document cannot be changed`;
  const { count } = await supabase
    .from('document_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('document_id', doc.id)
    .eq('status', 'signed')
    .is('revoked_at', null);
  return count ? 'Someone has already signed this version; void it and upload a new document to change it' : null;
}

/**
 * Add a version: the next number, sealed by the uploader's browser under the
 * same document key. It becomes current, so pending signers sign it.
 */
export async function addVersion(
  supabase: SupabaseClient,
  doc: DocumentRow,
  sealed: Buffer,
  meta: { version: number; filename: string; content_type: string; bytes: number; sha256: string; note?: string | null },
  actor: { recipientId?: string; label: string | null; meta: RequestMeta; byRecipient: boolean }
): Promise<Result<{ version: number }>> {
  const blocker = await versionBlocker(supabase, doc);
  if (blocker) return bad(blocker, 409);
  if (meta.version !== doc.current_version + 1) return bad(`Someone else changed this document; reload and try again (now at version ${doc.current_version})`, 409);
  if (sealed.length !== meta.bytes + SEAL_OVERHEAD || sealed[0] !== 0x01) return bad('The file must be sealed in the browser before upload');

  const filename = meta.filename.split(/[\\/]/).pop()!.slice(0, 200) || 'document';
  const stored = await putObject('signing', doc.business_id, sealed);
  const { error } = await supabase.from('document_versions').insert({
    document_id: doc.id,
    business_id: doc.business_id,
    version: meta.version,
    filename,
    content_type: meta.content_type,
    bytes: meta.bytes,
    sha256: meta.sha256,
    object_key: stored.objectKey,
    note: meta.note || null,
    uploaded_by: actor.label,
    recipient_id: actor.recipientId ?? null,
  });
  if (error) {
    await deleteObject(stored.objectKey).catch(() => undefined);
    return bad(error.code === '23505' ? 'Someone else uploaded a version at the same moment; reload and try again' : 'Could not save the version', error.code === '23505' ? 409 : 500);
  }
  const { data: moved } = await supabase
    .from('documents')
    .update({
      current_version: meta.version,
      filename,
      content_type: meta.content_type,
      bytes: meta.bytes,
      sha256: meta.sha256,
      object_key: stored.objectKey,
      updated_at: new Date().toISOString(),
    })
    .eq('id', doc.id)
    .eq('current_version', meta.version - 1)
    .in('status', ['draft', 'shared', 'out_for_signature'])
    .select('id')
    .maybeSingle();
  if (!moved) {
    await supabase.from('document_versions').delete().eq('document_id', doc.id).eq('version', meta.version);
    await deleteObject(stored.objectKey).catch(() => undefined);
    return bad('The document changed while uploading; reload and try again', 409);
  }
  await recordEvent(supabase, doc, 'version_added', {
    actor: actor.byRecipient ? 'recipient' : 'owner',
    recipientId: actor.recipientId,
    label: actor.label,
    meta: actor.meta,
    detail: { version: meta.version, filename, sha256: meta.sha256, note: meta.note || undefined },
  });
  if (actor.byRecipient) await notifyOwnerNewVersion(supabase, doc, actor.label ?? 'An editor', meta.version, meta.note ?? null);
  return { ok: true, data: { version: meta.version } };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * Complete the document if every live signer has signed. Each signature is
 * committed before this runs, so the last signer to commit always sees the
 * full set; the conditional update means exactly one caller claims it.
 *
 * The signed copy is built afterwards by a participant's browser, which has
 * the key; see storeSignedCopy.
 */
export async function finalizeIfComplete(supabase: SupabaseClient, documentId: string): Promise<boolean> {
  const recipients = await loadRecipients(supabase, documentId);
  const signers = recipients.filter((r) => r.role === 'signer' && !r.revoked_at);
  if (signers.length === 0 || signers.some((r) => r.status !== 'signed')) return false;
  const now = new Date().toISOString();
  const { data: claimed } = await supabase
    .from('documents')
    .update({ status: 'completed', completed_at: now, updated_at: now })
    .eq('id', documentId)
    .eq('status', 'out_for_signature')
    .select(FULL_DOCUMENT)
    .maybeSingle();
  if (!claimed) return false;
  const doc = claimed as unknown as DocumentRow;
  await recordEvent(supabase, doc, 'completed', { actor: 'system', detail: { signers: signers.length } });
  await sendCompletedNotices(supabase, doc, recipients.filter((r) => !r.revoked_at));
  return true;
}

/** What a browser needs to build the certificate of completion. */
export async function certificateData(supabase: SupabaseClient, doc: DocumentRow) {
  const [recipients, events, business] = await Promise.all([
    loadRecipients(supabase, doc.id),
    supabase.from('document_events').select(EVENT_COLUMNS).eq('document_id', doc.id).order('id'),
    supabase.from('businesses').select('name').eq('id', doc.business_id).maybeSingle(),
  ]);
  return {
    business_name: (business.data?.name as string) || 'CoinPay business',
    completed_at: doc.completed_at,
    signers: recipients
      .filter((r) => r.role === 'signer' && r.status === 'signed' && !r.revoked_at)
      .map((s) => ({
        name: s.name,
        email: s.email,
        signature_name: s.signature_name!,
        signature_image: s.signature_image,
        consented_at: s.consented_at!,
        signed_at: s.signed_at!,
        signature_ip: s.signature_ip,
        signature_user_agent: s.signature_user_agent,
      })),
    events: ((events.data ?? []) as { created_at: string; event: string; actor_label: string | null; ip: string | null }[])
      .filter((e) => ['uploaded', 'shared', 'resent', 'revoked', 'consented', 'signed', 'completed'].includes(e.event))
      .map((e) => ({ created_at: e.created_at, event: e.event, actor_label: e.actor_label, ip: e.ip })),
  };
}

/**
 * Store the signed copy a participant's browser built and sealed. The first
 * upload wins; later ones from another signer's tab are discarded. The server
 * cannot check the contents, only that it is plausibly sealed, so only signers
 * and the owner may seal, every seal is in the audit trail, and the owner can
 * rebuild (replace) it from their own browser.
 */
export async function storeSignedCopy(
  supabase: SupabaseClient,
  doc: DocumentRow,
  sealed: Buffer,
  meta: { sha256: string; bytes: number },
  actor: { actor: 'owner' | 'recipient'; recipientId?: string; label: string | null; meta: RequestMeta },
  opts: { replace?: boolean } = {}
): Promise<Result<{ stored: boolean }>> {
  if (doc.status !== 'completed') return bad('There is no signed copy until everyone signs', 409);
  if (doc.signed_object_key && !opts.replace) return { ok: true, data: { stored: false } };
  if (sealed.length !== meta.bytes + SEAL_OVERHEAD || sealed[0] !== 0x01) return bad('That is not a sealed copy of the stated size');
  const stored = await putObject('signing', doc.business_id, sealed);
  let claim = supabase
    .from('documents')
    .update({ signed_object_key: stored.objectKey, signed_sha256: meta.sha256, signed_bytes: meta.bytes })
    .eq('id', doc.id);
  // Only the owner replaces a stored copy; everyone else can only fill an empty slot.
  claim = opts.replace && doc.signed_object_key ? claim.eq('signed_object_key', doc.signed_object_key) : claim.is('signed_object_key', null);
  const { data: won } = await claim.select('id').maybeSingle();
  if (!won) {
    await deleteObject(stored.objectKey).catch(() => undefined);
    return { ok: true, data: { stored: false } };
  }
  if (opts.replace && doc.signed_object_key) await deleteObject(doc.signed_object_key).catch(() => undefined);
  await recordEvent(supabase, doc, 'sealed', {
    actor: actor.actor,
    recipientId: actor.recipientId,
    label: actor.label,
    meta: actor.meta,
    detail: { sha256: meta.sha256, bytes: meta.bytes, replaced: Boolean(opts.replace && doc.signed_object_key) },
  });
  return { ok: true, data: { stored: true } };
}

// ---------------------------------------------------------------------------
// Recipient side (the private link)
// ---------------------------------------------------------------------------

type Access = { ok: true; doc: DocumentRow; recipient: RecipientRow } | { ok: false; status: number; error: string };

export async function accessByToken(supabase: SupabaseClient, token: string): Promise<Access> {
  if (!SIGN_TOKEN_PATTERN.test(token)) return bad('This link is not valid', 404);
  const { data } = await supabase
    .from('document_recipients')
    .select(FULL_RECIPIENT)
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  const recipient = data as unknown as RecipientRow | null;
  if (!recipient || recipient.revoked_at) return bad('This link is no longer valid', 404);
  if (recipient.expires_at && new Date(recipient.expires_at).getTime() < Date.now()) return bad('This link has expired', 410);
  const doc = await loadDocument(supabase, recipient.document_id);
  if (!doc) return bad('This link is no longer valid', 404);
  if (doc.status === 'voided') return bad('The sender voided this document', 410);
  return { ok: true, doc, recipient };
}

/** What the recipient's page shows. Opening it the first time is recorded. */
export async function loadSigningView(supabase: SupabaseClient, token: string, meta: RequestMeta) {
  const access = await accessByToken(supabase, token);
  if (!access.ok) return access;
  const { doc, recipient } = access;
  if (!recipient.viewed_at) {
    const now = new Date().toISOString();
    const { data } = await supabase
      .from('document_recipients')
      .update({ viewed_at: now, status: recipient.status === 'pending' ? 'viewed' : recipient.status })
      .eq('id', recipient.id)
      .is('viewed_at', null)
      .select('id')
      .maybeSingle();
    if (data) await recordEvent(supabase, doc, 'viewed', { actor: 'recipient', recipientId: recipient.id, label: recipient.email, meta });
  }
  const [business, others] = await Promise.all([
    supabase.from('businesses').select('name').eq('id', doc.business_id).maybeSingle(),
    loadRecipients(supabase, doc.id),
  ]);
  return {
    ok: true as const,
    data: {
      business: { name: (business.data?.name as string) || 'A CoinPay business' },
      document: {
        id: doc.id,
        business_id: doc.business_id,
        title: doc.title,
        message: doc.message,
        filename: doc.filename,
        content_type: doc.content_type,
        bytes: doc.bytes,
        sha256: doc.sha256,
        status: doc.status,
        current_version: doc.current_version,
        created_at: doc.created_at,
        completed_at: doc.completed_at,
        signed_available: Boolean(doc.signed_object_key),
        signed_sha256: doc.signed_sha256,
      },
      versions: await listVersions(supabase, doc.id),
      can_edit: recipient.role === 'editor' && !(await versionBlocker(supabase, doc)),
      // Present once complete, so this browser can build the signed copy if nobody has yet.
      certificate: doc.status === 'completed' ? await certificateData(supabase, doc) : null,
      recipient: {
        name: recipient.name,
        email: recipient.email,
        role: recipient.role,
        status: recipient.status,
        signed_at: recipient.signed_at,
        signature_name: recipient.signature_name,
      },
      // Other signers' progress, without their contact details.
      signers: others
        .filter((r) => r.role === 'signer' && !r.revoked_at)
        .map((r) => ({ name: r.name, status: r.status, signed_at: r.signed_at, you: r.id === recipient.id })),
    },
  };
}

export async function runSignAction(supabase: SupabaseClient, token: string, body: unknown, meta: RequestMeta): Promise<Result<{ status: string }>> {
  const access = await accessByToken(supabase, token);
  if (!access.ok) return access;
  const { doc, recipient } = access;
  const parsed = signActionSchema.safeParse(body);
  if (!parsed.success) return bad(zodError(parsed.error));
  const a = parsed.data;
  if (recipient.role !== 'signer') return bad('You were sent this document to view, not to sign', 403);
  if (doc.status === 'declined') return bad('This document was declined and can no longer be signed', 409);
  if (doc.status !== 'out_for_signature') return bad('This document is not waiting for signatures', 409);
  const now = new Date().toISOString();

  if (a.action === 'decline') {
    const { data } = await supabase
      .from('document_recipients')
      .update({ status: 'declined', declined_at: now, decline_reason: a.reason })
      .eq('id', recipient.id)
      .in('status', ['pending', 'viewed'])
      .select('id')
      .maybeSingle();
    if (!data) return bad('You already responded to this document', 409);
    await supabase.from('documents').update({ status: 'declined', updated_at: now }).eq('id', doc.id).eq('status', 'out_for_signature');
    await recordEvent(supabase, doc, 'declined', { actor: 'recipient', recipientId: recipient.id, label: recipient.email, meta, detail: { reason: a.reason } });
    await notifyOwnerDeclined(supabase, doc, recipient.name, a.reason);
    return { ok: true, data: { status: 'declined' } };
  }

  if (a.document_sha256 !== doc.sha256) {
    return bad('The document you opened does not match the one that was sent. Reload the page; if this persists, do not sign.', 409);
  }
  const { data } = await supabase
    .from('document_recipients')
    .update({
      status: 'signed',
      signed_document_sha256: a.document_sha256,
      consented_at: now,
      signed_at: now,
      signature_name: a.signature_name,
      signature_image: a.signature_image ?? null,
      signature_ip: meta.ip,
      signature_user_agent: meta.userAgent,
      viewed_at: recipient.viewed_at ?? now,
    })
    .eq('id', recipient.id)
    .in('status', ['pending', 'viewed'])
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (!data) return bad('You already responded to this document', 409);
  await recordEvent(supabase, doc, 'consented', { actor: 'recipient', recipientId: recipient.id, label: recipient.email, meta });
  await recordEvent(supabase, doc, 'signed', {
    actor: 'recipient',
    recipientId: recipient.id,
    label: recipient.email,
    meta,
    detail: { signature_name: a.signature_name, drawn: Boolean(a.signature_image), document_sha256: a.document_sha256 },
  });

  const signers = (await loadRecipients(supabase, doc.id)).filter((r) => r.role === 'signer' && !r.revoked_at);
  const remaining = signers.filter((r) => r.status !== 'signed').length;
  await notifyOwnerSigned(supabase, doc, recipient.name, remaining);
  const completed = remaining === 0 && (await finalizeIfComplete(supabase, doc.id));
  return { ok: true, data: { status: completed ? 'completed' : doc.status } };
}

/**
 * The sealed bytes of the current file, an earlier version (`versionNo`), or
 * the signed copy. Only a key holder can open them.
 */
export async function readSealedFile(
  supabase: SupabaseClient,
  doc: DocumentRow,
  version: 'original' | 'signed',
  versionNo?: number | null
): Promise<Result<Buffer>> {
  if (version === 'signed') {
    if (!doc.signed_object_key) return bad(doc.status === 'completed' ? 'The signed copy has not been sealed yet' : 'There is no signed copy until everyone signs', 409);
    return { ok: true, data: await getObject(doc.signed_object_key) };
  }
  if (versionNo && versionNo !== doc.current_version) {
    const { data } = await supabase.from('document_versions').select('object_key').eq('document_id', doc.id).eq('version', versionNo).maybeSingle();
    if (!data) return bad('No such version', 404);
    return { ok: true, data: await getObject(data.object_key as string) };
  }
  return { ok: true, data: await getObject(doc.object_key) };
}
