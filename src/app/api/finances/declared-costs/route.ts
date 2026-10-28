import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { financeError, financeErrorFromException, financeJson } from '@/lib/finances/api';
import { DeclaredCostError, isValidSource } from '@/lib/finances/declared-costs';
import { declaredCostsFromBody, listDeclaredCosts, replaceDeclaredCosts } from '@/lib/finances/declared-costs-store';

export const dynamic = 'force-dynamic';

/** An inventory is small; anything past this is not one. */
const MAX_BODY_BYTES = 1_000_000;

function totals(costs: Array<{ currency: string; monthlyEquivalent: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of costs) out[c.currency] = Math.round(((out[c.currency] ?? 0) + c.monthlyEquivalent) * 100) / 100;
  return out;
}

/**
 * GET /api/finances/declared-costs[?source=opendevice] — the owner's declared
 * recurring costs, with the monthly total per currency.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;

  const source = req.nextUrl.searchParams.get('source');
  if (source !== null && !isValidSource(source)) return financeError('invalid_request', 'Invalid source', 400);
  try {
    const costs = await listDeclaredCosts(guard.id, { source: source ?? undefined });
    return financeJson({ costs, monthly: totals(costs) });
  } catch (err) {
    return financeErrorFromException(err, 'Could not load declared costs');
  }
}

/**
 * PUT /api/finances/declared-costs?source=opendevice — replace that source's
 * whole set. The body is an array of `toCoinPayCosts` rows, `{ costs: [...] }`,
 * or a raw OpenDevice inventory (converted server-side with
 * @profullstack/fleet). An empty array clears the source.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.write', { write: true });
  if (guard instanceof NextResponse) return guard;

  const source = req.nextUrl.searchParams.get('source') ?? 'opendevice';
  if (!isValidSource(source)) return financeError('invalid_request', 'source must be 1-32 lowercase letters, digits, - or _', 400);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return financeError('invalid_request', 'Body too large', 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return financeError('invalid_request', 'Invalid JSON body', 400);
  }

  try {
    const costs = await declaredCostsFromBody(body, source);
    const result = await replaceDeclaredCosts(guard.id, source, costs);
    const saved = await listDeclaredCosts(guard.id, { source });
    return financeJson({ source, ...result, costs: saved, monthly: totals(saved) });
  } catch (err) {
    if (err instanceof DeclaredCostError) return financeError('invalid_request', err.message, 400);
    return financeErrorFromException(err, 'Could not save declared costs');
  }
}
