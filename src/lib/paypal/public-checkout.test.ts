import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveContext = vi.hoisted(() => vi.fn());
vi.mock('./accounts', () => ({ resolvePaypalContext: mockResolveContext }));

import { getPublicPaypalCheckout, paypalApproveUrl } from './public-checkout';
import { paypalSdkAttributes, paypalSdkUrl } from './sdk-url';

function supabaseWith(row: Record<string, unknown> | null) {
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: table === 'businesses' ? { name: 'Acme' } : row,
        error: null,
      }),
    })),
  } as any;
}

const row = {
  id: 'tx-1',
  business_id: 'biz-1',
  paypal_order_id: 'ORDER-1',
  status: 'pending',
  amount: '25.00',
  currency: 'usd',
  description: 'Logo design',
  metadata: { paypal_success_url: 'https://shop.example/thanks', paypal_cancel_url: 'javascript:alert(1)' },
};

const selfServe = {
  mode: 'self_serve',
  creds: { clientId: 'MERCHANT-CLIENT', clientSecret: 'TOP-SECRET', environment: 'live' },
  callContext: {},
  payeeMerchantId: null,
  environment: 'live',
};

describe('getPublicPaypalCheckout', () => {
  beforeEach(() => mockResolveContext.mockReset());

  it('returns the SDK config without the secret', async () => {
    mockResolveContext.mockResolvedValue(selfServe);
    const result = await getPublicPaypalCheckout(supabaseWith(row), 'tx-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkout).toMatchObject({
      orderId: 'ORDER-1',
      amount: 25,
      currency: 'USD',
      businessName: 'Acme',
      clientId: 'MERCHANT-CLIENT',
      mode: 'self_serve',
      merchantId: null,
      approveUrl: 'https://www.paypal.com/checkoutnow?token=ORDER-1',
      successUrl: 'https://shop.example/thanks',
      cancelUrl: null,
    });
    expect(JSON.stringify(result)).not.toContain('TOP-SECRET');
  });

  it('passes the seller and BN code in partner mode', async () => {
    mockResolveContext.mockResolvedValue({
      ...selfServe,
      mode: 'partner',
      creds: { clientId: 'PLATFORM-CLIENT', clientSecret: 'x', environment: 'sandbox' },
      callContext: { bnCode: 'BN-1', authAssertionMerchantId: 'SELLER1' },
      payeeMerchantId: 'SELLER1',
      environment: 'sandbox',
    });
    const result = await getPublicPaypalCheckout(supabaseWith(row), 'tx-1');

    expect(result.ok && result.checkout).toMatchObject({
      clientId: 'PLATFORM-CLIENT',
      merchantId: 'SELLER1',
      partnerAttributionId: 'BN-1',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1',
    });
  });

  it('refuses unknown, unbound and settled payments', async () => {
    mockResolveContext.mockResolvedValue(selfServe);
    expect(await getPublicPaypalCheckout(supabaseWith(null), 'x')).toMatchObject({ ok: false, status: 404 });
    expect(
      await getPublicPaypalCheckout(supabaseWith({ ...row, paypal_order_id: 'pending:INV-1' }), 'tx-1')
    ).toMatchObject({ ok: false, status: 409 });
    expect(await getPublicPaypalCheckout(supabaseWith({ ...row, status: 'completed' }), 'tx-1')).toMatchObject({
      ok: false,
      status: 409,
    });
    expect(mockResolveContext).not.toHaveBeenCalled();
  });
});

describe('PayPal SDK URL', () => {
  it('builds a capture-intent buttons URL', () => {
    const url = new URL(paypalSdkUrl({ clientId: 'abc', currency: 'usd' }));
    expect(url.origin + url.pathname).toBe('https://www.paypal.com/sdk/js');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      'client-id': 'abc',
      currency: 'USD',
      intent: 'capture',
      components: 'buttons',
    });
  });

  it('adds merchant-id and the partner attribution id in partner mode', () => {
    const opts = { clientId: 'abc', currency: 'USD', merchantId: 'SELLER1', partnerAttributionId: 'BN-1' };
    expect(new URL(paypalSdkUrl(opts)).searchParams.get('merchant-id')).toBe('SELLER1');
    expect(paypalSdkAttributes(opts)).toEqual({ 'data-partner-attribution-id': 'BN-1' });
    expect(paypalSdkAttributes({ clientId: 'abc', currency: 'USD' })).toEqual({});
  });

  it('points the redirect fallback at the right PayPal host', () => {
    expect(paypalApproveUrl('live', 'O1')).toBe('https://www.paypal.com/checkoutnow?token=O1');
    expect(paypalApproveUrl('sandbox', 'O1')).toBe('https://www.sandbox.paypal.com/checkoutnow?token=O1');
  });
});
