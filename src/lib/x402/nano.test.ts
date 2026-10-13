import { describe, it, expect, vi } from 'vitest';
import {
  RAW_PER_XNO,
  isValidNanoAddress,
  nanoAddressFromPublicKey,
  nanoPublicKeyFromAddress,
  normalizeNanoBlockHash,
  verifyNanoBlock,
  type NanoRpc,
} from './nano';
import { checkSchemeForNetwork } from './networks';
import { addressesEqual, normalizeAddressForNetwork } from './address';

// The genesis account: a published key/address pair, so the checksum is
// checked against the network's own encoding rather than against itself.
const GENESIS_KEY = 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA';
const GENESIS_XRB = 'xrb_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const GENESIS_NANO = GENESIS_XRB.replace('xrb_', 'nano_');

const MERCHANT = nanoAddressFromPublicKey(new Uint8Array(32).fill(7));
const PAYER = nanoAddressFromPublicKey(new Uint8Array(32).fill(9));
const OTHER = nanoAddressFromPublicKey(new Uint8Array(32).fill(11));
const HASH = 'a'.repeat(64);
const PRICE = (RAW_PER_XNO / 1000n).toString(); // 0.001 XNO

function sendBlock(overrides: Record<string, unknown> = {}, contents: Record<string, unknown> = {}) {
  return {
    block_account: PAYER,
    amount: PRICE,
    confirmed: 'true',
    subtype: 'send',
    contents: { type: 'state', account: PAYER, link_as_account: MERCHANT, ...contents },
    ...overrides,
  };
}

function rpcReturning(answer: unknown): NanoRpc & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(answer) as any;
}

describe('x402 network table', () => {
  it('accepts nano with the exact scheme', () => {
    expect(checkSchemeForNetwork('nano', 'exact')).toBeNull();
  });

  it('rejects any other scheme on nano', () => {
    expect(checkSchemeForNetwork('nano', 'bolt12')).toBe('Scheme bolt12 is not valid on nano');
  });
});

describe('Nano addresses', () => {
  it('decodes the genesis address to its published key', () => {
    const key = nanoPublicKeyFromAddress(GENESIS_XRB);
    expect(Buffer.from(key!).toString('hex').toUpperCase()).toBe(GENESIS_KEY);
    expect(nanoAddressFromPublicKey(Buffer.from(GENESIS_KEY, 'hex'))).toBe(GENESIS_NANO);
  });

  it('accepts both the nano_ and legacy xrb_ prefixes', () => {
    expect(isValidNanoAddress(GENESIS_NANO)).toBe(true);
    expect(isValidNanoAddress(GENESIS_XRB)).toBe(true);
  });

  it('rejects a bad checksum', () => {
    const last = GENESIS_NANO.at(-1) === '3' ? '4' : '3';
    expect(isValidNanoAddress(GENESIS_NANO.slice(0, -1) + last)).toBe(false);
  });

  it('rejects wrong length, foreign characters and other chains', () => {
    expect(isValidNanoAddress(GENESIS_NANO.slice(0, -1))).toBe(false);
    expect(isValidNanoAddress(GENESIS_NANO.replace(/.$/, '0'))).toBe(false);
    expect(isValidNanoAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    expect(isValidNanoAddress(undefined)).toBe(false);
  });

  it('normalises xrb_ to nano_ so one account compares equal to itself', () => {
    expect(normalizeAddressForNetwork('nano', GENESIS_XRB)).toBe(GENESIS_NANO);
    expect(addressesEqual('nano', GENESIS_XRB, GENESIS_NANO)).toBe(true);
    expect(addressesEqual('nano', GENESIS_NANO, MERCHANT)).toBe(false);
  });

  it('leaves other networks untouched', () => {
    expect(normalizeAddressForNetwork('solana', GENESIS_XRB)).toBe(GENESIS_XRB);
  });
});

describe('normalizeNanoBlockHash', () => {
  it('uppercases a 64-hex hash', () => {
    expect(normalizeNanoBlockHash(HASH)).toBe(HASH.toUpperCase());
  });

  it('rejects anything else', () => {
    expect(normalizeNanoBlockHash('abc')).toBeNull();
    expect(normalizeNanoBlockHash('z'.repeat(64))).toBeNull();
    expect(normalizeNanoBlockHash(42)).toBeNull();
  });
});

describe('verifyNanoBlock', () => {
  const params = { blockHash: HASH, payTo: MERCHANT, amountRaw: PRICE };

  it('accepts a confirmed send of the price to the merchant', async () => {
    const rpc = rpcReturning(sendBlock());
    const result = await verifyNanoBlock(params, rpc);

    expect(result).toEqual({ valid: true, blockHash: HASH.toUpperCase(), amount: BigInt(PRICE), from: PAYER });
    expect(rpc).toHaveBeenCalledWith({ action: 'block_info', json_block: 'true', hash: HASH.toUpperCase() });
  });

  it('accepts an overpayment and a merchant given in xrb_ form', async () => {
    const rpc = rpcReturning(sendBlock({ amount: (BigInt(PRICE) * 2n).toString() }));
    const result = await verifyNanoBlock({ ...params, payTo: MERCHANT.replace('nano_', 'xrb_') }, rpc);
    expect(result.valid).toBe(true);
  });

  it('accepts a legacy send block', async () => {
    const rpc = rpcReturning(
      sendBlock({ subtype: undefined }, { type: 'send', link_as_account: undefined, destination: MERCHANT }),
    );
    expect((await verifyNanoBlock(params, rpc)).valid).toBe(true);
  });

  it('rejects an underpayment, comparing raw as integers', async () => {
    const rpc = rpcReturning(sendBlock({ amount: (BigInt(PRICE) - 1n).toString() }));
    const result = await verifyNanoBlock(params, rpc);
    expect(result).toEqual({ valid: false, error: expect.stringMatching(/^Underpayment/) });
  });

  it('rejects an unconfirmed block', async () => {
    const rpc = rpcReturning(sendBlock({ confirmed: 'false' }));
    expect(await verifyNanoBlock(params, rpc)).toEqual({ valid: false, error: 'Nano block is not confirmed' });
  });

  it('rejects a send to someone else', async () => {
    const rpc = rpcReturning(sendBlock({}, { link_as_account: OTHER }));
    const result = await verifyNanoBlock(params, rpc);
    expect(result.valid).toBe(false);
    expect((result as any).error).toContain(`not ${MERCHANT}`);
  });

  it('rejects a receive block, which moves nothing to the merchant', async () => {
    const rpc = rpcReturning(sendBlock({ subtype: 'receive' }));
    expect(await verifyNanoBlock(params, rpc)).toEqual({
      valid: false,
      error: 'Nano block is a receive block, not a send',
    });
  });

  it('rejects a malformed hash without asking the node', async () => {
    const rpc = rpcReturning(sendBlock());
    const result = await verifyNanoBlock({ ...params, blockHash: 'not-a-hash' }, rpc);
    expect(result.valid).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects a payTo with a bad checksum', async () => {
    const rpc = rpcReturning(sendBlock());
    const bad = MERCHANT.slice(0, -1) + (MERCHANT.at(-1) === '1' ? '3' : '1');
    expect(await verifyNanoBlock({ ...params, payTo: bad }, rpc)).toEqual({
      valid: false,
      error: 'Invalid Nano payTo address',
    });
  });

  it('rejects a zero or non-integer price', async () => {
    const rpc = rpcReturning(sendBlock());
    expect((await verifyNanoBlock({ ...params, amountRaw: '0' }, rpc)).valid).toBe(false);
    expect((await verifyNanoBlock({ ...params, amountRaw: '0.5' }, rpc)).valid).toBe(false);
  });

  it('fails closed when the node cannot be reached', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await verifyNanoBlock(params, rpc);
    expect(result).toEqual({ valid: false, error: 'Could not verify the Nano block: ECONNREFUSED' });
  });

  it('fails closed when the node reports an error', async () => {
    const rpc = rpcReturning({ error: 'Block not found' });
    expect(await verifyNanoBlock(params, rpc)).toEqual({
      valid: false,
      error: 'Nano block not found: Block not found',
    });
  });

  it('fails closed when NANO_RPC_URL is not configured', async () => {
    const previous = process.env.NANO_RPC_URL;
    delete process.env.NANO_RPC_URL;
    try {
      const result = await verifyNanoBlock(params);
      expect(result).toEqual({
        valid: false,
        error: 'Could not verify the Nano block: Nano RPC not configured (NANO_RPC_URL)',
      });
    } finally {
      if (previous !== undefined) process.env.NANO_RPC_URL = previous;
    }
  });
});
