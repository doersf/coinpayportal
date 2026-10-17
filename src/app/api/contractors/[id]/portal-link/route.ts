import { NextRequest } from 'next/server';
import { authorizeContractorRow, contractorPortalUrl, fail, json, newContractorToken, readJson } from '@/lib/contractors/service';
import { sendContractorInvite } from '@/lib/contractors/notify';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/contractors/[id]/portal-link { send_email? }
 * Issue a new portal link; the old one stops working. Optionally email it.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractors', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const body = (await readJson(request)) ?? {};
  const token = newContractorToken();
  const { data, error } = await auth.supabase
    .from('contractors')
    .update({ portal_token: token, portal_token_created_at: new Date().toISOString() })
    .eq('id', id)
    .neq('status', 'offboarded')
    .select('business_id, name, email')
    .maybeSingle();
  if (error) return fail('Failed to create portal link', 500);
  if (!data) return fail('An offboarded contractor has no portal', 400);
  if (body.send_email === true) await sendContractorInvite(auth.supabase, data, token);
  return json({ success: true, url: contractorPortalUrl(token) }, 201);
}
