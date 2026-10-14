/**
 * PayPal Disputes API (v1/customer/disputes) for one merchant.
 *
 * Every call runs in the business's PayPal context: its own REST credentials in
 * self-serve mode, or the platform's with a PayPal-Auth-Assertion for the
 * seller in partner mode. PayPal scopes the results to that merchant, so a
 * dispute id from another business simply 404s — there is no cross-tenant read.
 */
import {
  getPaypalAccessToken,
  paypalApiBase,
  paypalAuthAssertion,
  type PaypalCallContext,
  type PaypalCredentials,
} from './client';

export type DisputeCallParams = PaypalCredentials & PaypalCallContext;

/** PayPal statuses where the seller is expected to act. */
const ACTIONABLE = new Set(['WAITING_FOR_SELLER_RESPONSE']);

export interface PaypalDispute {
  id: string;
  reason: string | null;
  status: string | null;
  /** PayPal's coarser state, e.g. REQUIRED_ACTION / UNDER_PAYPAL_REVIEW / RESOLVED. */
  state: string | null;
  /** INQUIRY, CHARGEBACK, PRE_ARBITRATION, ARBITRATION. */
  stage: string | null;
  amount: string | null;
  currency: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  respondBy: string | null;
  outcome: string | null;
  /** The capture id on the seller side, to match a CoinPay transaction. */
  sellerTransactionId: string | null;
  actionable: boolean;
  canAcceptClaim: boolean;
  messages: { postedBy: string | null; at: string | null; content: string }[];
}

export function normalizeDispute(d: any): PaypalDispute {
  const tx = Array.isArray(d?.disputed_transactions) ? d.disputed_transactions[0] : null;
  const status = d?.status ?? null;
  return {
    id: d?.dispute_id ?? '',
    reason: d?.reason ?? null,
    status,
    state: d?.dispute_state ?? null,
    stage: d?.dispute_life_cycle_stage ?? null,
    amount: d?.dispute_amount?.value ?? null,
    currency: d?.dispute_amount?.currency_code ?? null,
    createdAt: d?.create_time ?? null,
    updatedAt: d?.update_time ?? null,
    respondBy: d?.seller_response_due_date ?? null,
    outcome: d?.dispute_outcome?.outcome_code ?? null,
    sellerTransactionId: tx?.seller_transaction_id ?? null,
    actionable: ACTIONABLE.has(status),
    canAcceptClaim: ACTIONABLE.has(status) && !!d?.allowed_response_options?.accept_claim,
    messages: (Array.isArray(d?.messages) ? d.messages : []).map((m: any) => ({
      postedBy: m?.posted_by ?? null,
      at: m?.time_posted ?? null,
      content: String(m?.content ?? ''),
    })),
  };
}

async function headersFor(params: DisputeCallParams, json: boolean): Promise<Record<string, string>> {
  const token = await getPaypalAccessToken(params);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (json) headers['Content-Type'] = 'application/json';
  if (params.authAssertionMerchantId) {
    headers['PayPal-Auth-Assertion'] = paypalAuthAssertion(params.clientId, params.authAssertionMerchantId);
  }
  if (params.bnCode) headers['PayPal-Partner-Attribution-Id'] = params.bnCode;
  return headers;
}

async function call(
  params: DisputeCallParams,
  path: string,
  init: { method: string; json?: unknown; form?: FormData; label: string }
): Promise<any> {
  const headers = await headersFor(params, init.json !== undefined);
  const res = await fetch(`${paypalApiBase(params.environment)}${path}`, {
    method: init.method,
    headers,
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    ...(init.form ? { body: init.form } : {}),
  });
  const debugId = res.headers?.get?.('paypal-debug-id') ?? null;
  console.log(JSON.stringify({ paypal_api: init.label, method: init.method, path, status: res.status, debug_id: debugId }));
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = [body?.message, ...(body?.details ?? []).map((x: any) => x?.issue)].filter(Boolean).join(' — ');
    } catch {
      /* no body */
    }
    const error = new Error(
      `${init.label} failed (${res.status})${detail ? `: ${detail}` : ''}${debugId ? ` [PayPal-Debug-Id ${debugId}]` : ''}`
    ) as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

/** One multipart part named `input` carrying the JSON body, as PayPal expects. */
function jsonPart(form: FormData, value: unknown): FormData {
  form.append('input', new Blob([JSON.stringify(value)], { type: 'application/json' }));
  return form;
}

export async function listPaypalDisputes(
  params: DisputeCallParams,
  options: { pageSize?: number } = {}
): Promise<PaypalDispute[]> {
  const size = Math.min(Math.max(options.pageSize ?? 50, 1), 50);
  const data = await call(params, `/v1/customer/disputes?page_size=${size}`, { method: 'GET', label: 'PayPal list disputes' });
  return (Array.isArray(data?.items) ? data.items : []).map(normalizeDispute);
}

export async function getPaypalDispute(params: DisputeCallParams, disputeId: string): Promise<PaypalDispute> {
  const data = await call(params, `/v1/customer/disputes/${encodeURIComponent(disputeId)}`, {
    method: 'GET',
    label: 'PayPal get dispute',
  });
  return normalizeDispute(data);
}

/** Accept the buyer's claim: PayPal refunds them from the merchant's balance. */
export async function acceptPaypalClaim(params: DisputeCallParams, disputeId: string, note: string): Promise<void> {
  await call(params, `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`, {
    method: 'POST',
    json: { note: note.slice(0, 2000) },
    label: 'PayPal accept claim',
  });
}

export async function sendPaypalDisputeMessage(
  params: DisputeCallParams,
  disputeId: string,
  message: string
): Promise<void> {
  await call(params, `/v1/customer/disputes/${encodeURIComponent(disputeId)}/send-message`, {
    method: 'POST',
    form: jsonPart(new FormData(), { message: message.slice(0, 2000) }),
    label: 'PayPal dispute message',
  });
}

/** Written evidence (a note, plus a tracking number when the item shipped). */
export async function providePaypalDisputeEvidence(
  params: DisputeCallParams,
  disputeId: string,
  evidence: { notes: string; trackingNumber?: string | null; carrier?: string | null }
): Promise<void> {
  const item: Record<string, unknown> = { evidence_type: 'OTHER', notes: evidence.notes.slice(0, 2000) };
  if (evidence.trackingNumber) {
    item.evidence_type = 'PROOF_OF_FULFILLMENT';
    item.evidence_info = {
      tracking_info: [{ tracking_number: evidence.trackingNumber, carrier_name: evidence.carrier || 'OTHER' }],
    };
  }
  await call(params, `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`, {
    method: 'POST',
    form: jsonPart(new FormData(), { evidences: [item] }),
    label: 'PayPal provide evidence',
  });
}
