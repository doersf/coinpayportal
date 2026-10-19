import { NextRequest } from 'next/server';
import { z } from 'zod';
import { authorizeDocument } from '@/lib/documents/authorize';
import { fail, json, readJson, requestMeta, zodError } from '@/lib/documents/service';
import { ownerLabel, resendRecipient, revokeRecipient } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ id: string; recipientId: string }> };

const resendSchema = z
  .object({
    send_email: z.boolean().optional(),
    email_document_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  })
  .strict();

/** POST /api/documents/[id]/recipients/[recipientId] — a new link (the old one stops working). */
export async function POST(request: NextRequest, { params }: Ctx) {
  const { id, recipientId } = await params;
  const parsed = resendSchema.safeParse((await readJson(request)) ?? {});
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  if (!z.string().uuid().safeParse(recipientId).success) return fail('Recipient not found', 404);
  const auth = await authorizeDocument(request, id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const result = await resendRecipient(auth.supabase, auth.doc, recipientId, {
    email: parsed.data.send_email !== false,
    documentKey: parsed.data.email_document_key ?? null,
    label: await ownerLabel(auth.supabase, auth.merchantId),
    meta: requestMeta(request),
  });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data });
}

/** DELETE /api/documents/[id]/recipients/[recipientId] — revoke someone who has not signed. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id, recipientId } = await params;
  if (!z.string().uuid().safeParse(recipientId).success) return fail('Recipient not found', 404);
  const auth = await authorizeDocument(request, id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const result = await revokeRecipient(auth.supabase, auth.doc, recipientId, {
    label: await ownerLabel(auth.supabase, auth.merchantId),
    meta: requestMeta(request),
  });
  if (!result.ok) return fail(result.error, result.status);
  return json({ success: true, ...result.data });
}
