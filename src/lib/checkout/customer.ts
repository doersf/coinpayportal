/**
 * Who paid, and for which property.
 *
 * Every Profullstack site sends the same three fields so a merchant can contact
 * the payer and credit the right account: `customer_email`, `account_id` (the
 * site's own user id or handle) and `property` (the site hostname). They are
 * stored in the payment's metadata and copied to the top of every payment
 * webhook's `data`, next to `checkout_session_id` when the payment came from a
 * hosted checkout session.
 */

export const CUSTOMER_FIELDS = ['customer_email', 'account_id', 'property'] as const;
export type CustomerField = (typeof CUSTOMER_FIELDS)[number];

export interface CustomerMetadata {
  customer_email?: string;
  account_id?: string;
  property?: string;
}

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 320 && EMAIL_RE.test(value.trim());
}

/**
 * Normalize a property to a hostname when it looks like a URL or host
 * ("https://smshub.dev/x" -> "smshub.dev"); any other label is kept as typed.
 */
export function normalizeProperty(value: string): string {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return trimmed;
    }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(trimmed)) return trimmed.toLowerCase();
  return trimmed;
}

const LIMITS: Record<CustomerField, number> = {
  customer_email: 320,
  account_id: 200,
  property: 255,
};

export type CustomerMetadataResult =
  | { ok: true; metadata: CustomerMetadata }
  | { ok: false; error: string; code: string };

/**
 * Read the optional customer fields off a request body.
 *
 * Non-strict (the existing create-payment routes): a missing or malformed value
 * is dropped, so a live integration that never sent these keeps working.
 * Strict (checkout sessions): `customer_email` and `account_id` are required
 * and a malformed value is a 400.
 */
export function customerMetadata(
  body: Record<string, unknown> | null | undefined,
  options: { strict?: boolean } = {}
): CustomerMetadataResult {
  const strict = options.strict === true;
  const out: CustomerMetadata = {};
  const src = body ?? {};

  for (const field of CUSTOMER_FIELDS) {
    const raw = src[field];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      if (strict) return { ok: false, error: `${field} must be a string`, code: 'INVALID_' + field.toUpperCase() };
      continue;
    }
    let value = String(raw).trim();
    if (!value) continue;
    if (value.length > LIMITS[field]) {
      if (strict) {
        return { ok: false, error: `${field} must be at most ${LIMITS[field]} characters`, code: 'INVALID_' + field.toUpperCase() };
      }
      continue;
    }
    if (field === 'customer_email') {
      if (!isValidEmail(value)) {
        if (strict) return { ok: false, error: 'customer_email must be a valid email address', code: 'INVALID_CUSTOMER_EMAIL' };
        continue;
      }
      value = value.toLowerCase();
    }
    if (field === 'property') value = normalizeProperty(value);
    out[field] = value;
  }

  if (strict) {
    if (!out.customer_email) {
      return { ok: false, error: 'customer_email is required: the email of the person paying', code: 'MISSING_CUSTOMER_EMAIL' };
    }
    if (!out.account_id) {
      return { ok: false, error: "account_id is required: your site's user id or handle for the payer", code: 'MISSING_ACCOUNT_ID' };
    }
  }

  return { ok: true, metadata: out };
}

/**
 * The fields a payment webhook surfaces at the top of `data`, read from the
 * payment's metadata. Additive only: an absent field is left out.
 */
export function webhookCustomerFields(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const m = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['checkout_session_id', ...CUSTOMER_FIELDS]) {
    const value = m[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}
