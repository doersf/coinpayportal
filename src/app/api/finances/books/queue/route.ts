import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { getAutoAccept, isQueueSort, listQueue, toPublicRow, SPEND_CATEGORIES } from '@/lib/finances/books';
import { TAX_CATEGORIES, TAX_CATEGORY_LABELS } from '@/lib/finances/tax';
import { isModelCategorizationEnabled } from '@/lib/finances/categorize-model';
import { financeErrorFromException, financeJson } from '@/lib/finances/api';

export const dynamic = 'force-dynamic';

/**
 * GET /api/finances/books/queue — transactions awaiting review (default),
 * or reviewed/all, with the category vocabularies the UI needs.
 * Filters: `status`, `account`, `scope`, `start`, `end`, `search`, `sort`, `dir`, `limit`, `offset`.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  const q = req.nextUrl.searchParams;
  const status = q.get('status');
  const scope = q.get('scope');
  const sort = q.get('sort');
  try {
    const [page, autoAccept] = await Promise.all([listQueue(guard.id, {
      status: status === 'reviewed' || status === 'all' ? status : 'unreviewed',
      accountId: q.get('account'),
      scope: scope === 'business' || scope === 'personal' ? scope : 'all',
      start: q.get('start'),
      end: q.get('end'),
      search: q.get('search'),
      sort: isQueueSort(sort) ? sort : 'posted',
      dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
      limit: Number.parseInt(q.get('limit') ?? '50', 10) || 50,
      offset: Number.parseInt(q.get('offset') ?? '0', 10) || 0,
    }), getAutoAccept(guard.id).catch(() => true)]);
    return financeJson({
      rows: page.rows.map(toPublicRow),
      total: page.total,
      unreviewed: page.unreviewed,
      categories: SPEND_CATEGORIES,
      taxCategories: TAX_CATEGORIES.map((id) => ({ id, label: TAX_CATEGORY_LABELS[id] })),
      modelEnabled: isModelCategorizationEnabled(),
      autoAccept,
    });
  } catch (err) {
    return financeErrorFromException(err, 'Could not load the review queue');
  }
}
