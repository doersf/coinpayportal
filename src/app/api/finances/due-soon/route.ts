import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { getDueSoon } from '@/lib/finances/due-soon-load';
import { isValidTimeZone } from '@/lib/finances/periods';
import { financeErrorFromException, financeJson } from '@/lib/finances/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/finances/due-soon — charges due across every linked account.
 *
 * `?days=` is the horizon (default 7, max 60). `?timezone=` overrides the
 * saved finance timezone for "today". The response also carries every
 * recurring charge detected, so one call fills both the due list and the
 * recurring list.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;

  const params = req.nextUrl.searchParams;
  const days = Number.parseInt(params.get('days') ?? '', 10);
  const tz = params.get('timezone');
  try {
    const dueSoon = await getDueSoon(guard.id, {
      horizonDays: Number.isFinite(days) ? days : 7,
      timezone: tz && isValidTimeZone(tz) ? tz : undefined,
    });
    return financeJson({ dueSoon });
  } catch (err) {
    return financeErrorFromException(err, 'Could not load what is due');
  }
}
