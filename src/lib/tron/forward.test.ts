import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  getTrc20Balance: vi.fn(),
  getTrxBalanceSun: vi.fn(),
  getChainFees: vi.fn(),
  estimateTrc20TransferEnergy: vi.fn(),
  sendTrx: vi.fn(),
  sendTrc20: vi.fn(),
}));

vi.mock('./client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./client')>();
  return { ...actual, ...client };
});

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/http/fetch-timeout', () => ({ fetchWithTimeout: fetchMock }));

import { forwardTronUsdtSplit, planTronSweepFees, TronRelayerUnderfundedError } from './forward';
import { RelayerUnderfundedError } from '@/lib/wallets/evm-gas';
import { deriveTronWallet } from './address';

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const deposit = deriveTronWallet(M, 20);
const relayer = deriveTronWallet(M, 0, 1);
const merchant = deriveTronWallet(M, 21).address;
const platform = deriveTronWallet(M, 22).address;
const TRX = 1_000_000n;
const noSleep = async () => {};

function receipt(result: string) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'x', receipt: { result } }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  client.getChainFees.mockResolvedValue({ energyFeeSun: 100n, bandwidthFeeSun: 1000n });
  client.estimateTrc20TransferEnergy.mockResolvedValue(64_285);
  client.getTrc20Balance.mockResolvedValue(2_500_000n);
  client.sendTrc20.mockImplementation(async (_pk: string, to: string) => `tx-${to.slice(0, 4)}`);
  client.sendTrx.mockResolvedValue('topup-tx');
  receipt('SUCCESS');
});

describe('planTronSweepFees', () => {
  it('sizes gas from the dry-run plus headroom, and caps each leg', async () => {
    const plan = await planTronSweepFees(deposit.address, [{ address: merchant, units: 1n }, { address: platform, units: 1n }]);
    // 64,285 energy x 100 sun x 1.2 + 350 bytes x 1000 sun, per leg
    expect(plan.neededSun).toBe(2n * (7_714_200n + 350_000n));
    expect(plan.feeLimitsSun).toEqual([9_992_750n, 9_992_750n]);
  });

  it('assumes the worst case when the node will not dry-run', async () => {
    client.estimateTrc20TransferEnergy.mockRejectedValue(new Error('account not found'));
    const plan = await planTronSweepFees(deposit.address, [{ address: merchant, units: 1n }]);
    expect(plan.neededSun).toBe((131_000n * 100n * 12n) / 10n + 350_000n);
  });
});

describe('forwardTronUsdtSplit', () => {
  const legs = [
    { address: merchant, amount: 2.475 },
    { address: platform, amount: 0.025 },
  ];

  it('refuses before broadcasting anything when the relayer cannot pay', async () => {
    client.getTrxBalanceSun.mockResolvedValue(0n); // deposit and relayer both empty
    const err = await forwardTronUsdtSplit(deposit.privateKey, legs, relayer.privateKey, { sleep: noSleep }).catch((e) => e);
    expect(err).toBeInstanceOf(TronRelayerUnderfundedError);
    // secure-forwarding keys "nothing was sent" off the shared parent class.
    expect(err).toBeInstanceOf(RelayerUnderfundedError);
    expect(err.relayerAddress).toBe(relayer.address);
    expect(err.message).toMatch(/TRX/);
    expect(client.sendTrx).not.toHaveBeenCalled();
    expect(client.sendTrc20).not.toHaveBeenCalled();
  });

  it('tops the deposit up, pays the merchant first, then the platform', async () => {
    let depositTrx = 0n;
    client.getTrxBalanceSun.mockImplementation(async (addr: string) =>
      addr === relayer.address ? 100n * TRX : depositTrx
    );
    client.sendTrx.mockImplementation(async (_pk: string, to: string, amount: bigint) => {
      if (to === deposit.address) depositTrx += amount;
      return 'topup-tx';
    });

    const res = await forwardTronUsdtSplit(deposit.privateKey, legs, relayer.privateKey, { sleep: noSleep });

    expect(client.sendTrx.mock.calls[0][1]).toBe(deposit.address);
    expect(client.sendTrc20.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [merchant, 2_475_000n],
      [platform, 25_000n],
    ]);
    expect(res.merchantTxHash).toBe(`tx-${merchant.slice(0, 4)}`);
    expect(res.platformTxHash).toBe(`tx-${platform.slice(0, 4)}`);
    expect(res.topUpTxHash).toBe('topup-tx');
  });

  it('skips the top-up when the deposit already holds enough TRX', async () => {
    client.getTrxBalanceSun.mockResolvedValue(50n * TRX);
    await forwardTronUsdtSplit(deposit.privateKey, legs, relayer.privateKey, { sleep: noSleep });
    // The only TRX transfer is the leftover going back to the relayer.
    expect(client.sendTrx.mock.calls.every((c) => c[1] === relayer.address)).toBe(true);
  });

  it('refuses to split more than the address holds', async () => {
    client.getTrc20Balance.mockResolvedValue(1_000_000n);
    await expect(forwardTronUsdtSplit(deposit.privateKey, legs, relayer.privateKey, { sleep: noSleep })).rejects.toThrow(/holds/);
    expect(client.sendTrc20).not.toHaveBeenCalled();
  });

  it('stops when a transfer fails on chain', async () => {
    client.getTrxBalanceSun.mockResolvedValue(50n * TRX);
    receipt('OUT_OF_ENERGY');
    await expect(forwardTronUsdtSplit(deposit.privateKey, legs, relayer.privateKey, { sleep: noSleep })).rejects.toThrow(/OUT_OF_ENERGY/);
    expect(client.sendTrc20).toHaveBeenCalledTimes(1);
  });
});
