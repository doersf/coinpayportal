import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authorizeCatalog } from '@/lib/invoices/catalog';
import { fail, json, PAY_RUN_COLUMNS, readJson } from '@/lib/contractors/service';

/** GET /api/pay-runs?business_id= */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const auth = await authorizeCatalog(request, params.get('business_id'), 'business.read');
  if (!auth.ok) return auth.response;
  const { data, error } = await auth.supabase
    .from('pay_runs')
    .select(`${PAY_RUN_COLUMNS}, pay_run_items (id, status)`)
    .eq('business_id', auth.businessId)
    .order('number', { ascending: false })
    .limit(200);
  if (error) return fail('Failed to load pay runs', 500);
  const runs = (data ?? []).map((r) => {
    const items = (r.pay_run_items ?? []) as { status: string }[];
    const { pay_run_items: _items, ...run } = r;
    return { ...run, contractors: items.length, paid: items.filter((i) => i.status === 'paid').length };
  });
  return json({ success: true, pay_runs: runs });
}

/**
 * POST /api/pay-runs { business_id, pay_date? }
 * Draft a run: fixed fees due by pay_date plus every approved, unpaid line.
 * Drafting moves no money, so writers (and API keys) may do it.
 */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const auth = await authorizeCatalog(request, body.business_id as string | undefined, 'invoice.write');
  if (!auth.ok) return auth.response;
  const payDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).safeParse(body.pay_date ?? new Date().toISOString().slice(0, 10));
  if (!payDate.success) return fail('pay_date: Use YYYY-MM-DD', 400);

  const { data: runId, error } = await auth.supabase.rpc('contractor_build_pay_run', {
    p_business: auth.businessId,
    p_pay_date: payDate.data,
    p_created_by: auth.merchantId,
    p_auto: false,
  });
  if (error) {
    if (/nothing_to_pay/.test(error.message)) {
      return fail('Nothing to pay yet: no approved work or fixed fees are due by that date', 409);
    }
    return fail('Failed to create pay run', 500);
  }
  const { data: run } = await auth.supabase.from('pay_runs').select(PAY_RUN_COLUMNS).eq('id', runId).single();
  return json({ success: true, pay_run: run }, 201);
}
