import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { ethers } from 'ethers';
import { assertTxMatches, signTronTxId, toTokenUnits, fromTokenUnits } from './client';
import { deriveTronWallet, tronHexToBase58 } from './address';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function txFrom(rawHex: string) {
  return { txID: Buffer.from(sha256(Buffer.from(rawHex, 'hex'))).toString('hex'), raw_data: {}, raw_data_hex: rawHex };
}

describe('signTronTxId', () => {
  it('produces r||s||v (v = 27/28) that recovers to the signer', () => {
    const w = deriveTronWallet(MNEMONIC, 3);
    const txId = Buffer.from(sha256(Buffer.from('coinpay tron test'))).toString('hex');
    const sig = signTronTxId(txId, w.privateKey);
    expect(sig).toMatch(/^[0-9a-f]{130}$/);
    expect(['1b', '1c']).toContain(sig.slice(128));
    const recovered = ethers.recoverAddress(`0x${txId}`, `0x${sig}`);
    expect(tronHexToBase58(recovered)).toBe(w.address);
  });
});

describe('assertTxMatches', () => {
  const raw = '0a02abcd2208deadbeef0102030440f0';

  it('accepts a transaction whose id hashes its bytes and which carries our fragments', () => {
    expect(() => assertTxMatches(txFrom(raw), ['deadbeef', '0102'])).not.toThrow();
  });

  it('refuses when the id is not the hash of the bytes', () => {
    const tx = { ...txFrom(raw), txID: '00'.repeat(32) };
    expect(() => assertTxMatches(tx, [])).toThrow(/does not match/);
  });

  it('refuses when the bytes do not carry the payee or amount we asked for', () => {
    expect(() => assertTxMatches(txFrom(raw), ['cafebabe'])).toThrow(/do not contain/);
  });

  it('refuses an empty answer', () => {
    expect(() => assertTxMatches(undefined as never, [])).toThrow(/no transaction/);
  });
});

describe('token units', () => {
  it('rounds DOWN so a sweep never asks for more than the address holds', () => {
    expect(toTokenUnits(2.475)).toBe(2_475_000n);
    expect(toTokenUnits(0.0000019)).toBe(1n);
    expect(toTokenUnits(1.9999999)).toBe(1_999_999n);
    expect(toTokenUnits(0)).toBe(0n);
  });

  it('reads units back as a 6-decimal amount', () => {
    expect(fromTokenUnits(2_475_000n)).toBe(2.475);
  });
});
