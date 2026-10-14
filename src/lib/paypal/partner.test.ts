import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getMerchantIntegration } from './partner';

const config = {
  clientId: 'cid',
  clientSecret: 'secret',
  environment: 'sandbox' as const,
  partnerMerchantId: 'PARTNER1',
  bnCode: null,
  webhookId: null,
};

const json = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers() }) as unknown as Response;

describe('getMerchantIntegration', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolves a tracking id through ?tracking_id= before reading the integration', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: 'tok' }))
      .mockResolvedValueOnce(json(200, { merchant_id: 'SELLER1', tracking_id: 'biz-1' }))
      .mockResolvedValueOnce(
        json(200, {
          merchant_id: 'SELLER1',
          tracking_id: 'biz-1',
          payments_receivable: true,
          primary_email_confirmed: true,
          products: [
            { name: 'MOBILE_PAYMENT_ACCEPTANCE', status: 'ACTIVE' },
            { name: 'PPCP_STANDARD', vetting_status: 'SUBSCRIBED' },
            { name: 'PPCP_CUSTOM', vetting_status: 'NEED_MORE_DATA' },
          ],
        })
      );

    const result = await getMerchantIntegration({ config, merchantIdOrTrackingId: 'biz-1' });

    expect(fetchMock.mock.calls[1][0]).toContain('/merchant-integrations?tracking_id=biz-1');
    expect(fetchMock.mock.calls[2][0]).toMatch(/\/merchant-integrations\/SELLER1$/);
    expect(result).toMatchObject({ merchantIdInPaypal: 'SELLER1', paymentsReceivable: true, productStatus: 'NEED_MORE_DATA' });
  });

  it('treats the value as a merchant id when no tracking id matches', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: 'tok' }))
      .mockResolvedValueOnce(json(404, {}))
      .mockResolvedValueOnce(json(200, { merchant_id: 'SELLER2', products: [{ name: 'PPCP', vetting_status: 'SUBSCRIBED' }] }));

    const result = await getMerchantIntegration({ config, merchantIdOrTrackingId: 'SELLER2' });

    expect(fetchMock.mock.calls[2][0]).toMatch(/\/merchant-integrations\/SELLER2$/);
    expect(result?.productStatus).toBe('SUBSCRIBED');
  });

  it('returns null when PayPal has no record', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { access_token: 'tok' }))
      .mockResolvedValueOnce(json(404, {}))
      .mockResolvedValueOnce(json(404, {}));

    expect(await getMerchantIntegration({ config, merchantIdOrTrackingId: 'nobody' })).toBeNull();
  });
});
