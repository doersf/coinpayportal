import { describe, it, expect, vi } from 'vitest';
import { associatedTokenAddress, getSplTokenBalance } from './solana-token-balance';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OWNER = 'FX8QhU1TPUHGs2X8PibbHikd4YvdQMPfVuFd6mqk9qJw';

function res(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as Response;
}

describe('getSplTokenBalance', () => {
  it('derives a stable associated token account', () => {
    expect(associatedTokenAddress(OWNER, USDC)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(associatedTokenAddress(OWNER, USDC)).toBe(associatedTokenAddress(OWNER, USDC));
  });

  it('treats a missing token account as zero', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { error: { code: -32602, message: 'Invalid param: could not find account' } }));
    expect(await getSplTokenBalance(OWNER, 'http://rpc', USDC, 6, { fetchImpl })).toBe(0);
  });

  it('retries a 429 (the failure that hid every USDC_SOL payment)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, { error: { code: 429, message: 'Too many requests for a specific RPC call' } }))
      .mockResolvedValueOnce(res(200, { error: { code: 429, message: 'Connection rate limits exceeded' } }))
      .mockResolvedValueOnce(res(200, { result: { value: { amount: '1010203', decimals: 6 } } }));
    expect(await getSplTokenBalance(OWNER, 'http://rpc', USDC, 6, { fetchImpl, baseDelayMs: 1 })).toBeCloseTo(1.010203);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('throws rather than report 0 when it never gets an answer', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(429, {}));
    await expect(getSplTokenBalance(OWNER, 'http://rpc', USDC, 6, { fetchImpl, retries: 2, baseDelayMs: 1 })).rejects.toThrow(/after retries/);
  });
});
