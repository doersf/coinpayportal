/**
 * TRON keys: derivation from a BIP39 mnemonic and the address of a private key.
 *
 * A TRON account is a secp256k1 key, exactly like Ethereum: the account id is
 * the last 20 bytes of keccak256(uncompressed public key). Encoding lives in
 * ./address-codec and is re-exported here.
 */

import { ethers } from 'ethers';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { tronHexToBase58 } from './address-codec';

export * from './address-codec';

/** SLIP-44 coin type 195, the path every TRON wallet (TronLink, Exodus, Ledger) uses. */
export function tronDerivationPath(index: number, account = 0): string {
  return `m/44'/195'/${account}'/0/${index}`;
}

/** Address of a secp256k1 private key (hex, with or without 0x). */
export function tronAddressFromPrivateKey(privateKeyHex: string): string {
  const pk = privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`;
  const evm = ethers.computeAddress(pk); // 0x + keccak256(pubkey)[12:]
  return tronHexToBase58(evm);
}

/** Derive a TRON key pair from a BIP39 mnemonic at m/44'/195'/{account}'/0/{index}. */
export function deriveTronWallet(
  mnemonic: string,
  index: number,
  account = 0
): { address: string; privateKey: string; derivationPath: string } {
  const path = tronDerivationPath(index, account);
  const child = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic)).derive(path);
  if (!child.privateKey) throw new Error('Failed to derive TRON keys');
  const privateKey = Buffer.from(child.privateKey).toString('hex');
  return { address: tronAddressFromPrivateKey(privateKey), privateKey, derivationPath: path };
}
