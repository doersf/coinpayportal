import { NextRequest } from 'next/server';
import { authorizeCatalog } from '@/lib/invoices/catalog';
import { deleteObject, putObject } from '@/lib/finances/files';
import {
  cleanFilename,
  DOCUMENT_COLUMNS,
  fail,
  json,
  MAX_DOCUMENT_BYTES,
  recordEvent,
  requestMeta,
  SEAL_OVERHEAD,
  uploadMetaSchema,
  zodError,
} from '@/lib/documents/service';
import { ownerLabel } from '@/lib/documents/workflow';

export const dynamic = 'force-dynamic';

/** GET /api/documents?business_id=&status= — newest first, with recipient progress. */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const auth = await authorizeCatalog(request, params.get('business_id'), 'business.read');
  if (!auth.ok) return auth.response;
  let query = auth.supabase
    .from('documents')
    .select(`${DOCUMENT_COLUMNS}, document_recipients (role, status, revoked_at)`)
    .eq('business_id', auth.businessId)
    .order('created_at', { ascending: false })
    .limit(500);
  const status = params.get('status');
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return fail('Failed to load documents', 500);

  const documents = ((data ?? []) as unknown as (Record<string, unknown> & {
    document_recipients: { role: string; status: string; revoked_at: string | null }[];
  })[]).map(({ document_recipients, ...doc }) => {
    const live = document_recipients.filter((r) => !r.revoked_at);
    const signers = live.filter((r) => r.role === 'signer');
    return {
      ...doc,
      signers: signers.length,
      signed: signers.filter((r) => r.status === 'signed').length,
      viewers: live.length - signers.length,
    };
  });
  return json({ success: true, documents });
}

/**
 * POST /api/documents — upload an end-to-end encrypted document.
 *
 * Multipart form: `file` (the sealed bytes from src/lib/documents/e2e.ts) and
 * `meta` (JSON: id, business_id, title, message?, filename, content_type,
 * bytes, sha256, wrapped_key, vault_version). The id is chosen by the browser
 * because it is bound into the ciphertext.
 */
export async function POST(request: NextRequest) {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_DOCUMENT_BYTES + 64 * 1024) return fail(`Files must be ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller`, 413);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('Expected a multipart form with a file', 400);
  }
  let rawMeta: unknown;
  try {
    rawMeta = JSON.parse(String(form.get('meta') ?? ''));
  } catch {
    return fail('The "meta" field must be JSON', 400);
  }
  const parsed = uploadMetaSchema.safeParse(rawMeta);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const meta = parsed.data;
  const auth = await authorizeCatalog(request, meta.business_id, 'invoice.write');
  if (!auth.ok) return auth.response;

  const { data: vault } = await auth.supabase
    .from('document_vaults')
    .select('version')
    .eq('business_id', auth.businessId)
    .eq('version', meta.vault_version)
    .maybeSingle();
  if (!vault) return fail('Set up the documents passphrase first', 409);

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) return fail('A file is required in the "file" field', 400);
  const sealed = Buffer.from(await file.arrayBuffer());
  if (sealed.length !== meta.bytes + SEAL_OVERHEAD || sealed[0] !== 0x01) {
    return fail('The file must be sealed in the browser before upload', 400);
  }

  const filename = cleanFilename(meta.filename);
  const stored = await putObject('signing', auth.businessId, sealed);
  const { data, error } = await auth.supabase
    .from('documents')
    .insert({
      id: meta.id,
      business_id: auth.businessId,
      title: meta.title,
      message: meta.message ?? null,
      filename,
      content_type: meta.content_type,
      bytes: meta.bytes,
      sha256: meta.sha256,
      wrapped_key: meta.wrapped_key,
      vault_version: meta.vault_version,
      object_key: stored.objectKey,
      created_by: auth.merchantId,
    })
    .select(DOCUMENT_COLUMNS)
    .single();
  if (error || !data) {
    await deleteObject(stored.objectKey).catch(() => undefined);
    return fail(error?.code === '23505' ? 'A document with that id already exists' : 'Failed to save the document', error?.code === '23505' ? 409 : 500);
  }

  await recordEvent(auth.supabase, { id: meta.id, business_id: auth.businessId }, 'uploaded', {
    actor: 'owner',
    label: await ownerLabel(auth.supabase, auth.merchantId),
    meta: requestMeta(request),
    detail: { filename, bytes: meta.bytes, sha256: meta.sha256 },
  });
  return json({ success: true, document: data }, 201);
}
