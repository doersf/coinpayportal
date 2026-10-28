import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { financeError, financeErrorFromException, financeJson } from '@/lib/finances/api';
import { deleteContribution } from '@/lib/finances/goals-store';

export const dynamic = 'force-dynamic';

/** DELETE /api/finances/goals/{id}/contributions/{contributionId} — remove a recorded contribution. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; contributionId: string }> }) {
  const guard = await requireFinanceAccess(req, 'finance.write', { write: true });
  if (guard instanceof NextResponse) return guard;
  const { id, contributionId } = await params;
  try {
    const removed = await deleteContribution(guard.id, id, contributionId);
    if (!removed) return financeError('not_found', 'Contribution not found', 404);
    return financeJson({ success: true });
  } catch (err) {
    return financeErrorFromException(err, 'Could not delete the contribution');
  }
}
