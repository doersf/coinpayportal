/**
 * System key generations.
 *
 * Every deposit address CoinPay mints derives from one of the SYSTEM_MNEMONIC_*
 * seeds. When those seeds are rotated (because they leaked, or on schedule),
 * new payments must derive from the new seeds at once while payments already
 * open on old addresses keep settling. That works because each
 * `payment_addresses` row carries its own encrypted signing key: forwarding
 * never re-derives from the mnemonic, so an old address settles with no old
 * seed loaded at all.
 *
 * What this module adds:
 *
 * - `getSystemKeyGeneration()`: the generation number of the seeds currently
 *   loaded (SYSTEM_KEY_GENERATION, default 1). Every new payment/escrow address
 *   records it in `payment_addresses.key_generation`, so an operator can answer
 *   "which addresses can a holder of the old seed still sign for?" with a query.
 *
 * - A retired-seed guard. Generation 1 leaked in the 2026-10-27 dev2 compromise.
 *   Restoring an old app.env backup would silently go back to minting addresses
 *   the attacker can sweep, so a retired seed is refused outright: payment
 *   creation fails closed instead. Fingerprints are a domain-separated SHA-256
 *   of a 128/256-bit-entropy phrase, truncated, so publishing them reveals
 *   nothing about the phrase.
 */
import { createHash } from 'crypto';

/** Fingerprints of SYSTEM_MNEMONIC_* seeds that must never mint again. */
export const RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS: ReadonlySet<string> = new Set([
  // Generation 1, burned by the 2026-10-27 dev2 root compromise.
  'ed95027958f8a151',
  '42e92d34e33d27d7',
  'e3666b755635b75e',
  '081200cf5bcc9f8d',
  '631f06400fb6b035',
  '9454d649c67f8414',
  'f3a54c254bc20ebd',
]);

/** Stable, non-reversible id for a mnemonic. Never log the phrase itself. */
export function mnemonicFingerprint(mnemonic: string): string {
  const normalized = mnemonic.trim().split(/\s+/).join(' ');
  return createHash('sha256')
    .update('coinpay:system-mnemonic:v1\n' + normalized)
    .digest('hex')
    .slice(0, 16);
}

function extraRetiredFingerprints(): Set<string> {
  const raw = process.env.RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS || '';
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{16}$/.test(s)),
  );
}

export function isRetiredMnemonic(mnemonic: string): boolean {
  const fp = mnemonicFingerprint(mnemonic);
  return RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS.has(fp) || extraRetiredFingerprints().has(fp);
}

export class RetiredSystemMnemonicError extends Error {
  constructor(label: string) {
    super(
      `System mnemonic for ${label} is retired (compromised key generation). ` +
        'Load the current SYSTEM_MNEMONIC_* set; never restore an old env backup.',
    );
    this.name = 'RetiredSystemMnemonicError';
  }
}

/** Throws if `mnemonic` belongs to a retired generation. */
export function assertMnemonicNotRetired(mnemonic: string, label: string): void {
  if (isRetiredMnemonic(mnemonic)) throw new RetiredSystemMnemonicError(label);
}

/**
 * Generation number of the loaded SYSTEM_MNEMONIC_* set. Recorded on every
 * address minted, so rows from a leaked generation can be found later.
 */
export function getSystemKeyGeneration(): number {
  const raw = process.env.SYSTEM_KEY_GENERATION;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 32767) {
    throw new Error(`SYSTEM_KEY_GENERATION must be a positive integer, got "${raw}"`);
  }
  return n;
}
