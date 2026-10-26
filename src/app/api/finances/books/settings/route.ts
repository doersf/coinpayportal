import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { acceptSuggestions, getAutoAccept, setAutoAccept } from '@/lib/finances/books';
import { financeError, financeErrorFromException, financeJson, readJsonBody } from '@/lib/finances/api';
import { auditFinance } from '@/lib/finances/audit';

export const dynamic = 'force-dynamic';

/** GET /api/finances/books/settings — `{ autoAccept }`. */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  try {
    return financeJson({ autoAccept: await getAutoAccept(guard.id) });
  } catch (err) {
    return financeErrorFromException(err, 'Could not read the books settings');
  }
}

/**
 * PUT /api/finances/books/settings — body `{ autoAccept: boolean }`.
 * Turning auto-accept on also accepts the categorised backlog now, so the
 * queue empties without waiting for the next sync; `reviewed` says how many.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.write', { write: true });
  if (guard instanceof NextResponse) return guard;
  const body = await readJsonBody<{ autoAccept?: unknown }>(req);
  if (typeof body.autoAccept !== 'boolean') return financeError('invalid_request', 'autoAccept must be true or false', 400);
  try {
    await setAutoAccept(guard.id, body.autoAccept);
    await auditFinance(guard, 'books.settings', 'merchant', guard.id, { autoAccept: body.autoAccept });
    const reviewed = body.autoAccept ? await acceptSuggestions(guard.id, {}, { categorizedOnly: true, by: 'auto_accept' }) : 0;
    return financeJson({ autoAccept: body.autoAccept, reviewed });
  } catch (err) {
    return financeErrorFromException(err, 'Could not save the books settings');
  }
}
