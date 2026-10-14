import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  authorize: vi.fn(),
  resolveContext: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  accept: vi.fn(),
  message: vi.fn(),
  evidence: vi.fn(),
  txRows: [] as any[],
}));

vi.mock('@/lib/auth/jwt', () => ({ verifyToken: mocks.verifyToken }));
vi.mock('@/lib/secrets', () => ({ getJwtSecret: () => 'jwt-secret' }));
vi.mock('@/lib/auth/authz', () => ({ authorizeBusinessOwner: mocks.authorize }));
vi.mock('@/lib/paypal/accounts', () => ({ resolvePaypalContext: mocks.resolveContext }));
vi.mock('@/lib/paypal/disputes', () => ({
  listPaypalDisputes: mocks.list,
  getPaypalDispute: mocks.get,
  acceptPaypalClaim: mocks.accept,
  sendPaypalDisputeMessage: mocks.message,
  providePaypalDisputeEvidence: mocks.evidence,
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ in: async () => ({ data: mocks.txRows, error: null }) }) }),
    }),
  }),
}));

import { GET as list } from './route';
import { GET as getOne } from './[id]/route';
import { POST as accept } from './[id]/accept/route';
import { POST as message } from './[id]/message/route';
import { POST as evidence } from './[id]/evidence/route';

const auth = { authorization: 'Bearer tok' };
const get = (path: string, headers: Record<string, string> = auth) =>
  new NextRequest(`http://localhost${path}`, { headers });
const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const params = { params: Promise.resolve({ id: 'PP-D-1' }) };

describe('PayPal dispute routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
    mocks.txRows = [];
    mocks.verifyToken.mockReturnValue({ userId: 'user-1' });
    mocks.authorize.mockResolvedValue({ ok: true, role: 'owner', ownerId: 'user-1' });
    mocks.resolveContext.mockResolvedValue({
      creds: { clientId: 'c', clientSecret: 's', environment: 'live' },
      callContext: { authAssertionMerchantId: 'SELLER1' },
    });
  });

  it('requires a dashboard token', async () => {
    const res = await list(get('/api/paypal/disputes?business_id=biz-1', {}));
    expect(res.status).toBe(401);
  });

  it('requires a business id', async () => {
    expect((await list(get('/api/paypal/disputes'))).status).toBe(400);
  });

  it('hides businesses the caller cannot manage', async () => {
    mocks.authorize.mockResolvedValue({ ok: false, status: 404, error: 'nope' });
    const res = await list(get('/api/paypal/disputes?business_id=other'));
    expect(res.status).toBe(404);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('lists with billing.manage in the business PayPal context, linked to CoinPay payments', async () => {
    mocks.list.mockResolvedValue([{ id: 'PP-D-1', sellerTransactionId: 'CAP-1' }, { id: 'PP-D-2', sellerTransactionId: null }]);
    mocks.txRows = [{ id: 'tx-1', invoice_number: 'INV-9', paypal_capture_id: 'CAP-1' }];

    const res = await list(get('/api/paypal/disputes?business_id=biz-1'));
    const body = await res.json();

    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), 'user-1', 'biz-1', 'billing.manage');
    expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c', authAssertionMerchantId: 'SELLER1' }));
    expect(body.disputes[0]).toMatchObject({ id: 'PP-D-1', transactionId: 'tx-1', invoiceNumber: 'INV-9' });
    expect(body.disputes[1]).toMatchObject({ id: 'PP-D-2', transactionId: null });
  });

  it('maps a PayPal 404 (not this merchant) to 404', async () => {
    mocks.get.mockRejectedValue(Object.assign(new Error('PayPal get dispute failed (404)'), { status: 404 }));
    const res = await getOne(get('/api/paypal/disputes/PP-D-1?business_id=biz-1'), params);
    expect(res.status).toBe(404);
  });

  it('accepting a claim needs funds.move', async () => {
    mocks.accept.mockResolvedValue(undefined);
    const res = await accept(post('/api/paypal/disputes/PP-D-1/accept', { business_id: 'biz-1' }), params);
    expect(res.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), 'user-1', 'biz-1', 'funds.move');
    expect(mocks.accept).toHaveBeenCalledWith(expect.anything(), 'PP-D-1', 'Claim accepted by the merchant.');
  });

  it('validates messages and evidence before calling PayPal', async () => {
    expect((await message(post('/x', { business_id: 'biz-1', message: '  ' }), params)).status).toBe(400);
    expect((await evidence(post('/x', { business_id: 'biz-1', notes: 'short' }), params)).status).toBe(400);
    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.evidence).not.toHaveBeenCalled();

    mocks.evidence.mockResolvedValue(undefined);
    const res = await evidence(
      post('/x', { business_id: 'biz-1', notes: 'Delivered on 10/12 via courier', tracking_number: '1Z9' }),
      params
    );
    expect(res.status).toBe(200);
    expect(mocks.evidence).toHaveBeenCalledWith(expect.anything(), 'PP-D-1', {
      notes: 'Delivered on 10/12 via courier',
      trackingNumber: '1Z9',
      carrier: null,
    });
  });
});
