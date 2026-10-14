'use client';

import { use, useEffect, useRef, useState } from 'react';
import { paypalSdkAttributes, paypalSdkUrl } from '@/lib/paypal/sdk-url';

/**
 * Hosted PayPal checkout for one CoinPay PayPal payment, using PayPal's JS SDK
 * Smart Payment Buttons. The order already exists (created by
 * POST /api/paypal/payments/create); the buttons approve it in PayPal's popup
 * and we capture through the same public capture route the redirect flow uses.
 * If the SDK can't load (blocked script, old browser) the redirect link below
 * the buttons is the fallback, so a payer is never stuck.
 */

interface Checkout {
  transactionId: string;
  orderId: string;
  amount: number;
  currency: string;
  description: string | null;
  businessName: string | null;
  clientId: string;
  merchantId: string | null;
  partnerAttributionId: string | null;
  approveUrl: string;
  successUrl: string | null;
  cancelUrl: string | null;
}

type PaypalButtonsApi = {
  Buttons: (options: Record<string, unknown>) => {
    isEligible?: () => boolean;
    render: (container: HTMLElement) => Promise<void>;
  };
};

declare global {
  interface Window {
    paypal?: PaypalButtonsApi;
  }
}

type State =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'capturing' }
  | { kind: 'paid' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable'; message: string };

function loadSdk(src: string, attributes: Record<string, string>): Promise<PaypalButtonsApi> {
  if (typeof window !== 'undefined' && window.paypal) return Promise.resolve(window.paypal);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
    script.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK missing')));
    script.onerror = () => reject(new Error('PayPal SDK failed to load'));
    document.head.appendChild(script);
  });
}

export default function HostedPaypalCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const container = useRef<HTMLDivElement>(null);
  const rendered = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/paypal/checkout/${encodeURIComponent(id)}`)
      .then(async (res) => ({ ok: res.ok, data: await res.json() }))
      .then(({ ok, data }) => {
        if (cancelled) return;
        if (!ok || !data.success) {
          setState({ kind: 'unavailable', message: data.error || 'This payment link is not available.' });
          return;
        }
        setCheckout(data.checkout);
      })
      .catch(() => !cancelled && setState({ kind: 'unavailable', message: 'We could not load this payment.' }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    if (!checkout || rendered.current || !container.current) return;
    rendered.current = true;
    const sdk = {
      clientId: checkout.clientId,
      currency: checkout.currency,
      merchantId: checkout.merchantId,
      partnerAttributionId: checkout.partnerAttributionId,
    };
    loadSdk(paypalSdkUrl(sdk), paypalSdkAttributes(sdk))
      .then((paypal) =>
        paypal
          .Buttons({
            style: { layout: 'vertical', shape: 'rect', label: 'pay' },
            // The order was created server-side; hand PayPal its id.
            createOrder: () => checkout.orderId,
            onApprove: async () => {
              setState({ kind: 'capturing' });
              const res = await fetch('/api/paypal/payments/capture', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transaction_id: checkout.transactionId, order_id: checkout.orderId }),
              });
              const data = await res.json().catch(() => ({}));
              if (res.ok && data.success) {
                setState({ kind: 'paid' });
                if (checkout.successUrl) window.location.assign(checkout.successUrl);
              } else {
                setState({ kind: 'error', message: data.error || 'PayPal approved the payment but we could not confirm it.' });
              }
            },
            onCancel: () => {
              setState({ kind: 'cancelled' });
              if (checkout.cancelUrl) window.location.assign(checkout.cancelUrl);
            },
            onError: () => setState({ kind: 'error', message: 'PayPal reported an error. You can try again or pay on PayPal.com below.' }),
          })
          .render(container.current as HTMLElement)
      )
      .then(() => setState({ kind: 'ready' }))
      .catch(() => setState({ kind: 'error', message: 'PayPal buttons could not load. Use the link below to pay on PayPal.com.' }));
  }, [checkout]);

  const amount = checkout
    ? new Intl.NumberFormat('en-US', { style: 'currency', currency: checkout.currency }).format(checkout.amount)
    : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-md p-8">
        {state.kind === 'unavailable' ? (
          <div className="text-center">
            <div className="text-5xl">⚠️</div>
            <h1 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white">Payment unavailable</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{state.message}</p>
          </div>
        ) : state.kind === 'paid' ? (
          <div className="text-center" data-testid="paypal-paid">
            <div className="text-5xl">✅</div>
            <h1 className="mt-4 text-lg font-semibold text-gray-900 dark:text-white">Payment complete</h1>
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
              {amount ? `Your payment of ${amount} went through. ` : 'Your payment went through. '}
              PayPal has emailed you a receipt.
            </p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {checkout?.businessName ? `Pay ${checkout.businessName}` : 'Pay with PayPal'}
              </p>
              {amount && <p className="mt-1 text-3xl font-bold text-gray-900 dark:text-white">{amount}</p>}
              {checkout?.description && (
                <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">{checkout.description}</p>
              )}
            </div>

            {state.kind === 'loading' && (
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[#0070ba] mx-auto" />
            )}
            {state.kind === 'capturing' && (
              <p className="text-center text-sm text-gray-600 dark:text-gray-300">Confirming your payment…</p>
            )}
            {state.kind === 'cancelled' && (
              <p className="text-center text-sm text-gray-600 dark:text-gray-300 mb-4">
                You cancelled before paying, so nothing was charged. You can try again below.
              </p>
            )}
            {state.kind === 'error' && (
              <p className="text-center text-sm text-red-600 dark:text-red-400 mb-4" role="alert">
                {state.message}
              </p>
            )}

            <div ref={container} data-testid="paypal-buttons" />

            {checkout && (
              <p className="mt-6 text-center text-xs text-gray-500 dark:text-gray-400">
                Trouble with the buttons?{' '}
                <a href={checkout.approveUrl} className="text-[#0070ba] underline" data-testid="paypal-redirect-fallback">
                  Pay on PayPal.com
                </a>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
