import { DocSection } from './DocSection';
import { ApiEndpoint } from './ApiEndpoint';
import { CodeBlock } from './CodeBlock';

/** Hosted checkout sessions: one URL, any coin the business can receive, or PayPal. */
export function CheckoutSessionsDocs() {
  return (
    <DocSection title="Hosted Checkout Sessions">
      <p className="text-gray-300 mb-4">
        One hosted page for every payment. Create a session from your server, redirect the buyer to its{' '}
        <code className="text-purple-400">url</code>, and CoinPay shows a picker of every coin your business has a
        wallet for (stablecoins first, then BTC, ETH, SOL and the rest; business wallets first, account-global wallets
        as the fallback) plus PayPal when PayPal is connected for the business. Choosing one creates the payment and
        sends the buyer to the pay page or to PayPal. While unpaid they can come back and switch.
      </p>
      <p className="text-gray-300 mb-6">
        Every session says who is paying and for which property: <code className="text-purple-400">customer_email</code>{' '}
        and <code className="text-purple-400">account_id</code> are required, and they travel onto the payment and every
        webhook for it.
      </p>

      <ApiEndpoint method="POST" path="/api/checkout/sessions" description="Create a hosted checkout session. Authorization: Bearer <business API key>, the same key as /api/payments/create.">
        <CodeBlock title="Request Body">
{`{
  "amount": 9.99,                                  // USD, required
  "currency": "USD",                               // only USD
  "description": "Pro plan, 1 month",
  "customer_email": "buyer@example.com",           // required
  "account_id": "user_123",                        // required: your user id or handle
  "property": "example.com",                       // your site hostname (default: business name)
  "metadata": { "plan": "pro" },                   // optional, up to 16 KB
  "success_url": "https://example.com/thanks?session={CHECKOUT_SESSION_ID}&payment={PAYMENT_ID}",
  "cancel_url": "https://example.com/pricing",
  "expires_in_minutes": 60,                        // 15 to 120, default 60
  "allowed_methods": ["CRYPTO", "PAYPAL"]          // optional: coin codes, CRYPTO or PAYPAL (default all)
}`}
        </CodeBlock>
        <CodeBlock title="cURL" language="curl">
{`curl -X POST https://coinpayportal.com/api/checkout/sessions \\
  -H "Authorization: Bearer $COINPAY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":9.99,"description":"Pro plan","customer_email":"buyer@example.com","account_id":"user_123","property":"example.com","success_url":"https://example.com/thanks?session={CHECKOUT_SESSION_ID}","cancel_url":"https://example.com/pricing"}'`}
        </CodeBlock>
        <CodeBlock title="Response (201)">
{`{
  "success": true,
  "id": "cs_9fQ2xY7LmA3kT0pWbR5sZc1d",
  "url": "https://coinpayportal.com/checkout/cs_9fQ2xY7LmA3kT0pWbR5sZc1d",
  "status": "open",
  "amount": 9.99,
  "currency": "USD",
  "description": "Pro plan",
  "customer_email": "buyer@example.com",
  "account_id": "user_123",
  "property": "example.com",
  "metadata": {},
  "success_url": "https://example.com/thanks?session={CHECKOUT_SESSION_ID}",
  "cancel_url": "https://example.com/pricing",
  "expires_at": "2026-10-21T13:00:00.000Z",
  "methods": ["USDC_POL", "USDC_SOL", "USDT_POL", "BTC", "ETH", "SOL", "PAYPAL"]
}`}
        </CodeBlock>
        <div className="mb-4 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-200">
          Errors are <code>400 {'{ success: false, error, code }'}</code>. Codes include{' '}
          <code>MISSING_CUSTOMER_EMAIL</code>, <code>MISSING_ACCOUNT_ID</code>, <code>INVALID_CUSTOMER_EMAIL</code>,{' '}
          <code>INVALID_AMOUNT</code>, <code>INVALID_CURRENCY</code>, <code>INVALID_SUCCESS_URL</code>,{' '}
          <code>INVALID_CANCEL_URL</code>, <code>INVALID_ALLOWED_METHODS</code> and <code>NO_PAYMENT_METHODS</code>{' '}
          (the business has no wallet and no PayPal).
        </div>
      </ApiEndpoint>

      <ApiEndpoint method="GET" path="/api/checkout/sessions/:id" description="Session status. Public view for the hosted page; with your business API key it also returns customer_email, account_id, metadata, payment_id and paypal_transaction_id.">
        <CodeBlock title="Response">
{`{
  "success": true,
  "session": {
    "id": "cs_9fQ2xY7LmA3kT0pWbR5sZc1d",
    "object": "checkout.session",
    "status": "paid",                 // open | paid | expired
    "amount": 9.99,
    "currency": "USD",
    "property": "example.com",
    "paid_method": "USDC_POL",
    "success_url": "https://example.com/thanks?session=cs_9fQ2xY7LmA3kT0pWbR5sZc1d",
    "customer_email": "buyer@example.com",   // owner view only
    "account_id": "user_123",                // owner view only
    "payment_id": "6f1c...",                 // owner view only
    "...": "..."
  }
}`}
        </CodeBlock>
      </ApiEndpoint>

      <h3 className="text-xl font-semibold text-white mb-2 mt-6">Webhooks</h3>
      <p className="text-gray-300 mb-4">
        The usual payment events (<code>payment.confirmed</code>, <code>payment.forwarded</code>, and for PayPal{' '}
        <code>payment.confirmed</code> with <code>rail: &quot;paypal&quot;</code>) are sent to your business webhook
        in the same nested shape, with these fields added to <code>data</code>. Nothing existing is removed.
      </p>
      <CodeBlock title="Webhook body">
{`{
  "id": "evt_<paymentId>_<unix>",          // the EVENT id, not the payment
  "type": "payment.confirmed",
  "business_id": "...",
  "created_at": "2026-10-21T12:10:00.000Z",
  "data": {
    "payment_id": "6f1c...",
    "status": "confirmed",
    "amount": "9.99",
    "amount_usd": "9.99",
    "currency": "USDC_POL",
    "checkout_session_id": "cs_9fQ2xY7LmA3kT0pWbR5sZc1d",
    "customer_email": "buyer@example.com",
    "account_id": "user_123",
    "property": "example.com",
    "metadata": { "plan": "pro", "checkout_session_id": "cs_...", "customer_email": "...", "account_id": "...", "property": "..." }
  }
}`}
      </CodeBlock>
      <p className="text-gray-300 mb-4 text-sm">
        Credit the order from the signed webhook, not from the redirect. <code>/api/payments/create</code> also accepts
        optional <code>customer_email</code>, <code>account_id</code> and <code>property</code>, stored and sent the
        same way.
      </p>

      <CodeBlock title="SDK" language="javascript">
{`import { CoinPayClient } from '@profullstack/coinpay';

const coinpay = new CoinPayClient({ apiKey: process.env.COINPAY_API_KEY });
const { id, url } = await coinpay.createCheckoutSession({
  amount: 9.99,
  description: 'Pro plan',
  customerEmail: user.email,
  accountId: user.id,
  property: 'example.com',
  successUrl: 'https://example.com/thanks?session={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://example.com/pricing',
});
// redirect the buyer to url`}
      </CodeBlock>
    </DocSection>
  );
}
