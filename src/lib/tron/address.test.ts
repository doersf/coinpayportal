import { describe, it, expect } from 'vitest';
import {
  deriveTronWallet,
  isValidTronAddress,
  tronAddressAbiWord,
  tronAddressFromPrivateKey,
  tronBase58ToHex,
  tronHexToBase58,
} from './address';

// The public BIP39 test mnemonic. Expected values were produced independently
// with tronweb 6.0.4 (TronWeb.fromMnemonic) so these tests check the derivation
// against another implementation, not against itself.
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('deriveTronWallet', () => {
  it.each([
    [0, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', 'b5a4cea2'],
    [1, 'TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK', 'edb728e2'],
    [7, 'TFj86XAQYBPvwUknt9yxmbc4k3zwUC7iVW', 'a31c9dd2'],
  ])('index %i matches tronweb', (index, address, keyPrefix) => {
    const w = deriveTronWallet(MNEMONIC, index);
    expect(w.address).toBe(address);
    expect(w.privateKey.startsWith(keyPrefix)).toBe(true);
    expect(w.derivationPath).toBe(`m/44'/195'/0'/0/${index}`);
    expect(tronAddressFromPrivateKey(w.privateKey)).toBe(address);
  });

  it('puts the relayer on account 1, away from payment addresses', () => {
    expect(deriveTronWallet(MNEMONIC, 0, 1).address).toBe('TLrpNTBuCpGMrB9TyVwgEhNVRhtWEQPHh4');
  });
});

describe('address encoding', () => {
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  it('round-trips base58 <-> hex', () => {
    const hex = tronBase58ToHex(USDT);
    expect(hex).toMatch(/^41[0-9a-f]{40}$/);
    expect(tronHexToBase58(hex)).toBe(USDT);
    expect(tronHexToBase58(`0x${hex.slice(2)}`)).toBe(USDT);
  });

  it('validates checksum, prefix and alphabet', () => {
    expect(isValidTronAddress(USDT)).toBe(true);
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBe(false); // checksum
    expect(isValidTronAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(false);
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6')).toBe(false); // length
    expect(isValidTronAddress('')).toBe(false);
  });

  it('pads the account id into one ABI word', () => {
    const word = tronAddressAbiWord(USDT);
    expect(word).toHaveLength(64);
    expect(word.startsWith('000000000000000000000000')).toBe(true);
    expect(word.slice(24)).toBe(tronBase58ToHex(USDT).slice(2));
  });
});
