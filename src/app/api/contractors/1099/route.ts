import { NextRequest, NextResponse } from 'next/server';
import { authorizeCatalog } from '@/lib/invoices/catalog';
import { authorizeFundsMove, fail, json, openTaxId } from '@/lib/contractors/service';

/** Payments of $600 or more to a US non-corporate payee go on a 1099-NEC. */
const THRESHOLD_CENTS = 60000;
const EXEMPT = new Set(['c_corp', 's_corp']);

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  // Neutralise spreadsheet formulas as well as quoting.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * GET /api/contractors/1099?business_id=&year=2026[&format=csv]
 *
 * What was paid to each contractor in a calendar year (by the date the payment
 * was sent), and whether they need a 1099-NEC. The JSON shows only the last
 * four of a tax id. The CSV, for filing, carries the full tax id and needs the
 * signed-in owner.
 */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const year = Number(params.get('year') ?? new Date().getUTCFullYear() - 1);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return fail('year: use a four-digit year', 400);
  const csv = params.get('format') === 'csv';

  const auth = await authorizeCatalog(request, params.get('business_id'), 'business.read');
  if (!auth.ok) return auth.response;
  if (csv) {
    const owner = await authorizeFundsMove(request, auth.businessId);
    if (!owner.ok) return owner.response;
  }

  const { data: paid, error } = await auth.supabase
    .from('pay_run_items')
    .select('contractor_id, amount')
    .eq('business_id', auth.businessId)
    .eq('status', 'paid')
    .gte('paid_at', `${year}-01-01T00:00:00Z`)
    .lt('paid_at', `${year + 1}-01-01T00:00:00Z`);
  if (error) return fail('Failed to load payments', 500);

  const totals = new Map<string, number>();
  for (const p of paid ?? []) totals.set(p.contractor_id, (totals.get(p.contractor_id) ?? 0) + Math.round(Number(p.amount) * 100));

  const { data: contractors } = totals.size
    ? await auth.supabase
        .from('contractors')
        .select(
          'id, name, email, country, tax_form, tax_status, tax_legal_name, tax_business_name, tax_classification, tax_address, tax_country, tax_id_last4, tax_id_encrypted'
        )
        .in('id', [...totals.keys()])
    : { data: [] };

  const rows = (contractors ?? []).map((c) => {
    const cents = totals.get(c.id) ?? 0;
    const usPerson = c.tax_form === 'W9';
    const reportable = usPerson && cents >= THRESHOLD_CENTS && !EXEMPT.has(c.tax_classification ?? '');
    return {
      contractor_id: c.id,
      name: c.tax_legal_name || c.name,
      business_name: c.tax_business_name,
      email: c.email,
      tax_form: c.tax_form,
      tax_status: c.tax_status,
      classification: c.tax_classification,
      address: c.tax_address,
      country: c.tax_country || c.country,
      tax_id_last4: c.tax_id_last4,
      total_paid: cents / 100,
      needs_1099_nec: reportable,
      missing_w9: !c.tax_form && (c.country ?? 'US') === 'US' && cents >= THRESHOLD_CENTS,
      _sealed: c.tax_id_encrypted as string | null,
    };
  });
  rows.sort((a, b) => b.total_paid - a.total_paid);

  if (!csv) {
    return json({
      success: true,
      year,
      threshold: THRESHOLD_CENTS / 100,
      contractors: rows.map(({ _sealed, ...r }) => r),
    });
  }

  const header = ['name', 'business_name', 'tax_id', 'address', 'country', 'email', 'classification', 'total_paid_usd', 'needs_1099_nec'];
  const lines = rows.map((r) =>
    [r.name, r.business_name, openTaxId(r._sealed) ?? '', r.address, r.country, r.email, r.classification, r.total_paid.toFixed(2), r.needs_1099_nec ? 'yes' : 'no']
      .map(csvCell)
      .join(',')
  );
  return new NextResponse([header.join(','), ...lines].join('\n') + '\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="contractors-1099-${year}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
