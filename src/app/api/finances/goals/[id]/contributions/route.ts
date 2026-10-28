import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { financeError, financeErrorFromException, financeJson, readJsonBody } from '@/lib/finances/api';
import { GoalError } from '@/lib/finances/goals';
import { addContribution, getGoal, listContributions, goalsTimezone } from '@/lib/finances/goals-store';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/finances/goals/{id}/contributions — manual contributions, newest first. */
export async function GET(req: NextRequest, { params }: Ctx) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  try {
    if (!(await getGoal(guard.id, id))) return financeError('not_found', 'Goal not found', 404);
    return financeJson({ contributions: await listContributions(guard.id, id) });
  } catch (err) {
    return financeErrorFromException(err, 'Could not load contributions');
  }
}

/**
 * POST /api/finances/goals/{id}/contributions — record an amount put toward
 * the goal (or a payment on the debt) by hand. Body: `{ amount, occurredOn?:
 * "2026-10-28", note? }`; a negative amount is a withdrawal. Records only:
 * nothing is moved.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  const guard = await requireFinanceAccess(req, 'finance.write', { write: true });
  if (guard instanceof NextResponse) return guard;
  const { id } = await params;
  const body = await readJsonBody<Record<string, unknown>>(req);
  try {
    const contribution = await addContribution(guard.id, id, body, await goalsTimezone(guard.id, req.nextUrl.searchParams.get('timezone')));
    if (!contribution) return financeError('not_found', 'Goal not found', 404);
    return financeJson({ contribution }, 201);
  } catch (err) {
    if (err instanceof GoalError) return financeError('invalid_request', err.message, 400);
    return financeErrorFromException(err, 'Could not save the contribution');
  }
}
