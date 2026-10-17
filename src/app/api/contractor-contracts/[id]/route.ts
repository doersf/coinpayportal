import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authorizeContractorRow, CONTRACT_COLUMNS, fail, json, readJson, zodError } from '@/lib/contractors/service';
import { sendContractToSign } from '@/lib/contractors/notify';

type Ctx = { params: Promise<{ id: string }> };

const actionSchema = z.discriminatedUnion('action', [
  // The business signs and sends the draft to the contractor.
  z.object({ action: z.literal('send'), signature: z.string().trim().min(2).max(200) }).strict(),
  // End a contract; fixed fees stop after end_date (default today).
  z
    .object({
      action: z.literal('end'),
      reason: z.string().trim().max(1000).optional(),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .strict(),
]);

/** PATCH /api/contractor-contracts/[id] { action: 'send', signature } | { action: 'end', reason?, end_date? } */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractor_contracts', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const now = new Date().toISOString();

  if (parsed.data.action === 'send') {
    const { data, error } = await auth.supabase
      .from('contractor_contracts')
      .update({ status: 'sent', business_signed_name: parsed.data.signature, business_signed_at: now, updated_at: now })
      .eq('id', id)
      .eq('status', 'draft')
      .select(CONTRACT_COLUMNS)
      .maybeSingle();
    if (error) return fail('Failed to send contract', 500);
    if (!data) return fail('Only a draft contract can be sent', 409);
    const contract = data as unknown as { contractor_id: string; title: string };
    const { data: contractor } = await auth.supabase
      .from('contractors')
      .select('business_id, name, email, portal_token')
      .eq('id', contract.contractor_id)
      .single();
    if (contractor) await sendContractToSign(auth.supabase, contractor, contract);
    return json({ success: true, contract: data });
  }

  const endDate = parsed.data.end_date ?? now.slice(0, 10);
  const { data: current } = await auth.supabase.from('contractor_contracts').select('start_date, next_pay_date').eq('id', id).single();
  if (current && endDate < current.start_date) return fail('end_date is before the contract started', 400);
  const { data, error } = await auth.supabase
    .from('contractor_contracts')
    .update({
      status: 'ended',
      end_date: endDate,
      ended_at: now,
      end_reason: parsed.data.reason ?? null,
      // Any fixed period on or before the end date is still owed and will be generated.
      next_pay_date: current?.next_pay_date && current.next_pay_date <= endDate ? current.next_pay_date : null,
      updated_at: now,
    })
    .eq('id', id)
    .in('status', ['draft', 'sent', 'active'])
    .select(CONTRACT_COLUMNS)
    .maybeSingle();
  if (error) return fail('Failed to end contract', 500);
  if (!data) return fail('This contract has already ended', 409);
  return json({ success: true, contract: data });
}

/** DELETE /api/contractor-contracts/[id]: discard a draft that was never sent. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'contractor_contracts', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const { data } = await auth.supabase.from('contractor_contracts').delete().eq('id', id).eq('status', 'draft').select('id');
  if (!data?.length) return fail('Only a draft contract can be deleted; end a live one instead', 409);
  return json({ success: true });
}
