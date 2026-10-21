'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { safeReturnUrl } from '@/lib/payments/return-url';
import type { CheckoutMethod } from '@/lib/checkout/methods';

/**
 * Hosted checkout: the buyer picks any coin the merchant can receive, or
 * PayPal. Picking one creates the payment and hands off to /pay/<id> (crypto)
 * or PayPal. The buyer can come back here and switch while unpaid.
 */

interface SessionView {
  id: string;
  status: 'open' | 'paid' | 'expired';
  amount: number;
  currency: string;
  description: string | null;
  property: string;
  merchant_name: string | null;
  expires_at: string;
  methods: CheckoutMethod[];
  current: { method: string; payment_id: string | null; pay_url?: string } | null;
  success_url: string | null;
  cancel_url: string | null;
  paid_method: string | null;
}

const GROUPS: { key: CheckoutMethod['group']; title: string }[] = [
  { key: 'stablecoin', title: 'Stablecoins' },
  { key: 'crypto', title: 'Crypto' },
  { key: 'paypal', title: 'PayPal' },
];

function formatUsd(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function useCountdown(expiresAt: string | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!expiresAt) return null;
  const s = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function HostedCheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [session, setSession] = useState<SessionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const redirected = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/checkout/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setLoadError(data.error || 'This checkout link is not available.');
        return;
      }
      setSession(data.session);
    } catch {
      setLoadError('We could not load this checkout. Check your connection and try again.');
    }
  }, [id]);

  useEffect(() => {
    // Initial fetch plus a slow poll so a buyer returning from a payment sees
    // it settle without reloading.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const successUrl = session?.status === 'paid' ? safeReturnUrl(session.success_url) : null;
  useEffect(() => {
    if (!successUrl || redirected.current) return;
    redirected.current = true;
    const t = setTimeout(() => {
      // Re-checked on the client: only an absolute http(s) URL is followed.
      const target = safeReturnUrl(successUrl);
      if (target) window.location.assign(target);
    }, 3000);
    return () => clearTimeout(t);
  }, [successUrl]);

  const countdown = useCountdown(session?.expires_at);

  const pick = async (code: string) => {
    setBusy(code);
    setPickError(null);
    try {
      const res = await fetch(`/api/checkout/sessions/${encodeURIComponent(id)}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: code }),
      });
      const data = await res.json().catch(() => ({}));
      const target = safeReturnUrl(data.redirect_url);
      if (res.ok && data.success && target) {
        window.location.assign(target);
        return;
      }
      setPickError(data.error || 'We could not start that payment. Try another method.');
      if (res.status === 409 || res.status === 410) load();
    } catch {
      setPickError('We could not reach CoinPay. Check your connection and try again.');
    }
    setBusy(null);
  };

  const merchant = session?.merchant_name || session?.property || 'the merchant';
  const cancelUrl = safeReturnUrl(session?.cancel_url);

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-gray-900 py-8 px-4">
      <div className="max-w-lg mx-auto">
        <div className="text-center mb-6">
          <Link href="/" className="inline-flex items-center gap-2 text-purple-400 hover:text-purple-300 transition-colors mb-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            <span className="font-semibold">CoinPay</span>
          </Link>
          {session && <p className="text-gray-400 text-sm">Payment to {merchant}</p>}
        </div>

        <div className="bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-xl overflow-hidden border border-gray-700">
          {!session && !loadError && (
            <div className="p-10 flex justify-center" data-testid="checkout-loading">
              <div className="animate-spin rounded-full h-10 w-10 border-2 border-purple-400 border-t-transparent" />
            </div>
          )}

          {loadError && (
            <div className="p-8 text-center" data-testid="checkout-error">
              <h1 className="text-lg font-semibold text-white">Checkout unavailable</h1>
              <p className="mt-2 text-sm text-gray-300">{loadError}</p>
            </div>
          )}

          {session && (
            <>
              <div className="px-6 py-5 border-b border-gray-700 text-center">
                <p className="text-4xl font-bold text-white" data-testid="checkout-amount">
                  {formatUsd(session.amount)}
                </p>
                {session.description && <p className="mt-2 text-gray-200">{session.description}</p>}
                <p className="mt-1 text-xs text-gray-400" data-testid="checkout-property">
                  for {session.property}
                </p>
              </div>

              {session.status === 'paid' && (
                <div className="p-8 text-center" data-testid="checkout-paid">
                  <div className="h-12 w-12 rounded-full bg-green-500 flex items-center justify-center mx-auto">
                    <svg className="h-7 w-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h1 className="mt-4 text-lg font-semibold text-white">Payment received</h1>
                  <p className="mt-2 text-sm text-gray-300">
                    {successUrl ? `Taking you back to ${merchant}...` : 'You can close this window.'}
                  </p>
                  {successUrl && (
                    <a
                      href={successUrl}
                      className="mt-6 inline-block w-full py-3 px-6 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-xl"
                    >
                      Return to {merchant}
                    </a>
                  )}
                </div>
              )}

              {session.status === 'expired' && (
                <div className="p-8 text-center" data-testid="checkout-expired">
                  <h1 className="text-lg font-semibold text-white">This checkout has expired</h1>
                  <p className="mt-2 text-sm text-gray-300">
                    Nothing was charged. Start a new checkout on {merchant} to pay.
                  </p>
                  {cancelUrl && (
                    <a
                      href={cancelUrl}
                      className="mt-6 inline-block w-full py-3 px-6 bg-purple-600 hover:bg-purple-500 text-white font-medium rounded-xl"
                    >
                      Back to {merchant}
                    </a>
                  )}
                </div>
              )}

              {session.status === 'open' && (
                <div className="p-6 space-y-6">
                  <div className="flex items-center justify-between text-sm">
                    <h1 className="font-semibold text-white">Choose how to pay</h1>
                    {countdown && <span className="text-gray-400 font-mono" title="Time left on this checkout">{countdown}</span>}
                  </div>

                  {session.current?.pay_url && (
                    <div className="rounded-xl border border-purple-500/40 bg-purple-500/10 p-4 text-sm text-gray-200" data-testid="checkout-current">
                      You started paying with <strong>{session.current.method}</strong>.{' '}
                      <a href={session.current.pay_url} className="text-purple-300 underline">
                        Continue that payment
                      </a>{' '}
                      or pick another method below.
                    </div>
                  )}

                  {pickError && (
                    <p className="rounded-lg bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-300" role="alert">
                      {pickError}
                    </p>
                  )}

                  {GROUPS.map((group) => {
                    const items = session.methods.filter((m) => m.group === group.key);
                    if (items.length === 0) return null;
                    return (
                      <section key={group.key} data-testid={`checkout-group-${group.key}`}>
                        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">{group.title}</h2>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {items.map((m) => (
                            <button
                              key={m.code}
                              type="button"
                              onClick={() => pick(m.code)}
                              disabled={busy !== null}
                              data-testid={`checkout-method-${m.code}`}
                              className={`flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60 ${
                                m.group === 'paypal'
                                  ? 'border-[#0070ba]/60 bg-[#0070ba]/20 hover:bg-[#0070ba]/30'
                                  : 'border-gray-600 bg-gray-900/50 hover:border-purple-400 hover:bg-gray-900'
                              } ${session.current?.method === m.code ? 'ring-2 ring-purple-400' : ''}`}
                            >
                              <span>
                                <span className="block font-medium text-white">{m.group === 'paypal' ? 'PayPal' : m.ticker}</span>
                                <span className="block text-xs text-gray-400">
                                  {m.group === 'paypal' ? 'Pay with your PayPal account' : m.chain ? `on ${m.chain}` : m.label}
                                </span>
                              </span>
                              {busy === m.code && (
                                <span className="animate-spin rounded-full h-4 w-4 border-2 border-purple-300 border-t-transparent" />
                              )}
                            </button>
                          ))}
                        </div>
                      </section>
                    );
                  })}

                  {session.methods.length === 0 && (
                    <p className="text-sm text-gray-300">No payment method is available right now. Contact {merchant}.</p>
                  )}

                  {cancelUrl && (
                    <a href={cancelUrl} className="block text-center text-sm text-gray-400 hover:text-gray-200">
                      Cancel and return to {merchant}
                    </a>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-gray-500">Secured by CoinPay</p>
      </div>
    </div>
  );
}
