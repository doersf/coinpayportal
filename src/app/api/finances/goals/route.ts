import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { financeError, financeErrorFromException, financeJson, readJsonBody } from '@/lib/finances/api';
import { GoalError, GOAL_DISCLAIMER } from '@/lib/finances/goals';
import { createGoal, goalsWithProgress, goalsTimezone } from '@/lib/finances/goals-store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/finances/goals[?archived=1] — every goal with where it stands
 * today: progress, percent, on track or behind, and what it takes per
 * day/week/month/quarter to finish by the deadline.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  try {
    const timezone = await goalsTimezone(guard.id, req.nextUrl.searchParams.get('timezone'));
    const goals = await goalsWithProgress(guard.id, timezone, { includeArchived: req.nextUrl.searchParams.get('archived') === '1' });
    return financeJson({ goals, timezone, disclaimer: GOAL_DISCLAIMER });
  } catch (err) {
    return financeErrorFromException(err, 'Could not load goals');
  }
}

/**
 * POST /api/finances/goals — create a goal. Body: `{ name, kind: "house" |
 * "car" | "emergency_fund" | "debt_payoff" | "custom", targetAmount,
 * deadline: "2031-06-30", currency?: "USD", startDate?, startingAmount?,
 * linkedAccountIds?: [...], linkedWalletIds?: [...], notes? }`.
 *
 * Linked finance accounts and web wallets make progress follow their real
 * balances; without links, progress is `startingAmount` plus the
 * contributions recorded at /goals/{id}/contributions. A payoff goal linked
 * to debt accounts with no `startingAmount` starts at what they owe now.
 */
export async function POST(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.write', { write: true });
  if (guard instanceof NextResponse) return guard;
  const body = await readJsonBody<Record<string, unknown>>(req);
  try {
    const timezone = await goalsTimezone(guard.id, req.nextUrl.searchParams.get('timezone'));
    const goal = await createGoal(guard.id, body, timezone);
    const all = await goalsWithProgress(guard.id, timezone);
    return financeJson({ goal: all.find((g) => g.id === goal.id) ?? goal }, 201);
  } catch (err) {
    if (err instanceof GoalError) return financeError('invalid_request', err.message, 400);
    return financeErrorFromException(err, 'Could not create the goal');
  }
}
