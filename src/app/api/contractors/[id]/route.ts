import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  authorizeContractorRow,
  CONTRACT_COLUMNS,
  CONTRACTOR_COLUMNS,
  contractorSchema,
  fail,
  json,
  MILESTONE_COLUMNS,
  PAY_RUN_ITEM_COLUMNS,
  readJson,
  WORK_ITEM_COLUMNS,
  zodError,
} from '@/lib/contractors/service';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/contractors/[id]: the contractor with contracts, milestones, work and payments. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractors', id, 'business.read');
  if (!auth.ok) return auth.response;
  const sb = auth.supabase;
  const [contractor, contracts, work, payments] = await Promise.all([
    sb.from('contractors').select(CONTRACTOR_COLUMNS).eq('id', id).single(),
    sb.from('contractor_contracts').select(`${CONTRACT_COLUMNS}, contractor_milestones (${MILESTONE_COLUMNS})`).eq('contractor_id', id).order('created_at', { ascending: false }),
    sb.from('contractor_work_items').select(WORK_ITEM_COLUMNS).eq('contractor_id', id).order('created_at', { ascending: false }).limit(500),
    sb.from('pay_run_items').select(`${PAY_RUN_ITEM_COLUMNS}, pay_runs (number, pay_date)`).eq('contractor_id', id).order('created_at', { ascending: false }).limit(200),
  ]);
  if (contractor.error) return fail('Not found', 404);
  return json({
    success: true,
    contractor: contractor.data,
    contracts: contracts.data ?? [],
    work_items: work.data ?? [],
    payments: payments.data ?? [],
  });
}

const patchSchema = contractorSchema
  .partial()
  .extend({ tax_status: z.enum(['submitted', 'verified']).optional(), status: z.enum(['invited', 'active']).optional() })
  .strict();

/** PATCH /api/contractors/[id] { name?, email?, country?, job_title?, notes?, tax_status? } */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractors', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const { business_id: _ignored, ...fields } = body;
  const parsed = patchSchema.safeParse(fields);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  if (parsed.data.tax_status === 'verified') {
    const { data: row } = await auth.supabase.from('contractors').select('tax_form').eq('id', id).single();
    if (!row?.tax_form) return fail('There is no tax form to verify yet', 400);
  }
  const { data, error } = await auth.supabase
    .from('contractors')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(CONTRACTOR_COLUMNS)
    .single();
  if (error?.code === '23505') return fail('A contractor with that email already exists', 409);
  if (error) return fail('Failed to update contractor', 500);
  return json({ success: true, contractor: data });
}

/**
 * DELETE /api/contractors/[id]: offboard. Ends live contracts, revokes the
 * portal link and keeps every record, since payments and tax forms must stay.
 */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractors', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const now = new Date().toISOString();
  await auth.supabase
    .from('contractor_contracts')
    .update({ status: 'ended', ended_at: now, end_reason: 'Contractor offboarded', next_pay_date: null, updated_at: now })
    .eq('contractor_id', id)
    .in('status', ['draft', 'sent', 'active']);
  const { error } = await auth.supabase
    .from('contractors')
    .update({ status: 'offboarded', portal_token: null, portal_token_created_at: null, updated_at: now })
    .eq('id', id);
  if (error) return fail('Failed to offboard contractor', 500);
  return json({ success: true });
}
