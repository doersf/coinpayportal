import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { financeError, financeErrorFromException, financeJson } from '@/lib/finances/api';
import { isGoalPeriod, renderReportHtml, renderReportText } from '@/lib/finances/goals';
import { goalsReport, goalsTimezone } from '@/lib/finances/goals-store';
import { appBaseUrl } from '@/lib/finances/share';

export const dynamic = 'force-dynamic';

/**
 * GET /api/finances/goals/report?period=daily|weekly|monthly|quarterly
 * [&format=json|text|html] — every active goal's change over the trailing
 * period, whether that kept pace with the deadline, and the overall status.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  const period = req.nextUrl.searchParams.get('period') ?? 'weekly';
  if (!isGoalPeriod(period)) return financeError('invalid_request', 'period must be daily, weekly, monthly or quarterly', 400);
  const format = req.nextUrl.searchParams.get('format') ?? 'json';
  try {
    const report = await goalsReport(guard.id, period, await goalsTimezone(guard.id, req.nextUrl.searchParams.get('timezone')));
    if (format === 'text') return new NextResponse(renderReportText(report), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (format === 'html') return new NextResponse(renderReportHtml(report, { appUrl: appBaseUrl() }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    return financeJson({ report, text: renderReportText(report) });
  } catch (err) {
    return financeErrorFromException(err, 'Could not build the goals report');
  }
}
