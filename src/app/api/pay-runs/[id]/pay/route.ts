import { NextRequest } from 'next/server';
import { z } from 'zod';
import { serviceClient } from '@/lib/invoices/catalog';
import { authorizeFundsMove, fail, json, readJson, zodError } from '@/lib/contractors/service';
import { markIndeterminateFailed, payRunFromWallet, recordManualPayment, type ItemOutcome } from '@/lib/contractors/pay';

type Ctx = { params: Promise<{ id: string }> };

const txHash = z.string().trim().min(8).max(200);
const paySchema = z.discriminatedUnion('method', [
  // Send from the business payout wallet (all payable items, or the ones named).
  z.object({ method: z.literal('wallet'), item_ids: z.array(z.string().uuid()).max(500).optional() }).strict(),
  // The owner paid from their own wallet: record each transaction.
  z
    .object({
      method: z.literal('manual'),
      payments: z.array(z.object({ item_id: z.string().uuid(), tx_hash: txHash }).strict()).min(1).max(500),
    })
    .strict(),
  // An indeterminate send that the owner confirmed did NOT land.
  z.object({ method: z.literal('mark_failed'), item_id: z.string().uuid() }).strict(),
]);

/**
 * POST /api/pay-runs/[id]/pay
 * Owner only, from a signed-in session. Returns one outcome per item.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return fail('Not found', 404);
  const { data: run } = await serviceClient().from('pay_runs').select('id, business_id, status').eq('id', id).maybeSingle();
  if (!run) return fail('Not found', 404);
  const auth = await authorizeFundsMove(request, run.business_id);
  if (!auth.ok) return auth.response;
  if (run.status === 'paid') return fail('This pay run is already paid', 409);

  const parsed = paySchema.safeParse(await readJson(request));
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const sb = auth.supabase;

  let outcomes: ItemOutcome[] = [];
  if (parsed.data.method === 'wallet') {
    outcomes = await payRunFromWallet(sb, id, auth.merchantId, parsed.data.item_ids);
  } else {
    const ids = parsed.data.method === 'manual' ? parsed.data.payments.map((p) => p.item_id) : [parsed.data.item_id];
    const { data: items } = await sb.from('pay_run_items').select('*').eq('pay_run_id', id).in('id', ids);
    const byId = new Map((items ?? []).map((i) => [i.id as string, i]));
    if (byId.size !== new Set(ids).size) return fail('An item_id does not belong to this pay run', 400);
    if (parsed.data.method === 'manual') {
      for (const p of parsed.data.payments) outcomes.push(await recordManualPayment(sb, byId.get(p.item_id), p.tx_hash, auth.merchantId));
    } else {
      outcomes.push(await markIndeterminateFailed(sb, byId.get(parsed.data.item_id)));
    }
  }

  const { data: updated } = await sb.from('pay_runs').select('id, number, status, total, paid_at').eq('id', id).single();
  return json({ success: outcomes.every((o) => !o.error), pay_run: updated, outcomes });
}
