'use client';

import { Fragment, useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/auth/client';

interface PayPalDisputesTabProps {
  businessId: string;
}

interface DisputeMessage {
  postedBy: string | null;
  at: string | null;
  content: string;
}

interface PaypalDispute {
  id: string;
  reason: string | null;
  status: string | null;
  stage: string | null;
  amount: string | null;
  currency: string | null;
  createdAt: string | null;
  respondBy: string | null;
  outcome: string | null;
  actionable: boolean;
  canAcceptClaim?: boolean;
  invoiceNumber?: string | null;
  messages?: DisputeMessage[];
}

function formatAmount(amount: string | null, currency: string | null): string {
  if (amount === null) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(Number(amount));
  } catch {
    return `${amount} ${currency ?? ''}`;
  }
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : '—';
}

function humanize(value: string | null): string {
  return value ? value.toLowerCase().replace(/_/g, ' ') : '—';
}

const STATUS_STYLE: Record<string, string> = {
  WAITING_FOR_SELLER_RESPONSE: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  WAITING_FOR_BUYER_RESPONSE: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  UNDER_REVIEW: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  RESOLVED: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};

/**
 * PayPal disputes for one business, read live from PayPal: messages to the
 * buyer, written evidence for PayPal's review, or accepting the claim (which
 * refunds the buyer). The analogue of the Stripe Disputes tab.
 */
export function PayPalDisputesTab({ businessId }: PayPalDisputesTabProps) {
  const router = useRouter();
  const [disputes, setDisputes] = useState<PaypalDispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaypalDispute | null>(null);
  const [message, setMessage] = useState('');
  const [notes, setNotes] = useState('');
  const [tracking, setTracking] = useState('');
  const [confirmAccept, setConfirmAccept] = useState(false);
  const [busy, setBusy] = useState(false);

  const fetchDisputes = useCallback(async () => {
    try {
      const result = await authFetch(`/api/paypal/disputes?business_id=${businessId}`, {}, router);
      if (!result) return;
      const { data } = result;
      if (data.success) {
        setDisputes(data.disputes || []);
        setLoadError('');
      } else {
        setLoadError(data.error || 'Could not load PayPal disputes.');
      }
    } catch {
      setLoadError('Could not load PayPal disputes.');
    }
  }, [businessId, router]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await fetchDisputes();
      setLoading(false);
    };
    load();
  }, [fetchDisputes]);

  const openDispute = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    setDetail(null);
    setMessage('');
    setNotes('');
    setTracking('');
    setConfirmAccept(false);
    try {
      const result = await authFetch(`/api/paypal/disputes/${id}?business_id=${businessId}`, {}, router);
      if (result?.data?.success) setDetail(result.data.dispute);
    } catch {
      /* the panel still works without the message history */
    }
  };

  const act = async (id: string, action: 'message' | 'evidence' | 'accept', body: Record<string, unknown>, done: string) => {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await authFetch(
        `/api/paypal/disputes/${id}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ business_id: businessId, ...body }),
        },
        router
      );
      if (!result) return;
      if (result.data.success) {
        setSuccess(done);
        setOpen(null);
        await fetchDisputes();
      } else {
        setError(result.data.error || 'PayPal rejected the request.');
      }
    } catch {
      setError('PayPal request failed.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto"></div>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">Loading PayPal disputes…</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {(error || loadError) && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded-lg text-sm">
          {error || loadError}
        </div>
      )}
      {success && (
        <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-400 px-4 py-3 rounded-lg text-sm">
          {success}
        </div>
      )}

      <section>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">PayPal Disputes</h3>
        {disputes.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400 py-4">No PayPal disputes.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Amount</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Reason</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Status</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Stage</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Respond by</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Payment</th>
                  <th className="text-left py-2 px-3 font-medium text-gray-700 dark:text-gray-200">Actions</th>
                </tr>
              </thead>
              <tbody>
                {disputes.map((d) => (
                  <Fragment key={d.id}>
                    <tr className="border-b border-gray-100 dark:border-gray-800">
                      <td className="py-2 px-3 font-medium">{formatAmount(d.amount, d.currency)}</td>
                      <td className="py-2 px-3 text-gray-600 dark:text-gray-300 capitalize">{humanize(d.reason)}</td>
                      <td className="py-2 px-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLE[d.status ?? ''] ?? STATUS_STYLE.RESOLVED}`}>
                          {humanize(d.status)}
                        </span>
                        {d.outcome && <span className="block text-xs text-gray-500 mt-1">{humanize(d.outcome)}</span>}
                      </td>
                      <td className="py-2 px-3 text-gray-600 dark:text-gray-300 capitalize">{humanize(d.stage)}</td>
                      <td className="py-2 px-3 text-gray-600 dark:text-gray-300">{formatDate(d.respondBy)}</td>
                      <td className="py-2 px-3 font-mono text-xs text-gray-500 dark:text-gray-400">{d.invoiceNumber || '—'}</td>
                      <td className="py-2 px-3">
                        <button
                          onClick={() => openDispute(d.id)}
                          className={`px-3 py-1 text-xs font-medium rounded ${
                            d.actionable
                              ? 'bg-purple-600 text-white hover:bg-purple-500'
                              : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600'
                          }`}
                        >
                          {open === d.id ? 'Close' : d.actionable ? 'Respond' : 'View'}
                        </button>
                      </td>
                    </tr>
                    {open === d.id && (
                      <tr className="border-b border-gray-100 dark:border-gray-800">
                        <td colSpan={7} className="px-3 py-4 bg-gray-50 dark:bg-gray-900/40">
                          <div className="space-y-4" data-testid="paypal-dispute-panel">
                            {detail?.messages && detail.messages.length > 0 && (
                              <div className="space-y-2">
                                <p className="text-xs font-medium text-gray-500 uppercase">Conversation</p>
                                {detail.messages.map((m, i) => (
                                  <p key={i} className="text-sm text-gray-700 dark:text-gray-200">
                                    <span className="font-medium capitalize">{humanize(m.postedBy)}</span>
                                    <span className="text-xs text-gray-500"> · {formatDate(m.at)}</span>
                                    <br />
                                    {m.content}
                                  </p>
                                ))}
                              </div>
                            )}

                            {d.actionable ? (
                              <>
                                <div className="space-y-2">
                                  <label className="text-xs font-medium text-gray-500 uppercase" htmlFor={`msg-${d.id}`}>
                                    Message the buyer
                                  </label>
                                  <textarea
                                    id={`msg-${d.id}`}
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    rows={2}
                                    className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                                  />
                                  <button
                                    disabled={busy || !message.trim()}
                                    onClick={() => act(d.id, 'message', { message }, 'Message sent to the buyer.')}
                                    className="px-3 py-1 text-xs font-medium bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50"
                                  >
                                    Send message
                                  </button>
                                </div>

                                <div className="space-y-2">
                                  <label className="text-xs font-medium text-gray-500 uppercase" htmlFor={`ev-${d.id}`}>
                                    Evidence for PayPal
                                  </label>
                                  <textarea
                                    id={`ev-${d.id}`}
                                    value={notes}
                                    onChange={(e) => setNotes(e.target.value)}
                                    rows={3}
                                    placeholder="What was delivered, when, and how the buyer received it"
                                    className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                                  />
                                  <input
                                    value={tracking}
                                    onChange={(e) => setTracking(e.target.value)}
                                    placeholder="Tracking number (if shipped)"
                                    className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                                  />
                                  <button
                                    disabled={busy || notes.trim().length < 10}
                                    onClick={() =>
                                      act(
                                        d.id,
                                        'evidence',
                                        { notes, ...(tracking.trim() ? { tracking_number: tracking.trim() } : {}) },
                                        'Evidence submitted to PayPal.'
                                      )
                                    }
                                    className="px-3 py-1 text-xs font-medium bg-purple-600 text-white rounded hover:bg-purple-500 disabled:opacity-50"
                                  >
                                    Submit evidence
                                  </button>
                                </div>

                                <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
                                  {confirmAccept ? (
                                    <div className="flex items-center gap-2">
                                      <span className="text-sm text-red-700 dark:text-red-400">
                                        PayPal will refund {formatAmount(d.amount, d.currency)} to the buyer.
                                      </span>
                                      <button
                                        disabled={busy}
                                        onClick={() => act(d.id, 'accept', {}, 'Claim accepted; PayPal is refunding the buyer.')}
                                        className="px-3 py-1 text-xs font-medium bg-red-600 text-white rounded hover:bg-red-500 disabled:opacity-50"
                                      >
                                        Confirm
                                      </button>
                                      <button
                                        disabled={busy}
                                        onClick={() => setConfirmAccept(false)}
                                        className="px-3 py-1 text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => setConfirmAccept(true)}
                                      className="px-3 py-1 text-xs font-medium border border-red-600 text-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/20"
                                    >
                                      Accept claim (refund buyer)
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : (
                              <p className="text-sm text-gray-500 dark:text-gray-400">
                                No response is needed from you right now.
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
