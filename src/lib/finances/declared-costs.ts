import type { AccountScope, RecurrenceCadence, RecurringCharge } from './position';

/**
 * Declared costs: recurring bills the owner states instead of the feed seeing.
 *
 * Recurring detection only knows what a bank or card feed shows, so a server
 * paid by PayPal, crypto or a card that is not linked never appears in it. A
 * declared cost fills that gap. The first source is an OpenDevice inventory
 * (logicsrc.com/docs/opendevice, converted by `@profullstack/fleet`'s
 * `toCoinPayCosts`), but nothing here is specific to it: any `source` may
 * state a set of costs, and each source's set is replaced as a whole.
 *
 * **The matching rule** (OpenDevice "Cost"): a declared cost and an observed
 * charge for the same thing are one cost. A detected charge matches a declared
 * cost when the payee agrees, the amount is within 10 percent and the billing
 * interval is the same. The observed charge is then kept, marked `matched` and
 * annotated with the declaration; the declaration itself is not counted again.
 * A declared cost no charge matches is counted as `declared`.
 *
 * Pure, so the whole merge is testable without a database.
 */

export type DeclaredCadence = 'monthly' | 'yearly';

export interface DeclaredCost {
  source: string;
  key: string;
  payee: string;
  /** Positive amount per `cadence`. */
  amount: number;
  currency: string;
  cadence: DeclaredCadence;
  monthlyEquivalent: number;
  scope: AccountScope;
  category: string | null;
  paidWith: string | null;
  /** Next billing date (ISO), when the source knows it. */
  nextExpected: string | null;
  /** Whatever else the source carried (an OpenDevice row's `device`). */
  meta: Record<string, unknown>;
  updatedAt?: string | null;
}

/** What a matched charge, or a declared row, says about its declaration. */
export interface DeclaredRef {
  source: string;
  key: string;
  payee: string;
  amount: number;
  cadence: DeclaredCadence;
  monthlyEquivalent: number;
  category: string | null;
  paidWith: string | null;
  meta: Record<string, unknown>;
}

export const MAX_DECLARED_COSTS = 500;
const SOURCE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
/** Amount tolerance of the matching rule. */
export const MATCH_TOLERANCE = 0.1;

export class DeclaredCostError extends Error {}

export function isValidSource(value: unknown): value is string {
  return typeof value === 'string' && SOURCE_RE.test(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function cadenceOf(value: unknown): DeclaredCadence | null {
  const v = String(value ?? '').toLowerCase();
  if (v === 'monthly' || v === 'month') return 'monthly';
  if (v === 'yearly' || v === 'year' || v === 'annual' || v === 'annually') return 'yearly';
  return null;
}

/**
 * Validate and normalise rows as `toCoinPayCosts` produces them (camelCase) or
 * as stored (snake_case). Throws `DeclaredCostError` naming the bad row.
 */
export function normalizeDeclaredCosts(rows: unknown, source: string): DeclaredCost[] {
  if (!isValidSource(source)) throw new DeclaredCostError('source must be 1-32 lowercase letters, digits, - or _');
  if (!Array.isArray(rows)) throw new DeclaredCostError('Expected an array of costs');
  if (rows.length > MAX_DECLARED_COSTS) throw new DeclaredCostError(`At most ${MAX_DECLARED_COSTS} costs per source`);

  const seen = new Set<string>();
  return rows.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new DeclaredCostError(`Cost ${i + 1} is not an object`);
    const r = raw as Record<string, unknown>;
    const where = `Cost ${i + 1}`;

    const key = text(r.key, 120);
    if (!key) throw new DeclaredCostError(`${where}: key is required`);
    if (seen.has(key)) throw new DeclaredCostError(`${where}: duplicate key ${key}`);
    seen.add(key);

    const payee = text(r.payee, 80);
    if (!payee) throw new DeclaredCostError(`${where} (${key}): payee is required`);

    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 10_000_000) throw new DeclaredCostError(`${where} (${key}): amount must be a positive number`);

    const currency = String(r.currency ?? 'USD').toUpperCase();
    if (!CURRENCY_RE.test(currency)) throw new DeclaredCostError(`${where} (${key}): currency must be an ISO 4217 code`);

    const cadence = cadenceOf(r.cadence);
    if (!cadence) throw new DeclaredCostError(`${where} (${key}): cadence must be monthly or yearly`);

    const monthlyRaw = r.monthlyEquivalent ?? r.monthly_equivalent;
    let monthlyEquivalent = Number(monthlyRaw);
    if (monthlyRaw === undefined || monthlyRaw === null || !Number.isFinite(monthlyEquivalent) || monthlyEquivalent < 0) {
      monthlyEquivalent = cadence === 'yearly' ? amount / 12 : amount;
    }

    const scopeRaw = r.scope ?? 'business';
    if (scopeRaw !== 'business' && scopeRaw !== 'personal') throw new DeclaredCostError(`${where} (${key}): scope must be business or personal`);

    const nextRaw = r.nextExpected ?? r.next_expected ?? null;
    let nextExpected: string | null = null;
    if (nextRaw !== null && nextRaw !== undefined && nextRaw !== '') {
      const t = Date.parse(String(nextRaw));
      if (!Number.isFinite(t)) throw new DeclaredCostError(`${where} (${key}): nextExpected is not a date`);
      nextExpected = new Date(t).toISOString();
    }

    // Everything the source said beyond the known fields, kept for display.
    const meta: Record<string, unknown> = {};
    if (r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta)) Object.assign(meta, r.meta);
    if (r.device && typeof r.device === 'object') meta.device = r.device;
    if (JSON.stringify(meta).length > 4000) throw new DeclaredCostError(`${where} (${key}): too much metadata`);

    return {
      source,
      key,
      payee,
      amount: round2(amount),
      currency,
      cadence,
      monthlyEquivalent: round2(monthlyEquivalent),
      scope: scopeRaw,
      category: text(r.category, 40),
      paidWith: text(r.paidWith ?? r.paid_with, 40),
      nextExpected,
      meta,
    };
  });
}

/** Payee reduced to letters, the way recurring detection keys a series. */
export function payeeKey(value: string | null | undefined): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b[a-z]*\d[a-z0-9]*\b/g, ' ')
    .replace(/[^a-z]/g, '');
}

function payeeMatches(charge: RecurringCharge, cost: DeclaredCost): boolean {
  const names = [cost.payee];
  const provider = (cost.meta.device as { provider?: unknown } | undefined)?.provider;
  if (typeof provider === 'string') names.push(provider);
  const seen = [payeeKey(charge.payee), payeeKey(charge.key.slice(charge.key.indexOf(':') + 1))].filter((k) => k.length >= 3);
  return names
    .map(payeeKey)
    .filter((k) => k.length >= 3)
    .some((d) => seen.some((s) => s.includes(d) || d.includes(s)));
}

function cadenceMatches(observed: RecurrenceCadence, declared: DeclaredCadence): boolean {
  return declared === 'monthly' ? observed === 'monthly' : observed === 'annual';
}

function refOf(cost: DeclaredCost): DeclaredRef {
  return {
    source: cost.source,
    key: cost.key,
    payee: cost.payee,
    amount: cost.amount,
    cadence: cost.cadence,
    monthlyEquivalent: cost.monthlyEquivalent,
    category: cost.category,
    paidWith: cost.paidWith,
    meta: cost.meta,
  };
}

/** Roll a stated billing date forward by whole intervals until it is not in the past. */
function nextOnOrAfter(iso: string | null, cadence: DeclaredCadence, now: Date): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  // A stated billing date is a calendar day ("next_due": "2026-11-01"),
  // which arrives as UTC midnight: the evening before in the Americas. Noon
  // UTC is the same calendar day from UTC-11 to UTC+11.
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0) d.setUTCHours(12);
  const step = cadence === 'yearly' ? 12 : 1;
  const floor = now.getTime() - 86_400_000;
  for (let i = 0; i < 600 && d.getTime() < floor; i += 1) d.setUTCMonth(d.getUTCMonth() + step);
  return d.toISOString();
}

/**
 * Join declared costs with the detected charges.
 *
 * Observed charges come back marked `observed` or, when one matches a
 * declaration, `matched` with that declaration attached. Unmatched
 * declarations are appended as charges of `origin: 'declared'` with no
 * account. Only declarations in `currency` (the books' primary currency) are
 * merged; the rest are returned in `skipped` so a caller can say so.
 */
export function mergeDeclaredCosts(
  charges: RecurringCharge[],
  declared: DeclaredCost[],
  { now = new Date(), currency = null }: { now?: Date; currency?: string | null } = {},
): { charges: RecurringCharge[]; skipped: DeclaredCost[] } {
  const out: RecurringCharge[] = charges.map((c) => ({ ...c, origin: c.origin ?? 'observed' }));
  const skipped: DeclaredCost[] = [];
  const taken = new Set<number>();

  for (const cost of declared) {
    if (currency && cost.currency !== currency) {
      skipped.push(cost);
      continue;
    }

    // The closest amount among charges that agree on payee and interval.
    let best = -1;
    let bestDiff = Number.POSITIVE_INFINITY;
    out.forEach((c, i) => {
      if (taken.has(i) || c.isDebtService || c.origin !== 'observed') return;
      if (!cadenceMatches(c.cadence, cost.cadence) || !payeeMatches(c, cost)) return;
      const diff = Math.abs(c.amount - cost.amount);
      if (diff > cost.amount * MATCH_TOLERANCE) return;
      if (diff < bestDiff) {
        best = i;
        bestDiff = diff;
      }
    });

    if (best >= 0) {
      taken.add(best);
      out[best] = { ...out[best], origin: 'matched', declared: refOf(cost) };
      continue;
    }

    out.push({
      key: `declared:${cost.source}:${cost.key}`,
      payee: cost.payee,
      amount: cost.amount,
      cadence: cost.cadence === 'yearly' ? 'annual' : 'monthly',
      occurrences: 0,
      lastSeen: cost.updatedAt ?? '',
      nextExpected: nextOnOrAfter(cost.nextExpected, cost.cadence, now),
      monthlyEquivalent: cost.monthlyEquivalent,
      scope: cost.scope,
      isDebtService: false,
      accountId: '',
      accountName: cost.paidWith ? `Declared (${cost.source}, ${cost.paidWith})` : `Declared (${cost.source})`,
      origin: 'declared',
      declared: refOf(cost),
    });
  }

  out.sort((a, b) => b.monthlyEquivalent - a.monthlyEquivalent);
  return { charges: out, skipped };
}

/** A stored row (snake_case) as the pure type. */
export function fromRow(row: Record<string, unknown>): DeclaredCost {
  return {
    source: String(row.source),
    key: String(row.key),
    payee: String(row.payee),
    amount: Number(row.amount),
    currency: String(row.currency),
    cadence: row.cadence === 'yearly' ? 'yearly' : 'monthly',
    monthlyEquivalent: Number(row.monthly_equivalent),
    scope: row.scope === 'personal' ? 'personal' : 'business',
    category: (row.category as string | null) ?? null,
    paidWith: (row.paid_with as string | null) ?? null,
    nextExpected: (row.next_expected as string | null) ?? null,
    meta: (row.meta as Record<string, unknown> | null) ?? {},
    updatedAt: (row.updated_at as string | null) ?? null,
  };
}

/** The pure type as a row for `finance_replace_declared_costs`. */
export function toRow(cost: DeclaredCost): Record<string, unknown> {
  return {
    key: cost.key,
    payee: cost.payee,
    amount: cost.amount,
    currency: cost.currency,
    cadence: cost.cadence,
    monthly_equivalent: cost.monthlyEquivalent,
    scope: cost.scope,
    category: cost.category,
    paid_with: cost.paidWith,
    next_expected: cost.nextExpected,
    meta: cost.meta,
  };
}
