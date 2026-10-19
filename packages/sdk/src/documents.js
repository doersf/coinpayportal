/**
 * Documents: upload, share by private link and collect e-signatures, end-to-end
 * encrypted. CoinPay stores only ciphertext; every key is handled here, on
 * your machine, exactly as the web app does it in the browser
 * (src/lib/documents/e2e.ts in coinpayportal):
 *
 * - each document has its own random AES-256-GCM key (DK);
 * - the business keeps DK wrapped under its vault key (VK);
 * - VK is wrapped under a key derived from the documents passphrase (PBKDF2-SHA256);
 * - a recipient link carries DK after `#k=`, which is never sent to the server.
 *
 * Sealed blob format: 0x01 || 12-byte IV || AES-GCM ciphertext+tag.
 */

const VERSION = 0x01;
const IV_BYTES = 12;
export const PBKDF2_ITERATIONS = 600_000;

const subtle = () => globalThis.crypto.subtle;
const enc = (s) => new TextEncoder().encode(s);
const q = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString() : '';
};
const json = (method, body) => ({ method, body: JSON.stringify(body) });
const id = (v) => encodeURIComponent(v);

export const DOCUMENT_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export const GENERIC_CONTENT_TYPE = 'application/octet-stream';
export const MAX_DOCUMENT_BYTES = 9 * 1024 * 1024;

/** Known types preview in the browser; anything else is an opaque download (it is ciphertext to the server). */
export function contentTypeFor(filename) {
  const name = String(filename);
  const ext = name.includes('.') ? name.toLowerCase().split('.').pop() : '';
  return DOCUMENT_TYPES[ext] ?? GENERIC_CONTENT_TYPE;
}

/** Same rules as the web app (src/lib/documents/types.ts): '/'-joined, no '.', '..' refused, null = top level. */
export function normalizeFolder(input) {
  if (input == null) return null;
  const segments = String(input)
    .split(/[\\/]+/)
    // eslint-disable-next-line no-control-regex
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) throw new Error('Folder paths cannot contain ".."');
  if (segments.length > 20) throw new Error('Folders can be at most 20 levels deep');
  const joined = segments.map((s) => s.slice(0, 100)).join('/');
  if (joined.length > 1000) throw new Error('Folder path is too long');
  return joined || null;
}

export function isSkippedPath(relativePath) {
  return String(relativePath)
    .split(/[\\/]+/)
    .some((s) => (s.startsWith('.') && s !== '.' && s !== '..') || s === 'node_modules' || s === 'Thumbs.db' || s === 'desktop.ini');
}

export const AAD = {
  original: (documentId) => `coinpay-doc:original:${documentId}`,
  version: (documentId, n) => (n === 1 ? `coinpay-doc:original:${documentId}` : `coinpay-doc:original:${documentId}:v${n}`),
  signed: (documentId) => `coinpay-doc:signed:${documentId}`,
  documentKey: (businessId) => `coinpay-doc:dk:${businessId}`,
  vaultKey: (businessId) => `coinpay-doc:vk:${businessId}`,
};

// ---------------------------------------------------------------------------
// Crypto (byte-for-byte the same as the web app)
// ---------------------------------------------------------------------------

export function toB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

export function fromB64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

export async function sha256Hex(data) {
  return Buffer.from(await subtle().digest('SHA-256', data)).toString('hex');
}

async function aesKey(raw) {
  if (raw.length !== 32) throw new Error('Expected a 256-bit key');
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function newKey() {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export async function seal(rawKey, plain, aad) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: enc(aad) }, await aesKey(rawKey), plain));
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

export async function open(rawKey, sealed, aad) {
  if (sealed.length < 1 + IV_BYTES + 16 || sealed[0] !== VERSION) throw new Error('Not an encrypted document');
  try {
    return new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: sealed.subarray(1, 1 + IV_BYTES), additionalData: enc(aad) }, await aesKey(rawKey), sealed.subarray(1 + IV_BYTES))
    );
  } catch {
    throw new Error('Wrong key, or the file was altered');
  }
}

export async function passphraseKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await subtle().importKey('raw', enc(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
}

export async function wrapVault(businessId, vaultKey, passphrase) {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const kek = await passphraseKey(passphrase, salt);
  return { kdf_salt: toB64url(salt), kdf_iterations: PBKDF2_ITERATIONS, wrapped_key: toB64url(await seal(kek, vaultKey, AAD.vaultKey(businessId))) };
}

export async function unlockVaultRecord(businessId, record, passphrase) {
  const kek = await passphraseKey(passphrase, fromB64url(record.kdf_salt), record.kdf_iterations);
  try {
    return await open(kek, fromB64url(record.wrapped_key), AAD.vaultKey(businessId));
  } catch {
    throw new Error('Wrong passphrase');
  }
}

/** `<url>#k=<document key>`: the link a recipient needs to open the file. */
export function linkWithKey(url, documentKey) {
  return `${url}#k=${toB64url(documentKey)}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function listDocuments(client, { businessId, status, folder } = {}) {
  const data = await client.request('/documents' + q({ business_id: businessId, status, folder }));
  return data.documents ?? [];
}

/** The document (metadata only), who has it and the audit trail. */
export async function getDocument(client, documentId) {
  return client.request('/documents/' + id(documentId));
}

export async function listDocumentVaults(client, { businessId } = {}) {
  const data = await client.request('/documents/vault' + q({ business_id: businessId }));
  return data.vaults ?? [];
}

/** Create the business's documents vault (admin). Lose the passphrase and the documents are gone. */
export async function setupDocumentsVault(client, { businessId, passphrase }) {
  if (!businessId) throw new Error('businessId is required');
  if (!passphrase || passphrase.length < 10) throw new Error('Use a passphrase of at least 10 characters');
  const existing = await listDocumentVaults(client, { businessId });
  if (existing.length) throw new Error('This business already has a documents vault');
  const vaultKey = newKey();
  const data = await client.request('/documents/vault', json('POST', { business_id: businessId, ...(await wrapVault(businessId, vaultKey, passphrase)) }));
  return { vaultKey, version: data.vault.version };
}

/** The vault key, from the passphrase. Tries every version, newest first. */
export async function unlockDocumentsVault(client, { businessId, passphrase }) {
  if (!businessId) throw new Error('businessId is required');
  const vaults = await listDocumentVaults(client, { businessId });
  if (!vaults.length) throw new Error('This business has no documents vault yet; run `coinpay document vault-setup`');
  for (const v of vaults) {
    try {
      return { vaultKey: await unlockVaultRecord(businessId, v, passphrase), version: v.version };
    } catch {
      // next version
    }
  }
  throw new Error('Wrong passphrase');
}

async function documentKey(client, doc, vault) {
  return open(vault.vaultKey, fromB64url(doc.wrapped_key), AAD.documentKey(doc.business_id));
}

/** Encrypt and upload. `bytes` is the file content; `filename` decides its type. */
export async function uploadDocument(client, { businessId, vault, bytes, filename, title, message, folder }) {
  const contentType = contentTypeFor(filename);
  const plain = new Uint8Array(bytes);
  const docId = globalThis.crypto.randomUUID();
  const dk = newKey();
  const meta = {
    id: docId,
    business_id: businessId,
    title: title || String(filename).replace(/\.[A-Za-z0-9]{1,5}$/, ''),
    message: message || null,
    folder: normalizeFolder(folder),
    filename: String(filename).split(/[\\/]/).pop(),
    content_type: contentType,
    bytes: plain.length,
    sha256: await sha256Hex(plain),
    wrapped_key: toB64url(await seal(vault.vaultKey, dk, AAD.documentKey(businessId))),
    vault_version: vault.version,
  };
  const form = new FormData();
  form.set('meta', JSON.stringify(meta));
  form.set('file', new Blob([await seal(dk, plain, AAD.original(docId))], { type: 'application/octet-stream' }), 'sealed.bin');
  const data = await client.requestForm('/documents', form);
  return data.document;
}

/**
 * Share with signers and viewers. With `vault`, each returned link carries the
 * key; hand it to the person yourself. `emailKey: true` also puts the key in
 * the invite email (convenient, but the mail path can then read the document).
 */
export async function shareDocument(client, documentId, { recipients, message, sendEmail, emailKey, vault }) {
  const doc = (await getDocument(client, documentId)).document;
  const dk = vault ? await documentKey(client, doc, vault) : null;
  if (emailKey && !dk) throw new Error('emailKey needs the vault unlocked');
  const body = { recipients };
  if (message !== undefined) body.message = message;
  if (sendEmail === false) body.send_email = false;
  if (emailKey) body.email_document_key = toB64url(dk);
  const data = await client.request(`/documents/${id(documentId)}/recipients`, json('POST', body));
  return { ...data, recipients: data.recipients.map((r) => ({ ...r, link: dk ? linkWithKey(r.url, dk) : null })) };
}

/** A new link for one recipient; the old one stops working. */
export async function newDocumentLink(client, documentId, recipientId, { sendEmail, emailKey, vault } = {}) {
  const doc = (await getDocument(client, documentId)).document;
  const dk = vault ? await documentKey(client, doc, vault) : null;
  const body = {};
  if (sendEmail === false) body.send_email = false;
  if (emailKey && dk) body.email_document_key = toB64url(dk);
  const data = await client.request(`/documents/${id(documentId)}/recipients/${id(recipientId)}`, json('POST', body));
  return { url: data.url, link: dk ? linkWithKey(data.url, dk) : null };
}

export async function revokeDocumentRecipient(client, documentId, recipientId) {
  return client.request(`/documents/${id(documentId)}/recipients/${id(recipientId)}`, { method: 'DELETE' });
}

export async function voidDocument(client, documentId, { reason } = {}) {
  return client.request('/documents/' + id(documentId), json('PATCH', { action: 'void', ...(reason ? { reason } : {}) }));
}

/** File a document under another folder (null = top level). */
export async function moveDocument(client, documentId, folder) {
  return client.request('/documents/' + id(documentId), json('PATCH', { action: 'move', folder: normalizeFolder(folder) }));
}

export async function deleteDocument(client, documentId) {
  return client.request('/documents/' + id(documentId), { method: 'DELETE' });
}

/** Every version of the document, newest first (metadata; the files stay sealed). */
export async function listDocumentVersions(client, documentId) {
  const data = await client.request(`/documents/${id(documentId)}/versions`);
  return data.versions ?? [];
}

/**
 * Encrypt and upload the next version. Refused once anyone has signed;
 * earlier versions stay in the history.
 */
export async function uploadDocumentVersion(client, documentId, { vault, bytes, filename, note }) {
  const doc = (await getDocument(client, documentId)).document;
  const contentType = contentTypeFor(filename);
  const dk = await documentKey(client, doc, vault);
  const plain = new Uint8Array(bytes);
  const next = doc.current_version + 1;
  const form = new FormData();
  form.set(
    'meta',
    JSON.stringify({ version: next, filename: String(filename).split(/[\\/]/).pop(), content_type: contentType, bytes: plain.length, sha256: await sha256Hex(plain), note: note || null })
  );
  form.set('file', new Blob([await seal(dk, plain, AAD.version(documentId, next))], { type: 'application/octet-stream' }), 'sealed.bin');
  return client.requestForm(`/documents/${id(documentId)}/versions`, form);
}

/**
 * Download and decrypt the current file, an earlier `revision`, or the signed
 * copy (`version: 'signed'`), checking its sha256.
 */
export async function downloadDocument(client, documentId, { version = 'original', revision, vault }) {
  const data = await getDocument(client, documentId);
  const doc = data.document;
  const dk = await documentKey(client, doc, vault);
  if (version === 'signed') {
    const { bytes } = await client.requestBinary(`/documents/${id(documentId)}/file?version=signed`);
    const plain = await open(dk, bytes, AAD.signed(documentId));
    if (doc.signed_sha256 && (await sha256Hex(plain)) !== doc.signed_sha256) throw new Error('The file does not match its recorded sha256');
    return { bytes: plain, filename: doc.filename.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '-signed.pdf', document: doc };
  }
  const n = revision || doc.current_version;
  const entry = (data.versions ?? []).find((v) => v.version === n) ?? (n === doc.current_version ? doc : null);
  if (!entry) throw new Error('No such version');
  const { bytes } = await client.requestBinary(`/documents/${id(documentId)}/file?n=${n}`);
  const plain = await open(dk, bytes, AAD.version(documentId, n));
  if ((await sha256Hex(plain)) !== entry.sha256) throw new Error('The file does not match its recorded sha256');
  return { bytes: plain, filename: entry.filename, document: doc, revision: n };
}
