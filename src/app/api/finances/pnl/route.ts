import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { loadPnl } from '@/lib/finances/pnl-data';
import { lastCompleteMonths, renderPnlCsv, renderPnlHtml, renderPnlPdf } from '@/lib/finances/pnl';
import { resolvePeriod, boundPeriod } from '@/lib/finances/periods';
import { resolveFinanceTimezone } from '@/lib/finances/settings';
import { financeError, financeErrorFromException } from '@/lib/finances/api';
import { canonicalJson } from '@/lib/finances/render';
import { auditFinance } from '@/lib/finances/audit';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

/**
 * GET /api/finances/pnl?scope=personal|business&months=3&format=pdf|html|csv|json
 *
 * A profit and loss statement over the linked accounts of one scope. With
 * no period it covers the last `months` complete calendar months (default
 * 3, at most 24); `from`/`to` or `period` (as on /books/export) override.
 * `name` is the holder printed on the statement.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  const q = req.nextUrl.searchParams;

  const formatParam = (q.get('format') ?? 'pdf').toLowerCase();
  const format: 'csv' | 'pdf' | 'html' | 'json' | null =
    formatParam === 'csv' ? 'csv' : formatParam === 'pdf' ? 'pdf' : formatParam === 'html' ? 'html' : formatParam === 'json' ? 'json' : null;
  if (!format) return financeError('invalid_request', 'format must be pdf, html, csv or json', 400);
  const scopeParam = q.get('scope');
  const scope = scopeParam === 'business' ? 'business' : scopeParam === 'personal' ? 'personal' : null;
  if (!scope) return financeError('invalid_request', 'scope must be personal or business', 400);
  const monthsParam = q.get('months');
  const months = monthsParam === null ? 3 : Number.parseInt(monthsParam, 10);
  if (!Number.isInteger(months) || months < 1 || months > 24) return financeError('invalid_request', 'months must be 1 to 24', 400);
  const holder = (q.get('name') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'Account holder';

  try {
    const tz = await resolveFinanceTimezone(guard.id, q.get('timezone'), { remember: false });
    if (!tz) return financeError('timezone_required', 'Pass an IANA timezone such as America/Los_Angeles', 400);
    const timezone = new Intl.DateTimeFormat('en-US', { timeZone: tz.timezone }).resolvedOptions().timeZone;
    let from = q.get('from');
    let to = q.get('to');
    let period = q.get('period');
    if (period && /^\d{4}$/.test(period)) {
      const year = Number.parseInt(period, 10);
      from = `${year}-01-01`;
      to = `${year + 1}-01-01`;
      period = null;
    }
    if (!period && !from && !to) ({ from, to } = lastCompleteMonths(months, new Date(), timezone));
    const bounded = boundPeriod(resolvePeriod({ period, from, to, timezone }), new Date());
    const statement = await loadPnl(guard.id, { scope, start: bounded.start, end: bounded.effectiveEnd, timezone, holder });
    const fileLabel = `${bounded.start.slice(0, 10)}_${bounded.effectiveEnd.slice(0, 10)}`;

    let bytes: Buffer;
    let contentType: string;
    const extraHeaders: Record<string, string> = {};
    if (format === 'csv') {
      bytes = Buffer.from(renderPnlCsv(statement), 'utf8');
      contentType = 'text/csv; charset=utf-8';
    } else if (format === 'html') {
      bytes = Buffer.from(renderPnlHtml(statement), 'utf8');
      contentType = 'text/html; charset=utf-8';
      extraHeaders['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    } else if (format === 'json') {
      const { rows, itemized, ...rest } = statement;
      bytes = Buffer.from(canonicalJson({
        ...rest,
        periodToDate: bounded.periodToDate,
        itemized: itemized.map((r) => ({ id: r.id, posted: r.posted, amount: r.amount, account: r.account.name, institution: r.account.orgName, description: r.description, line: r.line, label: r.label, basis: r.basis })),
        rows: rows.map((r) => ({ id: r.id, posted: r.posted, amount: r.amount, accountId: r.accountId, line: r.line, section: r.section, basis: r.basis, pairedWith: r.pairedWith })),
      }), 'utf8');
      contentType = 'application/json; charset=utf-8';
    } else {
      bytes = await renderPnlPdf(statement);
      contentType = 'application/pdf';
    }
    await auditFinance(guard, 'pnl.export', 'merchant', guard.id, { format, scope, rows: statement.rows.length });
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `attachment; filename="coinpay-pnl-${scope}-${fileLabel}.${format}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...extraHeaders,
      },
    });
  } catch (err) {
    return financeErrorFromException(err, 'Could not build the profit and loss statement');
  }
}
