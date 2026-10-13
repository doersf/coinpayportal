/**
 * Nano (XNO) support for the x402 facilitator.
 *
 * Like every other non-Stripe rail here, the buyer pays the merchant's own
 * address directly and nothing is held or forwarded by CoinPayPortal. The
 * payer publishes a send block from their own wallet and presents its hash;
 * this module only asks a Nano node what that block is. There is no private
 * key and no broadcast on the server side.
 *
 * A proof is accepted only when the node reports the block as:
 *   - confirmed (cemented) — Nano has no "pending confirmation" middle ground
 *     worth serving on, and an unconfirmed block can still lose an election,
 *   - a send (a receive or change block moves nothing to the merchant),
 *   - addressed to the merchant's `payTo`,
 *   - for at least the asking price, in raw (1 XNO = 10^30 raw).
 *
 * Any failure to reach the node, or any answer that is not clearly all four,
 * is a refusal: an unreachable node is not evidence of payment.
 */

import { blake2b } from '@noble/hashes/blake2.js';

/** Raw units per XNO. Amounts are compared as BigInt, never as numbers. */
export const RAW_PER_XNO = 10n ** 30n;

/** Nano's base32 alphabet (no 0, 2, l, v). */
const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';

const ADDRESS_RE = /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;
const BLOCK_HASH_RE = /^[0-9A-F]{64}$/;

function decodeBase32(chars: string): bigint {
  let value = 0n;
  for (const c of chars) {
    const index = ALPHABET.indexOf(c);
    if (index < 0) throw new Error(`Invalid Nano address character: ${c}`);
    value = (value << 5n) | BigInt(index);
  }
  return value;
}

function encodeBase32(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

/** The 5-byte checksum Nano appends to an address: blake2b-40, byte-reversed. */
function checksum(publicKey: Uint8Array): bigint {
  return bytesToBigInt(blake2b(publicKey, { dkLen: 5 }).reverse());
}

/**
 * Decode a `nano_` / `xrb_` address to its 32-byte public key, or null when
 * the address is malformed or its checksum does not match.
 */
export function nanoPublicKeyFromAddress(address: unknown): Uint8Array | null {
  if (typeof address !== 'string') return null;
  const value = address.trim();
  if (!ADDRESS_RE.test(value)) return null;

  const body = value.slice(value.indexOf('_') + 1);
  const keyBits = decodeBase32(body.slice(0, 52)); // 4 padding bits + 256-bit key
  if (keyBits >> 256n !== 0n) return null;

  const publicKey = bigIntToBytes(keyBits, 32);
  if (decodeBase32(body.slice(52)) !== checksum(publicKey)) return null;
  return publicKey;
}

/** Encode a 32-byte public key as a `nano_` address. */
export function nanoAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Nano public key must be 32 bytes');
  return `nano_${encodeBase32(bytesToBigInt(publicKey), 52)}${encodeBase32(checksum(publicKey), 8)}`;
}

/** True for a well-formed `nano_` / `xrb_` address with a valid checksum. */
export function isValidNanoAddress(address: unknown): boolean {
  return nanoPublicKeyFromAddress(address) !== null;
}

/**
 * Canonical stored form of a Nano address: `nano_` prefix, lowercase.
 *
 * `xrb_` is the legacy prefix for the same key, so both forms of one account
 * must compare equal.
 */
export function normalizeNanoAddress(address: string): string {
  const value = address.trim().toLowerCase();
  return value.startsWith('xrb_') ? `nano_${value.slice(4)}` : value;
}

/** Canonical block hash (64 uppercase hex chars), or null if malformed. */
export function normalizeNanoBlockHash(hash: unknown): string | null {
  if (typeof hash !== 'string') return null;
  const value = hash.trim().toUpperCase();
  return BLOCK_HASH_RE.test(value) ? value : null;
}

/** Parse a raw amount (non-negative integer string), or null. */
export function parseNanoRaw(amount: unknown): bigint | null {
  const value = String(amount ?? '').trim();
  return /^\d+$/.test(value) ? BigInt(value) : null;
}

/** A Nano node RPC call: takes the request body, resolves to the parsed JSON. */
export type NanoRpc = (body: Record<string, unknown>) => Promise<any>;

/**
 * RPC against the node named by `NANO_RPC_URL`.
 *
 * There is deliberately no public default: the node is the only witness this
 * rail has, so the operator chooses whose node to trust. Unset means the rail
 * is off and every Nano proof is refused.
 */
export function defaultNanoRpc(): NanoRpc {
  return async (body) => {
    const url = process.env.NANO_RPC_URL;
    if (!url) throw new Error('Nano RPC not configured (NANO_RPC_URL)');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Nano node returned HTTP ${res.status}`);
    return res.json();
  };
}

export type NanoVerification =
  | { valid: true; blockHash: string; amount: bigint; from: string | null }
  | { valid: false; error: string };

/**
 * Check that `blockHash` is a confirmed send of at least `amountRaw` to `payTo`.
 */
export async function verifyNanoBlock(
  params: { blockHash: unknown; payTo: unknown; amountRaw: unknown },
  rpc: NanoRpc = defaultNanoRpc(),
): Promise<NanoVerification> {
  const blockHash = normalizeNanoBlockHash(params.blockHash);
  if (!blockHash) {
    return { valid: false, error: 'Invalid Nano block hash: expected 64 hex characters' };
  }
  if (!isValidNanoAddress(params.payTo)) {
    return { valid: false, error: 'Invalid Nano payTo address' };
  }
  const owed = parseNanoRaw(params.amountRaw);
  if (owed === null || owed <= 0n) {
    return { valid: false, error: 'Invalid Nano amount: expected a positive integer in raw' };
  }

  let info: any;
  try {
    info = await rpc({ action: 'block_info', json_block: 'true', hash: blockHash });
  } catch (err: any) {
    return { valid: false, error: `Could not verify the Nano block: ${err?.message ?? err}` };
  }

  if (!info || typeof info !== 'object' || info.error) {
    return { valid: false, error: `Nano block not found: ${info?.error ?? 'empty response'}` };
  }

  if (info.confirmed !== 'true' && info.confirmed !== true) {
    return { valid: false, error: 'Nano block is not confirmed' };
  }

  const contents = info.contents ?? {};
  const isStateSend = contents.type === 'state' && info.subtype === 'send';
  const isLegacySend = contents.type === 'send';
  if (!isStateSend && !isLegacySend) {
    return { valid: false, error: `Nano block is a ${info.subtype || contents.type || 'unknown'} block, not a send` };
  }

  const destination = isStateSend ? contents.link_as_account : contents.destination;
  if (
    !isValidNanoAddress(destination) ||
    normalizeNanoAddress(destination) !== normalizeNanoAddress(String(params.payTo))
  ) {
    return { valid: false, error: `Nano block pays ${destination || '(none)'}, not ${params.payTo}` };
  }

  const paid = parseNanoRaw(info.amount);
  if (paid === null) {
    return { valid: false, error: 'Nano node returned no amount for the block' };
  }
  if (paid < owed) {
    return { valid: false, error: `Underpayment: Nano block sends ${paid} raw, resource costs ${owed} raw` };
  }

  return {
    valid: true,
    blockHash,
    amount: paid,
    from: typeof info.block_account === 'string' ? info.block_account : null,
  };
}
