import { NextRequest } from 'next/server';
import {
  authorizeContractorRow,
  CONTRACT_COLUMNS,
  contractSchema,
  fail,
  json,
  MILESTONE_COLUMNS,
  nextPayDate,
  readJson,
  zodError,
} from '@/lib/contractors/service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/contractors/[id]/contracts
 * { title, scope?, kind: fixed|hourly|milestone, rate?, frequency?, start_date?,
 *   end_date?, first_pay_date?, notice_days?, milestones?: [{title, amount, due_date?}] }
 *
 * Creates a DRAFT. It becomes binding once the business signs and sends it
 * (PATCH action=send) and the contractor countersigns in their portal.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractors', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const { business_id: _ignored, ...fields } = body;
  const parsed = contractSchema.safeParse(fields);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const { milestones, first_pay_date, ...c } = parsed.data;

  const { data: contractor } = await auth.supabase.from('contractors').select('status').eq('id', id).single();
  if (contractor?.status === 'offboarded') return fail('This contractor has been offboarded', 400);

  const start = c.start_date ?? new Date().toISOString().slice(0, 10);
  const next = c.kind === 'fixed' ? first_pay_date ?? nextPayDate(start, c.frequency!) : null;
  if (next && next < start) return fail('first_pay_date is before start_date', 400);

  const { data: contract, error } = await auth.supabase
    .from('contractor_contracts')
    .insert({
      ...c,
      rate: c.kind === 'milestone' ? null : c.rate,
      frequency: c.kind === 'fixed' ? c.frequency : null,
      start_date: start,
      next_pay_date: next,
      business_id: auth.businessId,
      contractor_id: id,
    })
    .select(CONTRACT_COLUMNS)
    .single();
  if (error || !contract) return fail('Failed to create contract', 500);

  let created: unknown[] = [];
  if (milestones?.length) {
    const { data: rows, error: mErr } = await auth.supabase
      .from('contractor_milestones')
      .insert(
        milestones.map((m, position) => ({
          ...m,
          position,
          business_id: auth.businessId,
          contract_id: (contract as unknown as { id: string }).id,
        }))
      )
      .select(MILESTONE_COLUMNS);
    if (mErr) {
      await auth.supabase.from('contractor_contracts').delete().eq('id', (contract as unknown as { id: string }).id);
      return fail('Failed to save milestones', 500);
    }
    created = rows ?? [];
  }
  return json({ success: true, contract: { ...(contract as object), contractor_milestones: created } }, 201);
}
