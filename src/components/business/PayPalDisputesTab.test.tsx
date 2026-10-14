/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// A stable router, as Next's is: a fresh object per render would re-run the fetch effect forever.
const router = { push: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
const mockAuthFetch = vi.fn();
vi.mock('@/lib/auth/client', () => ({ authFetch: (...args: unknown[]) => mockAuthFetch(...args) }));

import { PayPalDisputesTab } from './PayPalDisputesTab';

const dispute = {
  id: 'PP-D-1',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  amount: '25.00',
  currency: 'USD',
  createdAt: '2026-10-14T09:00:00Z',
  respondBy: '2026-10-24T09:00:00Z',
  outcome: null,
  actionable: true,
  invoiceNumber: 'INV-9',
};

describe('PayPalDisputesTab', () => {
  // Braces matter: a function returned from beforeEach is run as cleanup.
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  it('shows the empty state', async () => {
    mockAuthFetch.mockResolvedValue({ response: { ok: true }, data: { success: true, disputes: [] } });
    render(<PayPalDisputesTab businessId="biz-1" />);
    expect(await screen.findByText('No PayPal disputes.')).toBeInTheDocument();
  });

  it('shows a load error instead of an empty table', async () => {
    mockAuthFetch.mockResolvedValue({ response: { ok: false }, data: { success: false, error: 'PayPal is not connected' } });
    render(<PayPalDisputesTab businessId="biz-1" />);
    expect(await screen.findByText('PayPal is not connected')).toBeInTheDocument();
  });

  it('lists disputes and messages the buyer from the respond panel', async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith('/api/paypal/disputes?')) return { data: { success: true, disputes: [dispute] } };
      if (init?.method === 'POST') return { data: { success: true } };
      return {
        data: {
          success: true,
          dispute: { ...dispute, messages: [{ postedBy: 'BUYER', at: '2026-10-14T09:01:00Z', content: 'Never arrived' }] },
        },
      };
    });

    render(<PayPalDisputesTab businessId="biz-1" />);
    expect(await screen.findByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('merchandise or service not received')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    expect(await screen.findByText('Never arrived')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Message the buyer'), { target: { value: 'Tracking: 1Z9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() =>
      expect(mockAuthFetch).toHaveBeenCalledWith(
        '/api/paypal/disputes/PP-D-1/message',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ business_id: 'biz-1', message: 'Tracking: 1Z9' }) }),
        expect.anything()
      )
    );
    expect(await screen.findByText('Message sent to the buyer.')).toBeInTheDocument();
  });

  it('asks for confirmation before accepting a claim', async () => {
    mockAuthFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url.startsWith('/api/paypal/disputes?')) return { data: { success: true, disputes: [dispute] } };
      if (init?.method === 'POST') return { data: { success: true } };
      return { data: { success: true, dispute } };
    });

    render(<PayPalDisputesTab businessId="biz-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Respond' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept claim (refund buyer)' }));
    expect(screen.getByText('PayPal will refund $25.00 to the buyer.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(mockAuthFetch).toHaveBeenCalledWith('/api/paypal/disputes/PP-D-1/accept', expect.objectContaining({ method: 'POST' }), expect.anything())
    );
  });
});
