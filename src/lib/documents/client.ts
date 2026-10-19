'use client';

import { getAuthToken } from '@/lib/auth/client';
import { buildSignedPdf, type CertificateInput } from './certificate';
import { contentTypeFor, MAX_DOCUMENT_BYTES } from './types';
import {
  AAD,
  createVault,
  keyFragment,
  newKey,
  open,
  seal,
  sha256Hex,
  toB64url,
  unlockVault,
  unwrapDocumentKey,
  wrapDocumentKey,
  wrapVault,
  type VaultRecord,
} from './e2e';

/**
 * Browser half of end-to-end encrypted documents. Keys live only in this
 * module's memory: an unlocked vault survives client-side navigation and is
 * gone on reload or when the tab closes. Nothing is written to storage.
 */

const unlocked = new Map<string, { key: Uint8Array; version: number }>();

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({ success: false, error: `Request failed (${res.status})` }));
  if (!res.ok || !body.success) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export async function loadVaults(businessId: string): Promise<VaultRecord[]> {
  const res = await fetch(`/api/documents/vault?business_id=${businessId}`, { headers: authHeaders(), cache: 'no-store' });
  return (await jsonOrThrow(res)).vaults;
}

export function vaultUnlocked(businessId: string): boolean {
  return unlocked.has(businessId);
}

export function lockVault(businessId: string): void {
  unlocked.delete(businessId);
}

/** First-time setup: a random vault key, wrapped under the passphrase, stored as version 1. */
export async function setupVault(businessId: string, passphrase: string): Promise<void> {
  const { vaultKey, record } = await createVault(businessId, passphrase);
  const res = await fetch('/api/documents/vault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ business_id: businessId, ...record }),
  });
  const { vault } = await jsonOrThrow(res);
  unlocked.set(businessId, { key: vaultKey, version: vault.version });
}

/** Tries the newest wrapping first; an older passphrase still opens the same key. */
export async function unlock(businessId: string, vaults: VaultRecord[], passphrase: string): Promise<void> {
  for (const v of vaults) {
    try {
      const key = await unlockVault(businessId, v, passphrase);
      unlocked.set(businessId, { key, version: v.version });
      return;
    } catch {
      // try the next version
    }
  }
  throw new Error('Wrong passphrase');
}

/** Re-wrap the unlocked vault key under a new passphrase (a new version; old ones keep working). */
export async function changePassphrase(businessId: string, passphrase: string): Promise<void> {
  const current = unlocked.get(businessId);
  if (!current) throw new Error('Unlock the vault first');
  const record = await wrapVault(businessId, current.key, passphrase);
  const res = await fetch('/api/documents/vault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ business_id: businessId, ...record }),
  });
  const { vault } = await jsonOrThrow(res);
  unlocked.set(businessId, { key: current.key, version: vault.version });
}

export async function uploadDocument(
  businessId: string,
  file: File,
  opts: { title: string; message: string | null; contentType: string; folder?: string | null }
): Promise<{ id: string }> {
  const vault = unlocked.get(businessId);
  if (!vault) throw new Error('Unlock the vault first');
  const plain = new Uint8Array(await file.arrayBuffer());
  const id = crypto.randomUUID();
  const documentKey = newKey();
  const sealed = await seal(documentKey, plain, AAD.original(id));
  const meta = {
    id,
    business_id: businessId,
    title: opts.title,
    message: opts.message,
    folder: opts.folder ?? null,
    filename: file.name,
    content_type: opts.contentType,
    bytes: plain.length,
    sha256: await sha256Hex(plain),
    wrapped_key: await wrapDocumentKey(businessId, vault.key, documentKey),
    vault_version: vault.version,
  };
  const form = new FormData();
  form.set('meta', JSON.stringify(meta));
  form.set('file', new Blob([sealed as BlobPart], { type: 'application/octet-stream' }), 'sealed.bin');
  const res = await fetch('/api/documents', { method: 'POST', headers: authHeaders(), body: form });
  const body = await jsonOrThrow(res);
  return { id: body.document.id };
}

export interface UploadItem {
  file: File;
  /** Where it goes, relative to the business's documents (null = top level). */
  folder: string | null;
}

export type UploadStatus = { state: 'queued' | 'uploading' | 'done' | 'skipped' | 'failed'; note?: string; id?: string };

/**
 * Upload many files, each encrypted under its own key, a few at a time.
 * Reports every file's state as it changes; one failure does not stop the rest.
 */
export async function uploadMany(
  businessId: string,
  items: UploadItem[],
  onStatus: (index: number, status: UploadStatus) => void,
  concurrency = 3
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const { file, folder } = items[i];
      if (file.size === 0) {
        onStatus(i, { state: 'skipped', note: 'empty file' });
        continue;
      }
      if (file.size > MAX_DOCUMENT_BYTES) {
        onStatus(i, { state: 'skipped', note: `over ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB` });
        continue;
      }
      onStatus(i, { state: 'uploading' });
      try {
        const { id } = await uploadDocument(businessId, file, {
          title: file.name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || file.name,
          message: null,
          contentType: contentTypeFor(file.name),
          folder,
        });
        onStatus(i, { state: 'done', id });
      } catch (err) {
        onStatus(i, { state: 'failed', note: err instanceof Error ? err.message : 'Upload failed' });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

/** The document key, from the unlocked vault. */
export async function documentKeyFor(doc: { business_id: string; wrapped_key: string }): Promise<Uint8Array> {
  const vault = unlocked.get(doc.business_id);
  if (!vault) throw new Error('Unlock the vault first');
  return unwrapDocumentKey(doc.business_id, vault.key, doc.wrapped_key);
}

/** A recipient link the sender can hand over: the server's link plus the key fragment. */
export function linkWithKey(url: string, documentKey: Uint8Array): string {
  return `${url}#${keyFragment(documentKey)}`;
}

export function keyText(documentKey: Uint8Array): string {
  return toB64url(documentKey);
}

/** Which blob to open: a version of the file (default the current one) or the signed copy. */
export function blobRef(
  doc: { id: string; sha256: string; current_version: number; signed_sha256?: string | null },
  which: 'current' | 'signed' | { version: number; sha256: string } = 'current'
): { aad: string; sha256: string | null; query: string } {
  if (which === 'signed') return { aad: AAD.signed(doc.id), sha256: doc.signed_sha256 ?? null, query: '?version=signed' };
  if (which === 'current') return { aad: AAD.version(doc.id, doc.current_version), sha256: doc.sha256, query: '' };
  return { aad: AAD.version(doc.id, which.version), sha256: which.sha256, query: `?n=${which.version}` };
}

/**
 * Fetch sealed bytes and open them. The sha256 must match what the uploader
 * recorded, so a swapped file is refused rather than shown.
 */
export async function fetchAndOpen(
  url: string,
  documentKey: Uint8Array,
  ref: { aad: string; sha256: string | null },
  headers: Record<string, string> = {}
): Promise<Uint8Array> {
  const res = await fetch(url, { headers, cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Download failed (${res.status})`);
  }
  const sealed = new Uint8Array(await res.arrayBuffer());
  const plain = await open(documentKey, sealed, ref.aad);
  if (ref.sha256 && (await sha256Hex(plain)) !== ref.sha256) throw new Error('This file does not match its recorded fingerprint');
  return plain;
}

/** Seal a new version under the document key and upload it as `nextVersion`. */
export async function uploadVersion(
  url: string,
  documentId: string,
  documentKey: Uint8Array,
  nextVersion: number,
  file: File,
  opts: { contentType: string; note: string | null },
  headers: Record<string, string> = {}
): Promise<void> {
  const plain = new Uint8Array(await file.arrayBuffer());
  const sealed = await seal(documentKey, plain, AAD.version(documentId, nextVersion));
  const form = new FormData();
  form.set(
    'meta',
    JSON.stringify({ version: nextVersion, filename: file.name, content_type: opts.contentType, bytes: plain.length, sha256: await sha256Hex(plain), note: opts.note })
  );
  form.set('file', new Blob([sealed as BlobPart], { type: 'application/octet-stream' }), 'sealed.bin');
  await jsonOrThrow(await fetch(url, { method: 'POST', headers, body: form }));
}

export { authHeaders as ownerHeaders };

/** Build the signed copy here, seal it under the document key, and upload it. First upload wins. */
export async function sealSignedCopy(
  uploadUrl: string,
  documentKey: Uint8Array,
  input: CertificateInput,
  headers: Record<string, string> = {}
): Promise<void> {
  const pdf = await buildSignedPdf(input);
  const sealed = await seal(documentKey, pdf, AAD.signed(input.document.id));
  const form = new FormData();
  form.set('meta', JSON.stringify({ sha256: await sha256Hex(pdf), bytes: pdf.length }));
  form.set('file', new Blob([sealed as BlobPart], { type: 'application/octet-stream' }), 'sealed.bin');
  await jsonOrThrow(await fetch(uploadUrl, { method: 'POST', headers, body: form }));
}

/** Save decrypted bytes as a file. */
export function saveBytes(bytes: Uint8Array, filename: string, contentType: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
