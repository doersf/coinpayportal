import { NextRequest } from 'next/server';
import { authorizeDocument } from '@/lib/documents/authorize';
import {
  DOCUMENT_COLUMNS,
  documentPatchSchema,
  EVENT_COLUMNS,
  fail,
  json,
  normalizeFolder,
  readJson,
  recordEvent,
  RECIPIENT_COLUMNS,
  requestMeta,
  zodError,
} from '@/lib/documents/service';
import { certificateData, deleteDocument, listVersions, ownerLabel, voidDocument } from '@/lib/documents/workflow';

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/documents/[id] — the document, who has it, and the audit trail. */
export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const auth = await authorizeDocument(request, id, 'business.read');
  if (!auth.ok) return auth.response;
  const [document, recipients, events] = await Promise.all([
    auth.supabase.from('documents').select(DOCUMENT_COLUMNS).eq('id', id).single(),
    auth.supabase.from('document_recipients').select(RECIPIENT_COLUMNS).eq('document_id', id).order('created_at'),
    auth.supabase.from('document_events').select(EVENT_COLUMNS).eq('document_id', id).order('id'),
  ]);
  return json({
    success: true,
    document: { ...(document.data as unknown as Record<string, unknown>), signed_available: Boolean(auth.doc.signed_object_key) },
    recipients: recipients.data ?? [],
    events: events.data ?? [],
    versions: await listVersions(auth.supabase, id),
    certificate: auth.doc.status === 'completed' ? await certificateData(auth.supabase, auth.doc) : null,
  });
}

/** PATCH /api/documents/[id] { action: 'rename', title } | { action: 'void', reason? } | { action: 'move', folder } */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const parsed = documentPatchSchema.safeParse(body);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const auth = await authorizeDocument(request, id, 'invoice.write');
  if (!auth.ok) return auth.response;
  const actor = { label: await ownerLabel(auth.supabase, auth.merchantId), meta: requestMeta(request) };

  if (parsed.data.action === 'void') {
    const result = await voidDocument(auth.supabase, auth.doc, parsed.data.reason, actor);
    if (!result.ok) return fail(result.error, result.status);
    return json({ success: true });
  }
  if (parsed.data.action === 'move') {
    let folder: string | null;
    try {
      folder = normalizeFolder(parsed.data.folder);
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Invalid folder', 400);
    }
    // Filing a signed document elsewhere does not change what was signed, so any status may move.
    await auth.supabase.from('documents').update({ folder, updated_at: new Date().toISOString() }).eq('id', id);
    await recordEvent(auth.supabase, auth.doc, 'moved', { actor: 'owner', ...actor, detail: { to: folder } });
    return json({ success: true, folder });
  }
  if (auth.doc.status === 'completed') return fail('A completed document keeps the title it was signed under', 409);
  await auth.supabase.from('documents').update({ title: parsed.data.title, updated_at: new Date().toISOString() }).eq('id', id);
  await recordEvent(auth.supabase, auth.doc, 'renamed', { actor: 'owner', ...actor, detail: { from: auth.doc.title, to: parsed.data.title } });
  return json({ success: true });
}

/**
 * DELETE /api/documents/[id] — remove it and its files. A completed document
 * is a signed record, so deleting one needs business.update (admin).
 */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const probe = await authorizeDocument(request, id, 'invoice.write');
  if (!probe.ok) return probe.response;
  if (probe.doc.status === 'completed') {
    const admin = await authorizeDocument(request, id, 'business.update');
    if (!admin.ok) return fail('Only an admin can delete a signed document', 403);
  }
  await deleteDocument(probe.supabase, probe.doc);
  return json({ success: true });
}
