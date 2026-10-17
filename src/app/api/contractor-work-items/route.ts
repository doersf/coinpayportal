import { NextRequest } from 'next/server';
import { authorizeCatalog } from '@/lib/invoices/catalog';
import { businessWorkItemSchema, fail, json, readJson, WORK_ITEM_COLUMNS, zodError } from '@/lib/contractors/service';

const STATUSES = ['submitted', 'approved', 'rejected', 'paid'];

/** GET /api/contractor-work-items?business_id=&status=submitted&contractor_id= */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const auth = await authorizeCatalog(request, params.get('business_id'), 'business.read');
  if (!auth.ok) return auth.response;
  let query = auth.supabase
    .from('contractor_work_items')
    .select(`${WORK_ITEM_COLUMNS}, contractors (name, email), contractor_contracts (title, kind, rate), contractor_milestones (title)`)
    .eq('business_id', auth.businessId)
    .order('created_at', { ascending: false })
    .limit(500);
  const status = params.get('status');
  if (status) {
    if (!STATUSES.includes(status)) return fail('Unknown status', 400);
    query = query.eq('status', status);
  }
  const contractorId = params.get('contractor_id');
  if (contractorId) query = query.eq('contractor_id', contractorId);
  const { data, error } = await query;
  if (error) return fail('Failed to load work items', 500);
  return json({ success: true, work_items: data ?? [] });
}

/**
 * POST /api/contractor-work-items { business_id, contract_id, kind: bonus|expense, amount, description, ... }
 * A line the business adds itself (a bonus, or reimbursing an expense). It is
 * approved on creation and goes into the next pay run.
 */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const { business_id, ...fields } = body;
  const auth = await authorizeCatalog(request, business_id as string | undefined, 'invoice.write');
  if (!auth.ok) return auth.response;
  const parsed = businessWorkItemSchema.safeParse(fields);
  if (!parsed.success) return fail(zodError(parsed.error), 400);

  const { data: contract } = await auth.supabase
    .from('contractor_contracts')
    .select('business_id, contractor_id, status')
    .eq('id', parsed.data.contract_id)
    .maybeSingle();
  if (!contract || contract.business_id !== auth.businessId) return fail('contract_id does not belong to this business', 400);
  if (contract.status === 'draft') return fail('Send the contract before paying against it', 400);

  const now = new Date().toISOString();
  const { data, error } = await auth.supabase
    .from('contractor_work_items')
    .insert({
      ...parsed.data,
      business_id: auth.businessId,
      contractor_id: contract.contractor_id,
      submitted_by: 'business',
      status: 'approved',
      reviewed_by: auth.merchantId,
      reviewed_at: now,
    })
    .select(WORK_ITEM_COLUMNS)
    .single();
  if (error || !data) return fail('Failed to add the payment line', 500);
  return json({ success: true, work_item: data }, 201);
}
