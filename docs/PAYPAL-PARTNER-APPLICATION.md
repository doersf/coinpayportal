# PayPal partner application (PPCP)

CoinPay's per-business PayPal works today with each merchant's own REST
credentials. **Platform-level PayPal** — the "Connect with PayPal" button, and
CoinPay's commission on PayPal sales — needs CoinPay to be an approved
**PayPal Complete Payments (PPCP) partner**. Without it, PayPal refuses
`POST /v2/customer/partner-referrals` with `NOT_AUTHORIZED` (verified
2026-10-14 against the live REST app).

This is the working checklist for getting approved. See
[PAYPAL-PAYMENTS.md](./PAYPAL-PAYMENTS.md) for how the rail itself works.

## Where things stand

| Requirement PayPal reviews | Status |
|---|---|
| Orders v2 create / capture / get / refund | Done (`src/lib/paypal/client.ts`) |
| Partner Referrals onboarding + status read-back | Done (`/api/paypal/connect/onboard`), blocked on approval |
| `PayPal-Auth-Assertion` + `PayPal-Partner-Attribution-Id` (BN code) on third-party calls | Done |
| `platform_fees` on multiparty orders | Done |
| Webhooks: capture completed/denied/declined/reversed/refunded, onboarding completed, consent revoked | Done (`/api/paypal/webhook`) |
| `PayPal-Request-Id` idempotency on create | Done |
| **PayPal-Debug-Id captured on every call** | Done — one JSON log line per call (`paypal_api`, `status`, `debug_id`, `ms`), and in every error |
| **Line items + `item_total` breakdown on orders** | Done — one item from the description when the caller sends none |
| **`payment_source.paypal.experience_context`** (replaces deprecated `application_context`) | Done |
| JS SDK Smart Payment Buttons on the checkout page | **Not done** — checkout is a server-side redirect to PayPal |
| Disputes surface (list / respond) | **Not done** — onboarding requests the scopes, no routes or UI yet |
| Merchant can disconnect (consent revoked handling) | Done (webhook marks the account disconnected) |

## Status (2026-10-14)

- **Application submitted** through the "Tell us about your platform" form at
  developer.paypal.com/platforms/overview (Profullstack, Inc., company type
  Platform, volume under $10M). PayPal: "We are reviewing your request. A
  PayPal representative will contact you as soon as possible."
- **Sandbox Platform REST app created** ("Platform Partner App", sandbox
  business account auto-generated). Unlike a Merchant app, it can call
  Partner Referrals in sandbox today, so partner mode can be exercised end to
  end before approval. Credentials and the sandbox partner merchant id are in
  the logicsrc vault `coinpayportal-paypal-platform--sandbox`; the Default
  (merchant) sandbox app is in `coinpayportal-paypal-sandbox--prod`.

## Steps

### Needs Anthony (account access) — 1 and 2 done 2026-10-14

1. **Apply.** Sign in to the PayPal business account that owns the `coinpay`
   REST app at developer.paypal.com, and request partner access for the app
   (PPCP / "Partner Referrals" feature), or apply through
   paypal.com/partners. Business details for the form are in the company
   records, not in this public repo.
2. **Sandbox.** In the same developer dashboard, create a **sandbox** REST app
   plus a sandbox business (merchant) and personal (buyer) account. Sandbox
   partner referrals are what the integration evidence is recorded against.
   Put the sandbox client id/secret in the logicsrc vault as
   `coinpayportal-paypal-sandbox--prod` and tell the agent.
3. **Record the videos** PayPal asks for (the agent can script each flow):
   merchant onboarding, buyer checkout, capture, refund, and disconnect.

### Agent can do once sandbox credentials exist

4. Run the evidence script against sandbox: onboard a sandbox merchant, two
   sales, one refund — collecting each call's `PayPal-Debug-Id` from the log
   lines above into the API call log PayPal wants.
5. Build the two missing pieces: JS SDK Smart Payment Buttons on
   `/pay/...` (keeping the redirect as fallback), and a disputes list +
   respond panel on the PayPal tab.

### After approval

6. Set on the running CoinPay service, and record in the vault:
   `PAYPAL_PLATFORM_CLIENT_ID`, `PAYPAL_PLATFORM_CLIENT_SECRET`,
   `PAYPAL_PARTNER_MERCHANT_ID`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_BN_CODE`.
   The "Connect with PayPal" button appears and platform fees start.
