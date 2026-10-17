import { NextRequest } from 'next/server';
import {
  authorizeContractorRow,
  fail,
  json,
  PAY_RUN_COLUMNS,
  PAY_RUN_ITEM_COLUMNS,
  WALLET_CHANGE_WARNING_MS,
  WORK_ITEM_COLUMNS,
} from '@/lib/contractors/service';

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/pay-runs/[id]: the run, one row per contractor with the lines it
 * pays, and what stands in the way of paying each one (no wallet yet, a wallet
 * changed in the last 72 hours, no business wallet that can send that coin).
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'pay_runs', id, 'business.read');
  if (!auth.ok) return auth.response;
  const sb = auth.supabase;

  const { data: run } = await sb.from('pay_runs').select(PAY_RUN_COLUMNS).eq('id', id).single();
  if (!run) return fail('Not found', 404);
  const { data: items } = await sb
    .from('pay_run_items')
    .select(
      `${PAY_RUN_ITEM_COLUMNS}, contractors (name, email, country, payout_currency, payout_wallet, payout_wallet_changed_at, tax_status), ` +
        `contractor_work_items (${WORK_ITEM_COLUMNS})`
    )
    .eq('pay_run_id', id)
    .order('amount', { ascending: false });

  // Which coins the business can send automatically (a wallet holding a key).
  const { data: wallets } = await sb
    .from('business_wallets')
    .select('cryptocurrency')
    .eq('business_id', run.business_id)
    .eq('is_active', true)
    .not('encrypted_private_key', 'is', null);
  const sendable = new Set((wallets ?? []).map((w) => w.cryptocurrency as string));

  const now = Date.now();
  const rows = ((items ?? []) as unknown as Record<string, unknown>[]).map((item) => {
    const c = item.contractors as unknown as {
      payout_currency: string | null;
      payout_wallet: string | null;
      payout_wallet_changed_at: string | null;
    } | null;
    const warnings: string[] = [];
    if (!c?.payout_wallet) warnings.push('No payout wallet yet: ask the contractor to add one in their portal');
    if (c?.payout_wallet_changed_at && now - new Date(c.payout_wallet_changed_at).getTime() < WALLET_CHANGE_WARNING_MS) {
      warnings.push('Payout wallet changed in the last 72 hours: confirm it with the contractor before paying');
    }
    return {
      ...item,
      warnings,
      can_send_from_wallet: Boolean(c?.payout_currency && sendable.has(c.payout_currency)),
    };
  });
  return json({ success: true, pay_run: run, items: rows, sendable_coins: [...sendable] });
}

/** DELETE /api/pay-runs/[id]: discard a draft. Its lines go back to the approved pool. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeContractorRow(request, 'pay_runs', id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const { data: run } = await auth.supabase.from('pay_runs').select('status').eq('id', id).single();
  if (run?.status !== 'draft') return fail('Only a draft pay run can be deleted', 409);
  const { data: started } = await auth.supabase.from('pay_run_items').select('id').eq('pay_run_id', id).neq('status', 'pending').limit(1);
  if (started?.length) return fail('Payments have started on this run; it can no longer be deleted', 409);
  const { error } = await auth.supabase.from('pay_runs').delete().eq('id', id).eq('status', 'draft');
  if (error) return fail('Failed to delete pay run', 500);
  return json({ success: true });
}
