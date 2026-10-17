import { NextRequest } from 'next/server';
import { authorizeCatalog } from '@/lib/invoices/catalog';
import {
  CONTRACTOR_COLUMNS,
  contractorSchema,
  contractorPortalUrl,
  fail,
  json,
  newContractorToken,
  readJson,
  zodError,
} from '@/lib/contractors/service';
import { sendContractorInvite } from '@/lib/contractors/notify';

/** GET /api/contractors?business_id=&include_offboarded=true */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const auth = await authorizeCatalog(request, params.get('business_id'), 'business.read');
  if (!auth.ok) return auth.response;
  let query = auth.supabase
    .from('contractors')
    .select(CONTRACTOR_COLUMNS)
    .eq('business_id', auth.businessId)
    .order('name');
  if (params.get('include_offboarded') !== 'true') query = query.neq('status', 'offboarded');
  const { data, error } = await query;
  if (error) return fail('Failed to load contractors', 500);

  // Pending approvals per contractor, so the list can show who is waiting.
  const { data: pending } = await auth.supabase
    .from('contractor_work_items')
    .select('contractor_id')
    .eq('business_id', auth.businessId)
    .eq('status', 'submitted');
  const waiting: Record<string, number> = {};
  for (const row of pending ?? []) waiting[row.contractor_id] = (waiting[row.contractor_id] ?? 0) + 1;

  const contractors = ((data ?? []) as unknown as Record<string, unknown>[]).map((c) => ({
    ...c,
    pending_approvals: waiting[c.id as string] ?? 0,
  }));
  return json({ success: true, contractors });
}

/** POST /api/contractors { business_id, name, email, country?, job_title?, send_invite? } */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const { business_id, send_invite, ...fields } = body;
  const auth = await authorizeCatalog(request, business_id as string | undefined, 'invoice.write');
  if (!auth.ok) return auth.response;
  const parsed = contractorSchema.safeParse(fields);
  if (!parsed.success) return fail(zodError(parsed.error), 400);

  const token = newContractorToken();
  const { data, error } = await auth.supabase
    .from('contractors')
    .insert({ ...parsed.data, business_id: auth.businessId, portal_token: token, portal_token_created_at: new Date().toISOString() })
    .select(CONTRACTOR_COLUMNS)
    .single();
  if (error?.code === '23505') return fail('A contractor with that email already exists', 409);
  if (error || !data) return fail('Failed to add contractor', 500);

  const contractor = data as unknown as { business_id: string; name: string; email: string };
  if (send_invite !== false) await sendContractorInvite(auth.supabase, contractor, token);
  return json({ success: true, contractor: data, portal_url: contractorPortalUrl(token) }, 201);
}
