import { NextRequest } from 'next/server';
import { serviceClient } from '@/lib/invoices/catalog';
import { fail, json, recordEvent, requestMeta } from '@/lib/documents/service';
import { readSealedUpload, sealedResponse } from '@/lib/documents/http';
import { accessByToken, readSealedFile, storeSignedCopy } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ token: string }> };

export const dynamic = 'force-dynamic';

/**
 * GET /api/sign/[token]/file?version=original|signed&n=<version no>&download=1 — sealed
 * bytes; the recipient's browser opens them with the key from its link.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const supabase = serviceClient();
  const access = await accessByToken(supabase, token);
  if (!access.ok) return fail(access.error, access.status);
  const search = new URL(request.url).searchParams;
  const version = search.get('version') === 'signed' ? 'signed' : 'original';
  const n = Number(search.get('n'));
  const file = await readSealedFile(supabase, access.doc, version, Number.isInteger(n) && n > 0 ? n : null);
  if (!file.ok) return fail(file.error, file.status);
  if (search.get('download') === '1') {
    await recordEvent(supabase, access.doc, 'downloaded', {
      actor: 'recipient',
      recipientId: access.recipient.id,
      label: access.recipient.email,
      meta: requestMeta(request),
      detail: { version },
    });
  }
  return sealedResponse(file.data);
}

/** POST /api/sign/[token]/file — the signed copy, built and sealed by this participant's browser. */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const supabase = serviceClient();
  const access = await accessByToken(supabase, token);
  if (!access.ok) return fail(access.error, access.status);
  if (access.recipient.role !== 'signer' || access.recipient.status !== 'signed') return fail('Only a signer can seal the signed copy', 403);
  const upload = await readSealedUpload(request);
  if (!upload.ok) return fail(upload.error, upload.status);
  const result = await storeSignedCopy(supabase, access.doc, upload.sealed, upload.meta, {
    actor: 'recipient',
    recipientId: access.recipient.id,
    label: access.recipient.email,
    meta: requestMeta(request),
  });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data });
}
