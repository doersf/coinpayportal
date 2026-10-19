import { NextRequest } from 'next/server';
import { authorizeDocument } from '@/lib/documents/authorize';
import { fail, json, requestMeta } from '@/lib/documents/service';
import { readSealedUpload, sealedResponse } from '@/lib/documents/http';
import { ownerLabel, readSealedFile, storeSignedCopy } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** GET /api/documents/[id]/file?version=original|signed&n=<version no> — sealed bytes for the owner's browser to open. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeDocument(request, id, 'business.read');
  if (!auth.ok) return auth.response;
  const search = new URL(request.url).searchParams;
  const version = search.get('version') === 'signed' ? 'signed' : 'original';
  const n = Number(search.get('n'));
  const file = await readSealedFile(auth.supabase, auth.doc, version, Number.isInteger(n) && n > 0 ? n : null);
  if (!file.ok) return fail(file.error, file.status);
  return sealedResponse(file.data);
}

/**
 * POST /api/documents/[id]/file?replace=1 — the signed copy, built and sealed
 * by the owner's browser. `replace=1` rebuilds over a copy a signer sealed.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeDocument(request, id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const upload = await readSealedUpload(request);
  if (!upload.ok) return fail(upload.error, upload.status);
  const result = await storeSignedCopy(auth.supabase, auth.doc, upload.sealed, upload.meta, {
    actor: 'owner',
    label: await ownerLabel(auth.supabase, auth.merchantId),
    meta: requestMeta(request),
  }, { replace: new URL(request.url).searchParams.get('replace') === '1' });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data });
}
