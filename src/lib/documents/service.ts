import { createHash, randomBytes } from 'crypto';
import type { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { clientAddress } from '@/lib/cloud-gate';

export { fail, json, readJson, zodError } from '@/lib/contractors/service';
export * from './types';
import { ALLOWED_CONTENT_TYPES, MAX_DOCUMENT_BYTES } from './types';

/**
 * Documents: a business uploads a file, shares it with people by private link,
 * and collects electronic signatures. When every signer has signed, CoinPay
 * produces a signed copy (the original plus a certificate of completion) and
 * mails it to everyone.
 *
 * Reads need business.read and changes invoice.write, like contractors. The
 * recipient side needs no account: the link is the credential, and only its
 * sha256 is stored.
 */

export const DOCUMENT_COLUMNS =
  'id, business_id, title, message, filename, content_type, bytes, sha256, wrapped_key, vault_version, current_version, status, ' +
  'signed_sha256, signed_bytes, ' +
  'completed_at, voided_at, void_reason, created_at, updated_at';
export const RECIPIENT_COLUMNS =
  'id, document_id, name, email, role, status, sent_at, viewed_at, consented_at, signed_at, signature_name, ' +
  'signature_ip, signed_document_sha256, declined_at, decline_reason, expires_at, revoked_at, created_at';
export const VERSION_COLUMNS = 'version, filename, content_type, bytes, sha256, note, uploaded_by, created_at';
export const EVENT_COLUMNS = 'id, recipient_id, actor, event, actor_label, ip, user_agent, detail, created_at';

export type DocumentStatus = 'draft' | 'shared' | 'out_for_signature' | 'completed' | 'declined' | 'voided';

export interface DocumentRow {
  id: string;
  business_id: string;
  title: string;
  message: string | null;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  wrapped_key: string;
  vault_version: number;
  current_version: number;
  object_key: string;
  status: DocumentStatus;
  signed_object_key: string | null;
  signed_sha256: string | null;
  signed_bytes: number | null;
  completed_at: string | null;
  voided_at: string | null;
  created_at: string;
}

export interface RecipientRow {
  id: string;
  document_id: string;
  business_id: string;
  name: string;
  email: string;
  role: 'signer' | 'viewer' | 'editor';
  status: 'pending' | 'viewed' | 'signed' | 'declined';
  sent_at: string | null;
  viewed_at: string | null;
  consented_at: string | null;
  signed_at: string | null;
  signature_name: string | null;
  signature_image: string | null;
  signature_ip: string | null;
  signature_user_agent: string | null;
  signed_document_sha256: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

// ---------------------------------------------------------------------------
// Tokens and links
// ---------------------------------------------------------------------------

export const SIGN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newSignToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'https://coinpayportal.com').replace(/\/$/, '');
}

/** The link without the key. The sender's browser appends `#k=` before showing it. */
export function signUrl(token: string): string {
  return `${appUrl()}/sign/${token}`;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const recipientInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().toLowerCase().email().max(320),
    // viewer: open and download; editor: also upload new versions; signer: sign.
    role: z.enum(['signer', 'viewer', 'editor']).default('signer'),
    expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
  })
  .strict();

const b64urlKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Expected a 256-bit base64url key');
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a sha256 hex digest');
const wrappedKey = z.string().regex(/^[A-Za-z0-9_-]{40,200}$/, 'Expected a wrapped key');

export const shareSchema = z
  .object({
    recipients: z.array(recipientInput).min(1).max(25),
    message: z.string().trim().max(2000).nullable().optional(),
    send_email: z.boolean().optional(),
    /**
     * Opt-in convenience: the document key, used once to put the full link in
     * the invite emails and never stored. Without it the emails carry the link
     * without the key, and the sender passes the full link on another channel.
     */
    email_document_key: b64urlKey.optional(),
  })
  .strict();

export const uploadMetaSchema = z
  .object({
    id: z.string().uuid(),
    business_id: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    message: z.string().trim().max(2000).nullable().optional(),
    filename: z.string().min(1).max(255),
    content_type: z.string().refine((t) => ALLOWED_CONTENT_TYPES.has(t), 'Unsupported file type'),
    bytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
    sha256,
    wrapped_key: wrappedKey,
    vault_version: z.number().int().min(1),
  })
  .strict();

export const vaultSchema = z
  .object({
    business_id: z.string().uuid(),
    kdf_salt: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    kdf_iterations: z.number().int().min(100_000).max(10_000_000),
    wrapped_key: wrappedKey,
  })
  .strict();

/** A new version, sealed under the document key with its number in the AAD. */
export const versionMetaSchema = z
  .object({
    version: z.number().int().min(2),
    filename: z.string().min(1).max(255),
    content_type: z.string().refine((t) => ALLOWED_CONTENT_TYPES.has(t), 'Unsupported file type'),
    bytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
    sha256,
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

/** The signed copy, as its uploader's browser built and sealed it. */
export const sealedCopyMetaSchema = z.object({ sha256, bytes: z.number().int().positive() }).strict();

export const documentPatchSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rename'), title: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal('void'), reason: z.string().trim().max(1000).optional() }).strict(),
]);

/** A drawn signature: a PNG data URL, small enough to keep in the row. */
const signatureImage = z
  .string()
  .max(400_000)
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/, 'Expected a PNG data URL');

export const signActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('sign'),
      signature_name: z.string().trim().min(2).max(200),
      signature_image: signatureImage.nullable().optional(),
      // What the signer's browser decrypted and showed; must match the upload.
      document_sha256: sha256,
      consent: z.literal(true, { errorMap: () => ({ message: 'You must agree to sign electronically' }) }),
    })
    .strict(),
  z.object({ action: z.literal('decline'), reason: z.string().trim().min(1).max(1000) }).strict(),
]);

// ---------------------------------------------------------------------------
// Status and audit
// ---------------------------------------------------------------------------

/** The status a document should have given who it is shared with. */
export function statusFor(
  current: DocumentStatus,
  recipients: Pick<RecipientRow, 'role' | 'status' | 'revoked_at'>[]
): DocumentStatus {
  if (current === 'completed' || current === 'declined' || current === 'voided') return current;
  const live = recipients.filter((r) => !r.revoked_at);
  const signers = live.filter((r) => r.role === 'signer');
  if (signers.length > 0) return signers.every((r) => r.status === 'signed') ? 'completed' : 'out_for_signature';
  return live.length > 0 ? 'shared' : 'draft';
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export function requestMeta(request: NextRequest | Request): RequestMeta {
  return {
    ip: clientAddress(request)?.slice(0, 64) ?? null,
    userAgent: request.headers.get('user-agent')?.slice(0, 500) ?? null,
  };
}

export async function recordEvent(
  supabase: SupabaseClient,
  doc: { id: string; business_id: string },
  event: string,
  opts: {
    actor: 'owner' | 'recipient' | 'system';
    recipientId?: string | null;
    label?: string | null;
    meta?: RequestMeta;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  const { error } = await supabase.from('document_events').insert({
    document_id: doc.id,
    business_id: doc.business_id,
    recipient_id: opts.recipientId ?? null,
    actor: opts.actor,
    event,
    actor_label: opts.label?.slice(0, 400) ?? null,
    ip: opts.meta?.ip ?? null,
    user_agent: opts.meta?.userAgent ?? null,
    detail: opts.detail ?? null,
  });
  if (error) console.error('[documents] audit insert failed:', event, error.message);
}
