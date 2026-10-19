import { NextRequest } from 'next/server';
import { authorizeDocument } from '@/lib/documents/authorize';
import { fail, json, requestMeta } from '@/lib/documents/service';
import { readVersionUpload } from '@/lib/documents/version-upload';
import { addVersion, listVersions, ownerLabel } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ id: string }> };

export const dynamic = 'force-dynamic';

/** GET /api/documents/[id]/versions — the history, newest first. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeDocument(request, id, 'business.read');
  if (!auth.ok) return auth.response;
  return json({ success: true, current_version: auth.doc.current_version, versions: await listVersions(auth.supabase, id) });
}

/**
 * POST /api/documents/[id]/versions — multipart `file` (sealed under the
 * document key with AAD.version(id, n)) and `meta` { version, filename,
 * content_type, bytes, sha256, note? }. Refused once anyone has signed.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeDocument(request, id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const upload = await readVersionUpload(request);
  if (!upload.ok) return fail(upload.error, upload.status);
  const result = await addVersion(auth.supabase, auth.doc, upload.sealed, upload.meta, {
    label: await ownerLabel(auth.supabase, auth.merchantId),
    meta: requestMeta(request),
    byRecipient: false,
  });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data }, 201);
}
