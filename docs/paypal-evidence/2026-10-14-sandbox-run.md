# PayPal PPCP sandbox evidence run — 2026-10-14

Driven through CoinPay's own `src/lib/paypal` client against the sandbox Platform app
(partner merchant id `AJ4RLVLCR6UEW`). Every PayPal call is listed with its `PayPal-Debug-Id`;
OAuth token calls (10) are omitted.

## Flow

1. Partner Referral created (tracking id `coinpay-sandbox-seller-1791968205443`); the sandbox seller signed in at the action URL, granted permissions, and finished onboarding.
2. Seller merchant id `BW5CVLPCHQDUU`: payments_receivable true, primary email confirmed, PPCP_CUSTOM and PPCP_STANDARD SUBSCRIBED.
3. Sale 1: $10.00 order with the seller as payee and a $0.10 platform fee; buyer approved in the PayPal checkout; captured by the partner (no auth assertion). PayPal fee $0.84, seller net $9.06.
4. Sale 2: $25.00 order created and captured **with** `PayPal-Auth-Assertion` for the seller (CoinPay's production partner path); platform fee $0.25, PayPal fee $1.36, seller net $23.39.
5. Refund: sale 1 capture refunded in full, acting as the seller via auth assertion.

## Results

| | Order | Capture / refund | Status |
|---|---|---|---|
| Sale 1 ($10.00) | `30B2479501040662J` | `86X59060RJ179082C` | COMPLETED |
| Sale 2 ($25.00) | `0XX47477VJ467653G` | `3FY879450M005230D` | COMPLETED |
| Refund of sale 1 | | `9WS48232RH850135U` | COMPLETED |

## API call log

| Time (UTC) | Method | Path | Status | PayPal-Debug-Id |
|---|---|---|---|---|
| 08:56:46 | POST | `/v2/customer/partner-referrals` | 201 | `f425094fcedef` |
| 08:59:41 | GET | `/v1/customer/partners/AJ4RLVLCR6UEW/merchant-integrations/coinpay-sandbox-seller-1791968205443` | 404 | `f602380026828` |
| 09:00:21 | GET | `/v1/customer/partners/AJ4RLVLCR6UEW/merchant-integrations/coinpay-sandbox-seller-1791968205443` | 404 | `f147577440ad8` |
| 09:00:55 | POST | `/v2/checkout/orders` | 200 | `f184112d6a652` |
| 09:04:27 | POST | `/v2/checkout/orders/30B2479501040662J/capture` | 404 | `f913447bee69a` |
| 09:04:34 | POST | `/v2/checkout/orders/30B2479501040662J/capture` | 404 | `ca4a56ad7a848` |
| 09:04:48 | POST | `/v2/checkout/orders/30B2479501040662J/capture` | 201 | `ca4a56b252c4f` |
| 09:05:01 | POST | `/v2/checkout/orders` | 200 | `f3244349eb099` |
| 09:07:12 | POST | `/v2/checkout/orders/0XX47477VJ467653G/capture` | 201 | `f34187957ed9b` |
| 09:07:30 | POST | `/v2/payments/captures/86X59060RJ179082C/refund` | 201 | `f7856205568ef` |

Notes:
- The two `merchant-integrations/{tracking_id}` 404s exposed a bug: PayPal only resolves a tracking id through `?tracking_id=`; fixed in the same PR as this log.
- The first capture 404 (`INVALID_RESOURCE_ID`) was the evidence script capturing a partner-created order with a seller auth assertion; production creates and captures with the same context (sale 2).
