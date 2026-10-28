import 'server-only';
import { getSupabaseAdmin } from '../supabase/server';
import {
  DeclaredCostError,
  fromRow,
  normalizeDeclaredCosts,
  toRow,
  type DeclaredCost,
} from './declared-costs';

/**
 * Reading and replacing a merchant's declared costs
 * (`finance_declared_costs`, service role only).
 */

const COLUMNS =
  'source, key, payee, amount, currency, cadence, monthly_equivalent, scope, category, paid_with, next_expected, meta, updated_at';

export async function listDeclaredCosts(merchantId: string, { source }: { source?: string } = {}): Promise<DeclaredCost[]> {
  const supabase = getSupabaseAdmin();
  let query = supabase
    .from('finance_declared_costs')
    .select(COLUMNS)
    .eq('merchant_id', merchantId)
    .order('source')
    .order('key');
  if (source) query = query.eq('source', source);
  const { data, error } = await query;
  if (error) throw new Error(`Could not load declared costs: ${error.message}`);
  return (data ?? []).map((row) => fromRow(row as Record<string, unknown>));
}

/**
 * The declared costs to merge into recurring detection. Never fatal: a
 * failure here leaves the observed picture intact and says so in the log.
 */
export async function declaredCostsForPosition(merchantId: string): Promise<DeclaredCost[]> {
  try {
    return await listDeclaredCosts(merchantId);
  } catch (error) {
    console.warn('[finances] declared costs unavailable', error instanceof Error ? error.message : error);
    return [];
  }
}

/**
 * Turn a request body into declared-cost rows: an array of
 * `toCoinPayCosts` rows, `{ costs: [...] }`, or a raw OpenDevice inventory
 * (an object with `devices`), converted with `@profullstack/fleet`.
 */
export async function declaredCostsFromBody(body: unknown, source: string): Promise<DeclaredCost[]> {
  let rows: unknown = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.devices)) {
      const { toCoinPayCosts } = await import('@profullstack/fleet');
      try {
        rows = toCoinPayCosts(obj, { source });
      } catch (error) {
        throw new DeclaredCostError(`Not a valid OpenDevice inventory: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (Array.isArray(obj.costs)) {
      rows = obj.costs;
    }
  }
  return normalizeDeclaredCosts(rows, source);
}

/** Replace every declared cost of `source` for the merchant, atomically. */
export async function replaceDeclaredCosts(
  merchantId: string,
  source: string,
  costs: DeclaredCost[],
): Promise<{ removed: number; upserted: number }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc('finance_replace_declared_costs', {
    p_merchant_id: merchantId,
    p_source: source,
    p_rows: costs.map(toRow),
  });
  if (error) throw new Error(`Could not save declared costs: ${error.message}`);
  const result = (Array.isArray(data) ? data[0] : data) as { removed?: number; upserted?: number } | null;
  return { removed: Number(result?.removed ?? 0), upserted: Number(result?.upserted ?? costs.length) };
}
