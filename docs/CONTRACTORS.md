# Contractors and pay runs

Hire contractors anywhere, contract with them, collect their tax forms, approve the
work they submit, and pay the whole team in crypto in one pay run. This is Deel's
contractor product on CoinPay rails. Employer of record, PEO, benefits and visas
need legal entities in each country and are deliberately not included.

## Flow

1. **Invite.** `POST /api/contractors` creates the contractor and emails a private
   portal link (`/contractor/<token>`). The link is the whole credential, like the
   client portal; no CoinPay account is needed.
2. **Contract.** `POST /api/contractors/<id>/contracts` drafts a contract:
   - `fixed`: `rate` per `frequency` (weekly, biweekly, semimonthly = 15th and month end, monthly)
   - `hourly`: `rate` per hour, paid on submitted hours
   - `milestone`: a list of milestones with amounts

   `PATCH /api/contractor-contracts/<id> {action:"send", signature}` signs it as the
   business and emails it; the contractor countersigns in the portal and it becomes `active`.
3. **Portal.** The contractor sets a payout wallet and coin, files a W-9, W-8BEN or
   W-8BEN-E (the tax id is AES-GCM encrypted; only the last four are ever shown), signs
   contracts, logs hours, marks milestones complete and claims expenses.
4. **Approve.** `PATCH /api/contractor-work-items/<id> {action:"approve"|"reject", note}`.
   The business can add bonuses and expense reimbursements itself (approved on creation).
5. **Pay run.** `POST /api/pay-runs {pay_date}` turns every fixed-fee date up to `pay_date`
   into a line and claims all approved, unpaid lines into one item per contractor
   (`contractor_build_pay_run`, under an advisory lock). The payment monitor drafts a run
   automatically when a fixed contract reaches its pay date and emails the owner.
6. **Pay.** `POST /api/pay-runs/<id>/pay`, signed-in owner only (`funds.move`, never an API key):
   - `{method:"wallet"}` sends from the business payout wallet through the payout service
     (live USD rate, balance check, on-chain send). Needs a `business_wallets` row with an
     encrypted key for the contractor's coin.
   - `{method:"manual", payments:[{item_id, tx_hash}]}` records payments made from your own wallet.
   - `{method:"mark_failed", item_id}` resolves an `indeterminate` send that did not land.

   Each paid item gets an auto-generated invoice in the contractor's portal and an email.
7. **Year end.** `GET /api/contractors/1099?year=2026` lists totals per contractor and who
   needs a 1099-NEC (W-9 on file, $600 or more, not a corporation). `&format=csv` adds full
   tax ids and is owner only.

## Safety rules

- Every pay item is claimed by a conditional status update before anything is sent, and
  `contractor_settle_item` only settles an item once, so double clicks cannot pay twice.
- An ambiguous broadcast (timeout after the node may have accepted it) is `indeterminate`
  and is never retried automatically.
- A payout wallet changed in the last 72 hours is flagged on the pay run, and both sides
  are emailed when it changes.
- Nothing pays automatically. The scheduler only drafts.

## Surfaces

- Dashboard: `/contractors` (people, approvals, pay runs, tax forms and 1099),
  `/contractors/<id>`, `/contractors/pay-runs/<id>`.
- CLI: `coinpay contractor ...`, `coinpay payrun ...` (SDK 0.19.0).
- MCP: `contractor_list`, `contractor_get`, `contractor_work_list`, `contractor_work_review`,
  `pay_run_list`, `pay_run_get`, `pay_run_draft`, `contractor_1099_summary`. None sends money.
- Schema: `supabase/migrations/20261017180000_contractors_payroll.sql`.
