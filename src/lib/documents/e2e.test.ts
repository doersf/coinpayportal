import { describe, expect, it } from 'vitest';
import {
  AAD,
  createVault,
  fromB64url,
  keyFragment,
  keyFromFragment,
  newKey,
  open,
  seal,
  sha256Hex,
  toB64url,
  unlockVault,
  unwrapDocumentKey,
  wrapDocumentKey,
  wrapVault,
} from './e2e';

const BUSINESS = '6f1c2d3e-0000-4000-8000-000000000001';
const DOC = '6f1c2d3e-0000-4000-8000-000000000002';
const bytes = (s: string) => new TextEncoder().encode(s);

describe('document end-to-end encryption', () => {
  it('round-trips a sealed blob and refuses the wrong key or purpose', async () => {
    const key = newKey();
    const sealed = await seal(key, bytes('the contract'), AAD.original(DOC));
    expect(sealed[0]).toBe(1);
    expect(sealed.length).toBe('the contract'.length + 29);
    expect(new TextDecoder().decode(await open(key, sealed, AAD.original(DOC)))).toBe('the contract');
    await expect(open(newKey(), sealed, AAD.original(DOC))).rejects.toThrow(/Wrong key/);
    // A sealed original cannot be passed off as the signed copy, or as another document.
    await expect(open(key, sealed, AAD.signed(DOC))).rejects.toThrow();
    await expect(open(key, sealed, AAD.original(BUSINESS))).rejects.toThrow();
    const tampered = sealed.slice();
    tampered[tampered.length - 1] ^= 1;
    await expect(open(key, tampered, AAD.original(DOC))).rejects.toThrow();
  });

  it('unlocks the vault with the passphrase, and with an older one after a change', async () => {
    const { vaultKey, record } = await createVault(BUSINESS, 'correct horse battery');
    expect(record.wrapped_key).toMatch(/^[A-Za-z0-9_-]{40,200}$/);
    expect(record.kdf_salt).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(await unlockVault(BUSINESS, record, 'correct horse battery')).toEqual(vaultKey);
    await expect(unlockVault(BUSINESS, record, 'wrong horse battery')).rejects.toThrow('Wrong passphrase');
    // A vault wrapped for one business does not open as another's.
    await expect(unlockVault(DOC, record, 'correct horse battery')).rejects.toThrow('Wrong passphrase');

    const changed = await wrapVault(BUSINESS, vaultKey, 'a brand new passphrase');
    expect(await unlockVault(BUSINESS, changed, 'a brand new passphrase')).toEqual(vaultKey);
    expect(await unlockVault(BUSINESS, record, 'correct horse battery')).toEqual(vaultKey);
  }, 30_000);

  it('wraps a document key under the vault key', async () => {
    const vaultKey = newKey();
    const documentKey = newKey();
    const wrapped = await wrapDocumentKey(BUSINESS, vaultKey, documentKey);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]{40,200}$/);
    expect(await unwrapDocumentKey(BUSINESS, vaultKey, wrapped)).toEqual(documentKey);
    await expect(unwrapDocumentKey(BUSINESS, newKey(), wrapped)).rejects.toThrow();
  });

  it('carries the key in the fragment and reads it back', () => {
    const key = newKey();
    expect(keyFromFragment(`#${keyFragment(key)}`)).toEqual(key);
    expect(keyFromFragment(`#x=1&${keyFragment(key)}`)).toEqual(key);
    expect(keyFromFragment('#k=short')).toBeNull();
    expect(keyFromFragment('')).toBeNull();
    expect(fromB64url(toB64url(key))).toEqual(key);
  });

  it('hashes like sha256sum', async () => {
    expect(await sha256Hex(bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
