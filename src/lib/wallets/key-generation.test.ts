import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS,
  RetiredSystemMnemonicError,
  assertMnemonicNotRetired,
  getSystemKeyGeneration,
  isRetiredMnemonic,
  mnemonicFingerprint,
} from './key-generation';
import { deriveSystemPaymentAddress, deriveGasRelayerWallet } from './system-wallet';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('key-generation', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SYSTEM_KEY_GENERATION;
    delete process.env.RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  describe('mnemonicFingerprint', () => {
    it('is 16 hex chars and stable', () => {
      const fp = mnemonicFingerprint(TEST_MNEMONIC);
      expect(fp).toMatch(/^[0-9a-f]{16}$/);
      expect(mnemonicFingerprint(TEST_MNEMONIC)).toBe(fp);
    });

    it('ignores surrounding and repeated whitespace', () => {
      expect(mnemonicFingerprint(`  ${TEST_MNEMONIC.replace(/ /g, '   ')}\n`)).toBe(
        mnemonicFingerprint(TEST_MNEMONIC),
      );
    });

    it('differs per phrase', () => {
      const other = TEST_MNEMONIC.replace(/about$/, 'abandon');
      expect(mnemonicFingerprint(other)).not.toBe(mnemonicFingerprint(TEST_MNEMONIC));
    });
  });

  describe('retired seeds', () => {
    it('ships the generation-1 fingerprints', () => {
      expect(RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS.size).toBe(7);
      for (const fp of RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS) expect(fp).toMatch(/^[0-9a-f]{16}$/);
    });

    it('does not treat the public test phrase as retired by default', () => {
      expect(isRetiredMnemonic(TEST_MNEMONIC)).toBe(false);
      expect(() => assertMnemonicNotRetired(TEST_MNEMONIC, 'BTC')).not.toThrow();
    });

    it('honours extra fingerprints from RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS', () => {
      process.env.RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS = ` junk, ${mnemonicFingerprint(TEST_MNEMONIC).toUpperCase()} `;
      expect(isRetiredMnemonic(TEST_MNEMONIC)).toBe(true);
      expect(() => assertMnemonicNotRetired(TEST_MNEMONIC, 'BTC')).toThrow(RetiredSystemMnemonicError);
    });

    it('makes address derivation and the gas relayer fail closed on a retired seed', async () => {
      process.env.SYSTEM_MNEMONIC_ETH = TEST_MNEMONIC;
      process.env.SYSTEM_MNEMONIC_SOL = TEST_MNEMONIC;
      // Works before retirement...
      await expect(deriveSystemPaymentAddress('ETH', 5)).resolves.toBeTruthy();
      expect(deriveGasRelayerWallet('POL').address).toMatch(/^0x/);

      process.env.RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS = mnemonicFingerprint(TEST_MNEMONIC);
      await expect(deriveSystemPaymentAddress('ETH', 5)).rejects.toThrow(/retired/);
      await expect(deriveSystemPaymentAddress('USDC_SOL', 5)).rejects.toThrow(/retired/);
      expect(() => deriveGasRelayerWallet('POL')).toThrow(/retired/);
    });

    it('never puts the phrase in the error message', () => {
      process.env.RETIRED_SYSTEM_MNEMONIC_FINGERPRINTS = mnemonicFingerprint(TEST_MNEMONIC);
      try {
        assertMnemonicNotRetired(TEST_MNEMONIC, 'ETH');
        throw new Error('expected throw');
      } catch (e) {
        expect((e as Error).message).not.toContain('abandon');
      }
    });
  });

  describe('getSystemKeyGeneration', () => {
    it('defaults to 1', () => {
      expect(getSystemKeyGeneration()).toBe(1);
      process.env.SYSTEM_KEY_GENERATION = '  ';
      expect(getSystemKeyGeneration()).toBe(1);
    });

    it('reads SYSTEM_KEY_GENERATION', () => {
      process.env.SYSTEM_KEY_GENERATION = '2';
      expect(getSystemKeyGeneration()).toBe(2);
    });

    it.each(['0', '-1', '1.5', 'two', '40000'])('rejects %s', (v) => {
      process.env.SYSTEM_KEY_GENERATION = v;
      expect(() => getSystemKeyGeneration()).toThrow(/SYSTEM_KEY_GENERATION/);
    });
  });
});
