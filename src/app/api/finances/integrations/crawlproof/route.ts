import { NextRequest, NextResponse } from 'next/server';
import { requireFinanceAccess } from '@/lib/finances/access';
import { financeError, financeErrorFromException, financeJson, readJsonBody, type FinanceErrorCode } from '@/lib/finances/api';
import { connectCrawlProof, disconnectCrawlProof, getCrawlProofStatus, CrawlProofError } from '@/lib/integrations/crawlproof';

export const dynamic = 'force-dynamic';

/**
 * Connect CrawlProof for the business report.
 *
 * - GET: whether it is connected (token prefix, site count, last read).
 * - POST `{ token: "crp_..." }`: verify a READ-ONLY CrawlProof token against
 *   CrawlProof and store it encrypted. Full-access tokens are refused.
 * - DELETE: disconnect (the stored token is deleted).
 *
 * Connecting and disconnecting are the owner's alone: a delegated finance
 * manager cannot attach somebody else's CrawlProof account to these books.
 */
export async function GET(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.read');
  if (guard instanceof NextResponse) return guard;
  try {
    return financeJson({ crawlproof: await getCrawlProofStatus(guard.id) });
  } catch (err) {
    return financeErrorFromException(err, 'Could not read the CrawlProof connection');
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.manage', { write: true });
  if (guard instanceof NextResponse) return guard;
  if (guard.role !== 'owner') return financeError('forbidden', 'Only the account owner can connect CrawlProof', 403);
  const body = await readJsonBody<Record<string, unknown>>(req);
  try {
    return financeJson({ crawlproof: await connectCrawlProof(guard.id, body?.token) });
  } catch (err) {
    if (err instanceof CrawlProofError) return financeError(err.code as FinanceErrorCode, err.message, err.status);
    return financeErrorFromException(err, 'Could not connect CrawlProof');
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireFinanceAccess(req, 'finance.manage', { write: true });
  if (guard instanceof NextResponse) return guard;
  if (guard.role !== 'owner') return financeError('forbidden', 'Only the account owner can disconnect CrawlProof', 403);
  try {
    return financeJson({ success: await disconnectCrawlProof(guard.id) });
  } catch (err) {
    return financeErrorFromException(err, 'Could not disconnect CrawlProof');
  }
}
