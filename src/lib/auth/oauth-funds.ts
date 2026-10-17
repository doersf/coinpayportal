import { NextResponse } from 'next/server';

/**
 * Apps signed in with CoinPay cannot move funds.
 *
 * An OAuth access token carrying the `merchant` scope acts as the merchant on
 * the merchant API (onboarding: businesses, payments, invoices, payout
 * addresses, webhooks). It must not send money anywhere: crypto payouts, bank
 * transfers, pay runs, refunds, or naming a custom payout address for a
 * payment or invoice. Those need the CoinPay dashboard (a session) or a
 * business API key, exactly as before.
 *
 * The rule lives in two places so new routes inherit it:
 *   - `authorizeBusiness` (./authz) refuses the `funds.move` capability to an
 *     actor whose `via` is 'oauth';
 *   - `hasScope` (./middleware) refuses the funds-moving API-key scopes
 *     (`payouts:create`, `payments:refund`) to an OAuth merchant context.
 * Routes that move funds without a business capability check call
 * `refuseOAuthFundsMove` directly.
 */

/** How a caller authenticated. Absent means a dashboard session (legacy shape). */
export type AuthVia = 'session' | 'oauth' | 'api_key';

export const OAUTH_CANNOT_MOVE_FUNDS = 'oauth_cannot_move_funds';

export const OAUTH_CANNOT_MOVE_FUNDS_MESSAGE =
  'Moving funds needs the CoinPay dashboard; apps signed in with CoinPay cannot do this';

/** API-key scopes that move money out. An OAuth merchant context never holds them. */
export const FUNDS_MOVING_SCOPES: ReadonlySet<string> = new Set(['payouts:create', 'payments:refund']);

/**
 * Any auth result that may say how the caller authenticated: an `AuthContext`,
 * `AuthenticatedMerchant`, `ResolvedMerchant`, or `{ via }`. Typed loosely so
 * a context without `via` (a business API key) is accepted and passes.
 */
export type MaybeViaContext = object | null | undefined;

/** True when the caller authenticated with an OAuth access token. */
export function isOAuthCaller(ctx: MaybeViaContext): boolean {
  return !!ctx && (ctx as { via?: unknown }).via === 'oauth';
}

/**
 * A business record without its API key, for an OAuth caller.
 *
 * A business API key (the legacy one holds every scope) can send payouts, so
 * handing it to an app signed in with CoinPay would undo the rule above. Every
 * route an OAuth token reaches that returns a business row passes it through
 * here. Other callers get the record unchanged.
 */
export function withoutApiKeyForOAuth<T>(business: T, ctx: MaybeViaContext): T {
  if (!isOAuthCaller(ctx) || !business || typeof business !== 'object') return business;
  const { api_key: _omit, ...rest } = business as T & { api_key?: unknown };
  return rest as T;
}

/** The JSON body and status for the refusal, for routes with their own response shape. */
export function oauthFundsMoveRefusalBody(): { success: false; error: string; code: typeof OAUTH_CANNOT_MOVE_FUNDS } {
  return { success: false, error: OAUTH_CANNOT_MOVE_FUNDS_MESSAGE, code: OAUTH_CANNOT_MOVE_FUNDS };
}

/**
 * A 403 `oauth_cannot_move_funds` response when `ctx` came from an OAuth access
 * token, otherwise null. Sessions and API keys pass untouched.
 */
export function refuseOAuthFundsMove(ctx: MaybeViaContext): NextResponse | null {
  if (!isOAuthCaller(ctx)) return null;
  return NextResponse.json(oauthFundsMoveRefusalBody(), { status: 403 });
}
