import { NextRequest } from 'next/server';
import { serviceClient } from '@/lib/invoices/catalog';
import { fail, json, requestMeta } from '@/lib/documents/service';
import { readVersionUpload } from '@/lib/documents/version-upload';
import { accessByToken, addVersion } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ token: string }> };

export const dynamic = 'force-dynamic';

/** POST /api/sign/[token]/versions — an editor uploads a new version (sealed in their browser). */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { token } = await params;
  const supabase = serviceClient();
  const access = await accessByToken(supabase, token);
  if (!access.ok) return fail(access.error, access.status);
  if (access.recipient.role !== 'editor') return fail('You were invited to view this document, not to edit it', 403);
  const upload = await readVersionUpload(request);
  if (!upload.ok) return fail(upload.error, upload.status);
  const result = await addVersion(supabase, access.doc, upload.sealed, upload.meta, {
    recipientId: access.recipient.id,
    label: access.recipient.email,
    meta: requestMeta(request),
    byRecipient: true,
  });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data }, 201);
}
