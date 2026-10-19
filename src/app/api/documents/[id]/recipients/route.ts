import { NextRequest } from 'next/server';
import { authorizeDocument } from '@/lib/documents/authorize';
import { fail, json, readJson, requestMeta, shareSchema, zodError } from '@/lib/documents/service';
import { ownerLabel, shareDocument } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/documents/[id]/recipients
 * { recipients: [{ name, email, role: 'signer'|'viewer', expires_in_days? }], message?, send_email?, email_document_key? }
 *
 * Returns each recipient's link WITHOUT the key; the sender's browser adds
 * `#k=<document key>` before showing or copying it.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const parsed = shareSchema.safeParse(body);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const auth = await authorizeDocument(request, id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const result = await shareDocument(auth.supabase, auth.doc, parsed.data, {
    label: await ownerLabel(auth.supabase, auth.merchantId),
    meta: requestMeta(request),
  });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data }, 201);
}
