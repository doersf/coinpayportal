/**
 * TRON address encoding and validation, with no key or network code, so the
 * hot address-format checks can import it without ethers or bip32.
 *
 * A TRON address is 0x41 followed by the 20-byte account id (the same
 * keccak256-of-pubkey id Ethereum uses), written base58check with a
 * double-SHA256 checksum. That is where the leading "T" comes from. The hex
 * form (41 + 40 hex) is what ABI parameters and raw transactions carry.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

export const TRON_ADDRESS_PREFIX = 0x41;

function checksum(payload: Uint8Array): Uint8Array {
  return sha256(sha256(payload)).slice(0, 4);
}

/** 21-byte payload (0x41 + 20 bytes) to a base58check "T…" address. */
export function tronBytesToBase58(bytes21: Uint8Array): string {
  if (bytes21.length !== 21 || bytes21[0] !== TRON_ADDRESS_PREFIX) {
    throw new Error('A TRON address payload is 21 bytes starting with 0x41');
  }
  const out = new Uint8Array(25);
  out.set(bytes21, 0);
  out.set(checksum(bytes21), 21);
  return bs58.encode(out);
}

/**
 * Decode a base58check TRON address to its 21-byte payload, or null when it is
 * not one (wrong length, wrong prefix, bad checksum, not base58).
 */
export function tronBase58ToBytes(address: string): Uint8Array | null {
  if (typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return null;
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    return null;
  }
  if (decoded.length !== 25 || decoded[0] !== TRON_ADDRESS_PREFIX) return null;
  const payload = decoded.slice(0, 21);
  const sum = checksum(payload);
  for (let i = 0; i < 4; i++) if (sum[i] !== decoded[21 + i]) return null;
  return payload;
}

export function isValidTronAddress(address: string): boolean {
  return tronBase58ToBytes(address) !== null;
}

/** "T…" -> "41…" (42 lowercase hex chars). Throws on an invalid address. */
export function tronBase58ToHex(address: string): string {
  const bytes = tronBase58ToBytes(address);
  if (!bytes) throw new Error(`Invalid TRON address: ${address}`);
  return Buffer.from(bytes).toString('hex');
}

/** "41…" (or the bare 40-hex EVM-style body) -> "T…". */
export function tronHexToBase58(hex: string): string {
  const clean = hex.replace(/^0x/i, '').toLowerCase();
  const body = clean.length === 40 ? `41${clean}` : clean;
  if (!/^41[0-9a-f]{40}$/.test(body)) throw new Error(`Invalid TRON hex address: ${hex}`);
  return tronBytesToBase58(Uint8Array.from(Buffer.from(body, 'hex')));
}

/** The 20-byte account id as 64-hex ABI word (left-padded), for transfer()/balanceOf(). */
export function tronAddressAbiWord(address: string): string {
  return tronBase58ToHex(address).slice(2).padStart(64, '0');
}
