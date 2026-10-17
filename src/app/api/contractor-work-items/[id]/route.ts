import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authorizeContractorRow, fail, json, readJson, WORK_ITEM_COLUMNS, zodError } from '@/lib/contractors/service';

type Ctx = { params: Promise<{ id: string }> };

const reviewSchema = z
  .object({ action: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() })
  .strict();

/**
 * PATCH /api/contractor-work-items/[id] { action: approve|reject, note? }
 * Approve or reject a submission. Approved lines are picked up by the next pay
 * run; a line already in a pay run cannot be reviewed again.
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractor_work_items', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const parsed = reviewSchema.safeParse(await readJson(request));
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  if (parsed.data.action === 'reject' && !parsed.data.note) return fail('Say why when rejecting, so the contractor can fix it', 400);

  const status = parsed.data.action === 'approve' ? 'approved' : 'rejected';
  const { data, error } = await auth.supabase
    .from('contractor_work_items')
    .update({ status, review_note: parsed.data.note ?? null, reviewed_by: auth.merchantId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'submitted')
    .select(WORK_ITEM_COLUMNS)
    .maybeSingle();
  if (error) return fail('Failed to review', 500);
  if (!data) return fail('Only a submitted line can be reviewed', 409);

  const item = data as unknown as { milestone_id: string | null };
  if (item.milestone_id) {
    await auth.supabase
      .from('contractor_milestones')
      .update({ status: status === 'approved' ? 'approved' : 'pending' })
      .eq('id', item.milestone_id);
  }
  return json({ success: true, work_item: data });
}
