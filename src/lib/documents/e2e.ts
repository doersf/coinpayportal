/**
 * End-to-end encryption for documents. Runs in the browser (and in Node for
 * tests) on WebCrypto alone; nothing here ever runs on the server with a key.
 *
 * - Every document has its own random 256-bit key (DK). The file, and later
 *   its signed copy, are AES-256-GCM encrypted with it before upload.
 * - A recipient's link carries DK in the URL fragment (`#k=...`), which a
 *   browser never sends to the server.
 * - The business keeps DK wrapped under its vault key (VK). VK is random and
 *   is itself wrapped under a key derived from the documents passphrase
 *   (PBKDF2-SHA256), so CoinPay stores only wrapped keys and ciphertext.
 *
 * Wire format of every sealed blob: version byte 0x01 || 12-byte IV || ciphertext+tag.
 */

const VERSION = 0x01;
const IV_BYTES = 12;
export const PBKDF2_ITERATIONS = 600_000;

const subtle = () => globalThis.crypto.subtle;

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function toB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('Expected a 256-bit key');
  return subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function newKey(): Uint8Array {
  return randomBytes(32);
}

/** Encrypt under a raw 256-bit key. `aad` binds the blob to its purpose. */
export async function seal(rawKey: Uint8Array, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(aad) }, await aesKey(rawKey), plain as BufferSource)
  );
  const out = new Uint8Array(1 + IV_BYTES + ct.length);
  out[0] = VERSION;
  out.set(iv, 1);
  out.set(ct, 1 + IV_BYTES);
  return out;
}

export async function open(rawKey: Uint8Array, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (sealed.length < 1 + IV_BYTES + 16 || sealed[0] !== VERSION) throw new Error('Not an encrypted document');
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  try {
    return new Uint8Array(
      await subtle().decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource, additionalData: new TextEncoder().encode(aad) },
        await aesKey(rawKey),
        sealed.subarray(1 + IV_BYTES) as BufferSource
      )
    );
  } catch {
    throw new Error('Wrong key, or the file was altered');
  }
}

/** Purpose labels used as AAD, so a blob cannot be swapped for another kind. */
export const AAD = {
  original: (documentId: string) => `coinpay-doc:original:${documentId}`,
  signed: (documentId: string) => `coinpay-doc:signed:${documentId}`,
  documentKey: (businessId: string) => `coinpay-doc:dk:${businessId}`,
  vaultKey: (businessId: string) => `coinpay-doc:vk:${businessId}`,
};

/** The key that unwraps the vault key, from the passphrase. Slow on purpose. */
export async function passphraseKey(passphrase: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, base, 256);
  return new Uint8Array(bits);
}

export interface VaultRecord {
  version: number;
  kdf_salt: string;
  kdf_iterations: number;
  wrapped_key: string;
}

/** A new vault: a random VK wrapped under the passphrase. Returns VK and the record to store. */
export async function createVault(businessId: string, passphrase: string): Promise<{ vaultKey: Uint8Array; record: Omit<VaultRecord, 'version'> }> {
  const vaultKey = newKey();
  return { vaultKey, record: await wrapVault(businessId, vaultKey, passphrase) };
}

/** The same VK under a (new) passphrase, for a passphrase change. */
export async function wrapVault(businessId: string, vaultKey: Uint8Array, passphrase: string): Promise<Omit<VaultRecord, 'version'>> {
  const salt = randomBytes(16);
  const kek = await passphraseKey(passphrase, salt);
  return {
    kdf_salt: toB64url(salt),
    kdf_iterations: PBKDF2_ITERATIONS,
    wrapped_key: toB64url(await seal(kek, vaultKey, AAD.vaultKey(businessId))),
  };
}

export async function unlockVault(businessId: string, record: Pick<VaultRecord, 'kdf_salt' | 'kdf_iterations' | 'wrapped_key'>, passphrase: string): Promise<Uint8Array> {
  const kek = await passphraseKey(passphrase, fromB64url(record.kdf_salt), record.kdf_iterations);
  try {
    return await open(kek, fromB64url(record.wrapped_key), AAD.vaultKey(businessId));
  } catch {
    throw new Error('Wrong passphrase');
  }
}

export async function wrapDocumentKey(businessId: string, vaultKey: Uint8Array, documentKey: Uint8Array): Promise<string> {
  return toB64url(await seal(vaultKey, documentKey, AAD.documentKey(businessId)));
}

export async function unwrapDocumentKey(businessId: string, vaultKey: Uint8Array, wrapped: string): Promise<Uint8Array> {
  return open(vaultKey, fromB64url(wrapped), AAD.documentKey(businessId));
}

/** `#k=<key>`: the part of a share link only the recipient's browser sees. */
export function keyFragment(documentKey: Uint8Array): string {
  return `k=${toB64url(documentKey)}`;
}

export function keyFromFragment(hash: string): Uint8Array | null {
  const match = /(?:^#?|&)k=([A-Za-z0-9_-]{43})(?:&|$)/.exec(hash);
  if (!match) return null;
  const key = fromB64url(match[1]);
  return key.length === 32 ? key : null;
}
