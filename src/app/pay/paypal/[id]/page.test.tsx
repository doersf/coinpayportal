/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import HostedPaypalCheckoutPage from './page';

const checkout = {
  transactionId: 'tx-1',
  orderId: 'ORDER-1',
  amount: 25,
  currency: 'USD',
  description: 'Logo design',
  businessName: 'Acme',
  clientId: 'CLIENT',
  merchantId: null,
  partnerAttributionId: null,
  approveUrl: 'https://www.paypal.com/checkoutnow?token=ORDER-1',
  successUrl: null,
  cancelUrl: null,
};

const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('hosted PayPal checkout page', () => {
  let buttonOptions: Record<string, any> | null;

  beforeEach(() => {
    buttonOptions = null;
    window.paypal = {
      Buttons: (options: Record<string, unknown>) => {
        buttonOptions = options;
        return { render: async () => undefined };
      },
    };
  });
  afterEach(() => {
    delete window.paypal;
    vi.restoreAllMocks();
  });

  async function renderPage() {
    await act(async () => {
      render(<HostedPaypalCheckoutPage params={Promise.resolve({ id: 'tx-1' })} />);
    });
  }

  it('renders the buttons for the existing order and captures on approve', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(ok({ success: true, checkout }))
      .mockResolvedValueOnce(ok({ success: true, status: 'completed' }));
    vi.stubGlobal('fetch', fetchMock);

    await renderPage();
    await waitFor(() => expect(buttonOptions).not.toBeNull());

    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('Pay Acme')).toBeInTheDocument();
    expect(screen.getByTestId('paypal-redirect-fallback')).toHaveAttribute('href', checkout.approveUrl);
    expect(await buttonOptions!.createOrder()).toBe('ORDER-1');

    await act(async () => {
      await buttonOptions!.onApprove();
    });

    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/paypal/payments/capture',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ transaction_id: 'tx-1', order_id: 'ORDER-1' }) })
    );
    expect(await screen.findByTestId('paypal-paid')).toBeInTheDocument();
  });

  it('shows the capture error and keeps the fallback link', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(ok({ success: true, checkout }))
        .mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'Capture declined' }) } as Response)
    );

    await renderPage();
    await waitFor(() => expect(buttonOptions).not.toBeNull());
    await act(async () => {
      await buttonOptions!.onApprove();
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('Capture declined');
    expect(screen.getByTestId('paypal-redirect-fallback')).toBeInTheDocument();
  });

  it('explains an unavailable payment', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ success: false, error: 'This payment is completed' }) } as Response));

    await renderPage();

    expect(await screen.findByText('This payment is completed')).toBeInTheDocument();
    expect(buttonOptions).toBeNull();
  });
});
