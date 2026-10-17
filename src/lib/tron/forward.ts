/**
 * Sweep a USDT (TRC-20) deposit address to the merchant and the platform.
 *
 * TRON charges for a token transfer in energy, which an account without staked
 * TRX pays for by burning TRX. A fresh deposit address holds USDT and no TRX,
 * so like an ERC-20 sweep it needs gas from somewhere: the TRON gas relayer
 * (system mnemonic, m/44'/195'/1'/0/0) sends the deposit address just enough
 * TRX for the transfers, then the deposit address signs them itself.
 *
 * Cost, as of 2026-10 (energy at 100 sun): about 64k energy (6.4 TRX) to a
 * recipient that already holds USDT and about 130k (13 TRX) to one that never
 * has. The quote's network fee covers this and is withheld as the gas reserve,
 * the same way EVM token payments recover relayer gas.
 *
 * Nothing here decides who is paid: the caller passes the recipients, already
 * bound to the payment by secure-forwarding.
 */

import { RelayerUnderfundedError } from '@/lib/wallets/evm-gas';
import type { SystemBlockchain } from '@/lib/wallets/derivation-family';
import { tronAddressFromPrivateKey } from './address';
import {
  SUN_PER_TRX,
  TronApiError,
  estimateTrc20TransferEnergy,
  getChainFees,
  getTrc20Balance,
  getTrxBalanceSun,
  sendTrc20,
  sendTrx,
  toTokenUnits,
  tronApiUrl,
} from './client';
import { fetchWithTimeout } from '@/lib/http/fetch-timeout';

/** Used when the node will not dry-run a transfer: the worst case (recipient never held USDT). */
export const FALLBACK_TRANSFER_ENERGY = 131_000;
/** Bytes of bandwidth a TRC-20 transfer uses, rounded up. Burned at getTransactionFee when the free allowance is gone. */
const TRANSFER_BANDWIDTH_BYTES = 350n;
/** Hard ceiling on what one transfer may burn, whatever the estimate says. */
const MAX_FEE_LIMIT_SUN = 100n * SUN_PER_TRX;

/**
 * Relayer shortfall on TRON. Amounts are carried in the parent's wei fields
 * scaled by 1e12 so that formatEther prints TRX (6 decimals) correctly in the
 * existing ops alert.
 */
export class TronRelayerUnderfundedError extends RelayerUnderfundedError {
  constructor(params: { relayerAddress: string; balanceSun: bigint; neededSun: bigint; purpose: string }) {
    super({
      relayerAddress: params.relayerAddress,
      cryptocurrency: 'USDT_TRON' as SystemBlockchain,
      balanceWei: params.balanceSun * 10n ** 12n,
      neededWei: params.neededSun * 10n ** 12n,
      purpose: params.purpose,
    });
    this.message =
      `TRON gas relayer ${params.relayerAddress} has ${Number(params.balanceSun) / 1e6} TRX but needs ` +
      `~${Number(params.neededSun) / 1e6} TRX ${params.purpose}. Top up the relayer.`;
  }
}

export interface TronForwardRecipient {
  address: string;
  amount: number;
}

export interface TronForwardResult {
  merchantTxHash: string;
  platformTxHash: string;
  topUpTxHash?: string;
}

interface Deps {
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the top-up and for each transfer's receipt. */
  timeoutMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Receipt of a transaction from the latest block (not yet solidified): fast, and enough to know it executed. */
async function waitForReceipt(txId: string, deps: Deps): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + (deps.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(
      `${tronApiUrl()}/wallet/gettransactioninfobyid`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.TRON_PRO_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_PRO_API_KEY } : {}),
        },
        body: JSON.stringify({ value: txId }),
      },
      15_000
    ).catch(() => null);
    const info = res && res.ok ? await res.json().catch(() => null) : null;
    if (info && info.id) {
      return info.receipt?.result ?? (info.result === 'FAILED' ? 'FAILED' : 'SUCCESS');
    }
    await sleep(3_000);
  }
  throw new TronApiError(`Transaction ${txId} was not included within the wait window`);
}

/**
 * TRX the deposit address needs to send every leg: estimated energy x price,
 * plus bandwidth, plus 20% headroom. Also returns the per-leg fee limit.
 */
export async function planTronSweepFees(
  from: string,
  legs: Array<{ address: string; units: bigint }>
): Promise<{ neededSun: bigint; feeLimitsSun: bigint[] }> {
  const fees = await getChainFees();
  let neededSun = 0n;
  const feeLimitsSun: bigint[] = [];
  for (const leg of legs) {
    let energy = FALLBACK_TRANSFER_ENERGY;
    try {
      energy = await estimateTrc20TransferEnergy(from, leg.address, leg.units);
    } catch {
      // The dry-run can be refused for an account with no TRX; assume the worst case.
    }
    const energySun = BigInt(Math.ceil(energy)) * fees.energyFeeSun;
    const legSun = (energySun * 12n) / 10n + TRANSFER_BANDWIDTH_BYTES * fees.bandwidthFeeSun;
    neededSun += legSun;
    const limit = (energySun * 15n) / 10n + TRANSFER_BANDWIDTH_BYTES * fees.bandwidthFeeSun;
    feeLimitsSun.push(limit > MAX_FEE_LIMIT_SUN ? MAX_FEE_LIMIT_SUN : limit);
  }
  return { neededSun, feeLimitsSun };
}

/**
 * Move USDT from the deposit address to each recipient, merchant first.
 *
 * Throws TronRelayerUnderfundedError before broadcasting anything when the
 * relayer cannot pay; secure-forwarding turns that into a deferred forward.
 */
export async function forwardTronUsdtSplit(
  depositPrivateKey: string,
  recipients: TronForwardRecipient[],
  relayerPrivateKey: string,
  deps: Deps = {}
): Promise<TronForwardResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const from = tronAddressFromPrivateKey(depositPrivateKey);
  const legs = recipients
    .map((r) => ({ address: r.address, units: toTokenUnits(r.amount) }))
    .filter((l) => l.units > 0n);
  if (legs.length === 0) throw new Error('Nothing to forward');

  const total = legs.reduce((s, l) => s + l.units, 0n);
  const held = await getTrc20Balance(from, undefined, { solidified: true });
  if (held < total) {
    throw new Error(`Deposit ${from} holds ${held} USDT units, the split needs ${total}`);
  }

  const { neededSun, feeLimitsSun } = await planTronSweepFees(from, legs);

  // Gas: top the deposit address up to what the transfers will burn.
  let topUpTxHash: string | undefined;
  const have = await getTrxBalanceSun(from, { solidified: false });
  if (have < neededSun) {
    const relayerAddress = tronAddressFromPrivateKey(relayerPrivateKey);
    const topUp = neededSun - have;
    // Activating a brand-new account costs the sender 1 TRX plus bandwidth.
    const relayerNeeds = topUp + 2n * SUN_PER_TRX;
    const relayerHas = await getTrxBalanceSun(relayerAddress, { solidified: false });
    if (relayerHas < relayerNeeds) {
      throw new TronRelayerUnderfundedError({
        relayerAddress,
        balanceSun: relayerHas,
        neededSun: relayerNeeds,
        purpose: 'to pay the energy for a USDT sweep',
      });
    }
    topUpTxHash = await sendTrx(relayerPrivateKey, from, topUp);
    const deadline = Date.now() + (deps.timeoutMs ?? 90_000);
    for (;;) {
      if ((await getTrxBalanceSun(from, { solidified: false })) >= neededSun) break;
      if (Date.now() > deadline) {
        throw new TronApiError(`Gas top-up ${topUpTxHash} did not reach ${from} in time; no USDT was moved`);
      }
      await sleep(3_000);
    }
  }

  const hashes: string[] = [];
  for (let i = 0; i < legs.length; i++) {
    const txId = await sendTrc20(depositPrivateKey, legs[i].address, legs[i].units, feeLimitsSun[i]);
    const result = await waitForReceipt(txId, deps);
    if (result !== 'SUCCESS') {
      throw new TronApiError(`USDT transfer ${txId} to ${legs[i].address} failed on chain: ${result}`);
    }
    hashes.push(txId);
  }

  // Hand unused gas back to the relayer so the headroom is not stranded on a
  // deposit address nobody will use again. Best effort: the sweep is done.
  try {
    const leftover = await getTrxBalanceSun(from, { solidified: false });
    const keepForBandwidth = 400_000n; // 0.4 TRX: a TRX transfer's bandwidth if the free allowance is spent
    if (leftover > SUN_PER_TRX) {
      await sendTrx(depositPrivateKey, tronAddressFromPrivateKey(relayerPrivateKey), leftover - keepForBandwidth);
    }
  } catch (refundError) {
    console.warn(`[TRON] Could not return leftover gas from ${from}:`, refundError instanceof Error ? refundError.message : refundError);
  }

  return { merchantTxHash: hashes[0], platformTxHash: hashes[1] ?? hashes[0], topUpTxHash };
}
