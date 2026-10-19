import type { NextRequest } from 'next/server';
import { MAX_DOCUMENT_BYTES, SEAL_OVERHEAD, versionMetaSchema, zodError } from './service';

/** The multipart body of a new version: `file` (sealed) and `meta` (versionMetaSchema). */
export async function readVersionUpload(request: NextRequest) {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_DOCUMENT_BYTES + 64 * 1024) return { ok: false as const, status: 413, error: `Files must be ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller` };
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false as const, status: 400, error: 'Expected a multipart form with a file' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get('meta') ?? ''));
  } catch {
    return { ok: false as const, status: 400, error: 'The "meta" field must be JSON' };
  }
  const parsed = versionMetaSchema.safeParse(raw);
  if (!parsed.success) return { ok: false as const, status: 400, error: zodError(parsed.error) };
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_DOCUMENT_BYTES + SEAL_OVERHEAD) {
    return { ok: false as const, status: 400, error: 'A sealed file is required in the "file" field' };
  }
  return { ok: true as const, sealed: Buffer.from(await file.arrayBuffer()), meta: parsed.data };
}
