import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getPaymentPublic, safeReturnUrl } from './service';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The public payment endpoint is the only way an unauthenticated integrator can
 * read a payment — the list endpoint requires a user JWT. Both parties to a
 * payment need the transaction hashes to verify settlement on a block explorer,
 * so the selected columns are a contract, not an implementation detail.
 */

function mockSupabase(row: Record<string, unknown>) {
  const selected: string[] = [];
  const client = {
    from: vi.fn(() => client),
    select: vi.fn((fields: string) => {
      selected.push(fields);
      return client;
    }),
    eq: vi.fn(() => client),
    single: vi.fn(async () => ({ data: row, error: null })),
  } as unknown as SupabaseClient;

  return { client, selected };
}

describe('getPaymentPublic field contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selects the transaction hashes so integrators can link to a block explorer', async () => {
    const { client, selected } = mockSupabase({ id: 'pay_1' });

    await getPaymentPublic(client, 'pay_1');

    const fields = selected[0]!.split(',');
    expect(fields).toContain('tx_hash');
    expect(fields).toContain('forward_tx_hash');
  });

  it('still withholds the fields that are genuinely private', async () => {
    const { client, selected } = mockSupabase({ id: 'pay_1' });

    await getPaymentPublic(client, 'pay_1');

    const fields = selected[0]!.split(',');
    expect(fields).not.toContain('business_id');
    expect(fields).not.toContain('merchant_wallet_address');
  });

  /**
   * metadata IS selected, because the card checkout URL lives in it and the
   * checkout page needs that URL to offer a "Pay with Card" tab. Everything
   * else in the column stays private, so the guarantee is about what comes
   * back, not about what is selected.
   */
  it('publishes the card checkout URL so the pay page can offer a card tab', async () => {
    const { client } = mockSupabase({
      id: 'pay_1',
      metadata: {
        stripe_checkout_url: 'https://checkout.stripe.com/c/pay/cs_live_x',
        payment_method: 'both',
      },
    });

    const result = await getPaymentPublic(client, 'pay_1');

    expect(result.payment?.metadata?.stripe_checkout_url).toBe(
      'https://checkout.stripe.com/c/pay/cs_live_x'
    );
  });

  it('strips every other metadata key from the response', async () => {
    const { client } = mockSupabase({
      id: 'pay_1',
      metadata: {
        stripe_checkout_url: 'https://checkout.stripe.com/c/pay/cs_live_x',
        user_id: 'user-should-not-leak',
        wallet_source: 'business',
        network_fee_usd: 0.01,
        redirect_url: 'https://merchant.example/thanks',
      },
    });

    const result = await getPaymentPublic(client, 'pay_1');

    // redirect_url is the merchant's own customer-facing link, so it is
    // published; nothing else in the bag is.
    expect(Object.keys(result.payment?.metadata ?? {}).sort()).toEqual(['redirect_url', 'stripe_checkout_url']);
  });

  it('publishes http(s) return links and drops anything else', async () => {
    const { client } = mockSupabase({
      id: 'pay_1',
      metadata: {
        redirect_url: 'javascript:alert(1)',
        cancel_url: 'https://merchant.example/numbers',
        user_id: 'user-should-not-leak',
      },
    });

    const result = await getPaymentPublic(client, 'pay_1');

    expect(result.payment?.metadata).toEqual({ cancel_url: 'https://merchant.example/numbers' });
  });

  it('returns the merchant name without the business id', async () => {
    const { client, selected } = mockSupabase({
      id: 'pay_1',
      businesses: { name: 'Example Shop' },
    });

    const result = await getPaymentPublic(client, 'pay_1');

    expect(selected[0]).toContain('businesses(name)');
    expect(result.payment?.merchant_name).toBe('Example Shop');
    expect(result.payment).not.toHaveProperty('businesses');
    expect(result.payment).not.toHaveProperty('business_id');
  });
});

describe('safeReturnUrl', () => {
  it('accepts absolute http(s) URLs only', () => {
    expect(safeReturnUrl('https://shop.example/numbers?x=1')).toBe('https://shop.example/numbers?x=1');
    expect(safeReturnUrl('http://localhost:3000/back')).toBe('http://localhost:3000/back');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', '/numbers', 'shop.example', '', 42, null, 'https://u:p@shop.example/']) {
      expect(safeReturnUrl(bad)).toBeNull();
    }
  });

  it('returns null metadata for a crypto-only payment', async () => {
    const { client } = mockSupabase({
      id: 'pay_1',
      metadata: { wallet_source: 'business', network_fee_usd: 0.01 },
    });

    const result = await getPaymentPublic(client, 'pay_1');

    expect(result.payment?.metadata).toBeNull();
  });

  it('returns the hashes on the payment', async () => {
    const { client } = mockSupabase({
      id: 'pay_1',
      status: 'forwarded',
      tx_hash: 'deposit-hash',
      forward_tx_hash: 'forward-hash',
    });

    const result = await getPaymentPublic(client, 'pay_1');

    expect(result.success).toBe(true);
    expect(result.payment?.tx_hash).toBe('deposit-hash');
    expect(result.payment?.forward_tx_hash).toBe('forward-hash');
  });

  it('reports a lookup failure', async () => {
    const client = {
      from: vi.fn(() => client),
      select: vi.fn(() => client),
      eq: vi.fn(() => client),
      single: vi.fn(async () => ({ data: null, error: { message: 'not found' } })),
    } as unknown as SupabaseClient;

    const result = await getPaymentPublic(client, 'missing');

    expect(result.success).toBe(false);
    expect(result.error).toBe('not found');
  });
});
