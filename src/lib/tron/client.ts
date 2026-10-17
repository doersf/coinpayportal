/**
 * TRON over TronGrid's public HTTP API (java-tron's /wallet and /walletsolidity).
 *
 * No tronweb: everything CoinPay needs is a handful of JSON calls plus a
 * secp256k1 signature over the transaction id, which ethers already provides.
 *
 * Reads that decide money (deposit detection, sweep sizing) go to
 * /walletsolidity, which only reflects SOLIDIFIED blocks: TRON finalises a
 * block once 2/3 of the 27 super representatives have built on it (about 19
 * blocks, roughly a minute). A balance read there cannot be reorganised away,
 * so it doubles as the confirmation count.
 *
 * Transactions are built by the node (/wallet/createtransaction,
 * /wallet/triggersmartcontract) and signed here. Before signing, the returned
 * transaction is checked against what we asked for: the txID must be the
 * SHA-256 of raw_data_hex, and raw_data_hex must contain the owner, the
 * recipient and the amount we intended. A node that tried to swap the payee
 * would produce bytes that fail that check, and we would refuse to sign.
 *
 * Config: TRON_API_URL (default https://api.trongrid.io; https://nile.trongrid.io
 * for the Nile testnet), TRON_PRO_API_KEY (optional, raises TronGrid's rate limit),
 * TRON_USDT_CONTRACT (default mainnet USDT).
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { ethers } from 'ethers';
import { fetchWithTimeout } from '@/lib/http/fetch-timeout';
import { tronAddressAbiWord, tronAddressFromPrivateKey, tronBase58ToHex } from './address';

/** Tether's TRC-20 contract on TRON mainnet. */
export const TRON_MAINNET_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const USDT_TRON_DECIMALS = 6;
export const SUN_PER_TRX = 1_000_000n;

export function tronApiUrl(): string {
  return (process.env.TRON_API_URL || 'https://api.trongrid.io').replace(/\/+$/, '');
}

export function usdtTronContract(): string {
  return process.env.TRON_USDT_CONTRACT || TRON_MAINNET_USDT;
}

export class TronApiError extends Error {
  constructor(message: string, readonly body?: unknown) {
    super(message);
    this.name = 'TronApiError';
  }
}

/**
 * Without an API key TronGrid allows 3 requests a second per IP and suspends
 * the caller for 5 s past that (HTTP 429). Space keyless calls out
 * process-wide rather than tripping the suspension mid-sweep.
 */
const KEYLESS_MIN_GAP_MS = 400;
let nextKeylessSlot = 0;

async function pace(): Promise<void> {
  if (process.env.TRON_PRO_API_KEY) return;
  const now = Date.now();
  const wait = Math.max(0, nextKeylessSlot - now);
  nextKeylessSlot = Math.max(now, nextKeylessSlot) + KEYLESS_MIN_GAP_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

async function call<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  await pace();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.TRON_PRO_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRON_PRO_API_KEY;
  const res = await fetchWithTimeout(
    `${tronApiUrl()}${path}`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    15_000
  );
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new TronApiError(`TronGrid ${path} answered ${res.status} with non-JSON`, text.slice(0, 200));
  }
  if (!res.ok) throw new TronApiError(`TronGrid ${path} answered ${res.status}`, json);
  return json as T;
}

function hexMessage(value: unknown): string {
  if (typeof value !== 'string') return '';
  // java-tron hex-encodes many error messages.
  if (/^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    try {
      return Buffer.from(value, 'hex').toString('utf8');
    } catch {
      return value;
    }
  }
  return value;
}

/** Units -> decimal amount, exact for 6 decimals. */
export function fromTokenUnits(units: bigint, decimals = USDT_TRON_DECIMALS): number {
  return Number(units) / 10 ** decimals;
}

/** Decimal amount -> token units, rounded DOWN so a sweep never asks for more than exists. */
export function toTokenUnits(amount: number, decimals = USDT_TRON_DECIMALS): bigint {
  const [whole, frac = ''] = amount.toFixed(decimals + 2).split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals));
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * TRC-20 balanceOf at the SOLIDIFIED head (irreversible). Pass
 * `{ solidified: false }` for the latest block, e.g. to watch a top-up land.
 */
export async function getTrc20Balance(
  owner: string,
  contract = usdtTronContract(),
  opts: { solidified?: boolean } = {}
): Promise<bigint> {
  const path = opts.solidified === false ? '/wallet/triggerconstantcontract' : '/walletsolidity/triggerconstantcontract';
  const res = await call(path, {
    owner_address: owner,
    contract_address: contract,
    function_selector: 'balanceOf(address)',
    parameter: tronAddressAbiWord(owner),
    visible: true,
  });
  const word = res?.constant_result?.[0];
  if (!res?.result?.result || typeof word !== 'string') {
    throw new TronApiError(`balanceOf failed: ${hexMessage(res?.result?.message) || 'no result'}`, res);
  }
  return word.length ? BigInt(`0x${word}`) : 0n;
}

/**
 * USDT held at `address` on the solidified (irreversible) head, as a decimal.
 * This is what the payment monitors compare against the quote: a deposit is
 * only counted once it can no longer be rolled back. Throws when TronGrid
 * cannot answer, so a lookup failure is never read as "nothing paid".
 */
export async function getUsdtTronBalance(address: string): Promise<number> {
  return fromTokenUnits(await getTrc20Balance(address, usdtTronContract(), { solidified: true }));
}

/** TRX balance in sun. An address that has never received anything does not exist yet: 0. */
export async function getTrxBalanceSun(address: string, opts: { solidified?: boolean } = {}): Promise<bigint> {
  const path = opts.solidified === false ? '/wallet/getaccount' : '/walletsolidity/getaccount';
  const res = await call(path, { address, visible: true });
  return BigInt(res?.balance ?? 0);
}

export interface TronChainFees {
  /** Sun burned per unit of energy. */
  energyFeeSun: bigint;
  /** Sun burned per byte of bandwidth beyond the free daily allowance. */
  bandwidthFeeSun: bigint;
}

export async function getChainFees(): Promise<TronChainFees> {
  const res = await call('/wallet/getchainparameters', {});
  const params: Array<{ key: string; value?: number }> = res?.chainParameter ?? [];
  const get = (k: string, d: number) => BigInt(params.find((p) => p.key === k)?.value ?? d);
  return { energyFeeSun: get('getEnergyFee', 100), bandwidthFeeSun: get('getTransactionFee', 1000) };
}

/**
 * Energy a USDT transfer from `from` to `to` would burn, by dry-running it on
 * the node. Moving USDT to an address that has never held USDT costs about
 * twice as much as to one that has (the contract writes a new storage slot).
 */
export async function estimateTrc20TransferEnergy(
  from: string,
  to: string,
  units: bigint,
  contract = usdtTronContract()
): Promise<number> {
  const res = await call('/wallet/triggerconstantcontract', {
    owner_address: from,
    contract_address: contract,
    function_selector: 'transfer(address,uint256)',
    parameter: tronAddressAbiWord(to) + units.toString(16).padStart(64, '0'),
    visible: true,
  });
  const used = Number(res?.energy_used);
  if (!res?.result?.result || !Number.isFinite(used) || used <= 0) {
    throw new TronApiError(`energy estimate failed: ${hexMessage(res?.result?.message) || 'no result'}`, res);
  }
  return used;
}

export interface TronTxInfo {
  found: boolean;
  /** Contract execution result; 'SUCCESS' for a transfer that moved tokens. */
  result?: string;
  blockNumber?: number;
  feeSun?: number;
}

/** Outcome of a transaction once SOLIDIFIED. `found: false` until then. */
export async function getSolidifiedTxInfo(txId: string): Promise<TronTxInfo> {
  const res = await call('/walletsolidity/gettransactioninfobyid', { value: txId });
  if (!res || !res.id) return { found: false };
  return {
    found: true,
    // A plain TRX transfer has no receipt.result; absent means it executed.
    result: res.receipt?.result ?? (res.result === 'FAILED' ? 'FAILED' : 'SUCCESS'),
    blockNumber: res.blockNumber,
    feeSun: res.fee,
  };
}

// ── Building, checking, signing, broadcasting ────────────────────────────

interface UnsignedTx {
  txID: string;
  raw_data: any;
  raw_data_hex: string;
  visible?: boolean;
  signature?: string[];
}

/**
 * Refuse to sign anything that is not what we asked for. Throws with a reason.
 *
 * `mustContain` are lowercase hex fragments that must appear in raw_data_hex:
 * the owner's 41… id, the recipient, the amount / ABI call data.
 */
export function assertTxMatches(tx: UnsignedTx, mustContain: string[]): void {
  if (!tx || typeof tx.txID !== 'string' || typeof tx.raw_data_hex !== 'string') {
    throw new TronApiError('Node returned no transaction to sign', tx);
  }
  const computed = Buffer.from(sha256(Buffer.from(tx.raw_data_hex, 'hex'))).toString('hex');
  if (computed !== tx.txID.toLowerCase()) {
    throw new TronApiError('Transaction id does not match its raw bytes; refusing to sign');
  }
  const raw = tx.raw_data_hex.toLowerCase();
  for (const fragment of mustContain) {
    if (!raw.includes(fragment.toLowerCase())) {
      throw new TronApiError(`Transaction bytes do not contain ${fragment}; refusing to sign`);
    }
  }
}

/** 65-byte r||s||v signature over the txID, v = 27 + recovery id, as java-tron expects. */
export function signTronTxId(txId: string, privateKeyHex: string): string {
  const key = new ethers.SigningKey(privateKeyHex.startsWith('0x') ? privateKeyHex : `0x${privateKeyHex}`);
  const sig = key.sign(`0x${txId}`);
  return sig.serialized.slice(2);
}

async function signAndBroadcast(tx: UnsignedTx, privateKeyHex: string): Promise<string> {
  const signed = { ...tx, signature: [signTronTxId(tx.txID, privateKeyHex)] };
  const res = await call('/wallet/broadcasttransaction', signed as unknown as Record<string, unknown>);
  if (!res?.result) {
    throw new TronApiError(
      `Broadcast refused: ${res?.code || 'unknown'} ${hexMessage(res?.message)}`.trim(),
      res
    );
  }
  return tx.txID;
}

function amountHex(units: bigint): string {
  return units.toString(16).padStart(64, '0');
}

/** Varint (protobuf) encoding, how raw_data_hex carries a TRX amount. */
function protobufVarint(n: bigint): string {
  const bytes: number[] = [];
  let v = n;
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes).toString('hex');
}

/** Send `amountSun` TRX. Returns the txID once the node accepted it. */
export async function sendTrx(privateKeyHex: string, to: string, amountSun: bigint): Promise<string> {
  const from = tronAddressFromPrivateKey(privateKeyHex);
  const tx = await call<UnsignedTx & { Error?: string }>('/wallet/createtransaction', {
    owner_address: from,
    to_address: to,
    amount: Number(amountSun),
    visible: true,
  });
  if ((tx as any)?.Error) throw new TronApiError(`createtransaction: ${(tx as any).Error}`, tx);
  // TransferContract: field 1 owner (bytes), field 2 to (bytes), field 3 amount (varint).
  assertTxMatches(tx, [
    `0a15${tronBase58ToHex(from)}`,
    `1215${tronBase58ToHex(to)}18${protobufVarint(amountSun)}`,
  ]);
  return signAndBroadcast(tx, privateKeyHex);
}

/**
 * Send `units` of a TRC-20 token. `feeLimitSun` caps the TRX the transfer may
 * burn for energy; a transfer that would need more fails on chain (and the fee
 * spent so far is lost), so size it from estimateTrc20TransferEnergy.
 */
export async function sendTrc20(
  privateKeyHex: string,
  to: string,
  units: bigint,
  feeLimitSun: bigint,
  contract = usdtTronContract()
): Promise<string> {
  const from = tronAddressFromPrivateKey(privateKeyHex);
  const parameter = tronAddressAbiWord(to) + amountHex(units);
  const res = await call<{ result?: { result?: boolean; message?: string }; transaction?: UnsignedTx }>(
    '/wallet/triggersmartcontract',
    {
      owner_address: from,
      contract_address: contract,
      function_selector: 'transfer(address,uint256)',
      parameter,
      fee_limit: Number(feeLimitSun),
      call_value: 0,
      visible: true,
    }
  );
  if (!res?.result?.result || !res.transaction) {
    throw new TronApiError(`triggersmartcontract: ${hexMessage(res?.result?.message) || 'no transaction'}`, res);
  }
  // transfer(address,uint256) selector a9059cbb followed by our exact ABI args.
  assertTxMatches(res.transaction, [
    tronBase58ToHex(from),
    tronBase58ToHex(contract),
    `a9059cbb${parameter}`,
  ]);
  return signAndBroadcast(res.transaction, privateKeyHex);
}
