import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  acceptPaypalClaim,
  getPaypalDispute,
  listPaypalDisputes,
  normalizeDispute,
  providePaypalDisputeEvidence,
  sendPaypalDisputeMessage,
} from './disputes';
import { handleDisputeEvent } from './dispute-webhook';

const mockSendWebhook = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true }));
vi.mock('@/lib/webhooks/service', () => ({ sendPaymentWebhook: mockSendWebhook }));

const partner = {
  clientId: 'PLATFORM',
  clientSecret: ['fixture', 'value'].join('-'),
  environment: 'sandbox' as const,
  authAssertionMerchantId: 'SELLER1',
  bnCode: 'BN-1',
};

const res = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body, headers: new Headers({ 'paypal-debug-id': 'dbg1' }) }) as unknown as Response;

const rawDispute = {
  dispute_id: 'PP-D-1',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  dispute_state: 'REQUIRED_ACTION',
  dispute_life_cycle_stage: 'INQUIRY',
  dispute_amount: { currency_code: 'USD', value: '25.00' },
  create_time: '2026-10-14T09:00:00Z',
  seller_response_due_date: '2026-10-24T09:00:00Z',
  disputed_transactions: [{ seller_transaction_id: 'CAP-1' }],
  allowed_response_options: { accept_claim: { accept_claim_types: ['REFUND'] } },
  messages: [{ posted_by: 'BUYER', time_posted: '2026-10-14T09:01:00Z', content: 'Never arrived' }],
};

describe('normalizeDispute', () => {
  it('flattens what the dashboard needs', () => {
    expect(normalizeDispute(rawDispute)).toMatchObject({
      id: 'PP-D-1',
      stage: 'INQUIRY',
      amount: '25.00',
      currency: 'USD',
      respondBy: '2026-10-24T09:00:00Z',
      sellerTransactionId: 'CAP-1',
      actionable: true,
      canAcceptClaim: true,
      messages: [{ postedBy: 'BUYER', content: 'Never arrived' }],
    });
    expect(normalizeDispute({ ...rawDispute, status: 'RESOLVED' }).actionable).toBe(false);
  });
});

describe('PayPal dispute calls', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const token = () => fetchMock.mockResolvedValueOnce(res(200, { access_token: 'tok' }));

  it('lists in the seller context (auth assertion + BN code)', async () => {
    token();
    fetchMock.mockResolvedValueOnce(res(200, { items: [rawDispute] }));
    const disputes = await listPaypalDisputes(partner);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api-m.sandbox.paypal.com/v1/customer/disputes?page_size=50');
    expect(init.headers['PayPal-Auth-Assertion']).toBeTruthy();
    expect(init.headers['PayPal-Partner-Attribution-Id']).toBe('BN-1');
    expect(disputes[0].id).toBe('PP-D-1');
  });

  it('turns a PayPal 404 into an error carrying the status and debug id', async () => {
    token();
    fetchMock.mockResolvedValueOnce(res(404, { message: 'Resource not found' }));
    await expect(getPaypalDispute(partner, 'nope')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/dbg1/) });
  });

  it('accepts a claim with a JSON note', async () => {
    token();
    fetchMock.mockResolvedValueOnce(res(200, {}));
    await acceptPaypalClaim(partner, 'PP-D-1', 'Refunding');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toMatch(/\/v1\/customer\/disputes\/PP-D-1\/accept-claim$/);
    expect(JSON.parse(init.body)).toEqual({ note: 'Refunding' });
  });

  it('sends messages and evidence as multipart with a JSON input part', async () => {
    token();
    fetchMock.mockResolvedValueOnce(res(200, {}));
    await sendPaypalDisputeMessage(partner, 'PP-D-1', 'Tracking attached');
    let init = fetchMock.mock.calls[1][1];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers['Content-Type']).toBeUndefined();
    expect(JSON.parse(await (init.body.get('input') as Blob).text())).toEqual({ message: 'Tracking attached' });

    token();
    fetchMock.mockResolvedValueOnce(res(200, {}));
    await providePaypalDisputeEvidence(partner, 'PP-D-1', { notes: 'Delivered by courier', trackingNumber: '1Z999' });
    init = fetchMock.mock.calls[3][1];
    const input = JSON.parse(await (init.body.get('input') as Blob).text());
    expect(input.evidences[0]).toMatchObject({
      evidence_type: 'PROOF_OF_FULFILLMENT',
      notes: 'Delivered by courier',
      evidence_info: { tracking_info: [{ tracking_number: '1Z999' }] },
    });
  });
});

describe('handleDisputeEvent', () => {
  function supabaseWith(row: Record<string, unknown> | null) {
    return {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
      })),
    };
  }
  beforeEach(() => {
    mockSendWebhook.mockClear();
  });

  it('tells the merchant about a dispute on one of their payments', async () => {
    const business = await handleDisputeEvent(
      supabaseWith({ id: 'tx-1', business_id: 'biz-1' }),
      'CUSTOMER.DISPUTE.CREATED',
      { resource: rawDispute }
    );
    expect(business).toBe('biz-1');
    expect(mockSendWebhook).toHaveBeenCalledWith(
      expect.anything(),
      'biz-1',
      'tx-1',
      'payment.disputed',
      expect.objectContaining({ dispute_id: 'PP-D-1', rail: 'paypal', status: 'WAITING_FOR_SELLER_RESPONSE' })
    );
  });

  it('uses the resolved event when PayPal decides it', async () => {
    await handleDisputeEvent(supabaseWith({ id: 'tx-1', business_id: 'biz-1' }), 'CUSTOMER.DISPUTE.RESOLVED', {
      resource: { ...rawDispute, status: 'RESOLVED' },
    });
    expect(mockSendWebhook.mock.calls[0][3]).toBe('payment.dispute_resolved');
  });

  it('ignores disputes on payments CoinPay does not know', async () => {
    expect(await handleDisputeEvent(supabaseWith(null), 'CUSTOMER.DISPUTE.CREATED', { resource: rawDispute })).toBeNull();
    expect(mockSendWebhook).not.toHaveBeenCalled();
  });
});
