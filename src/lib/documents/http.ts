import { NextResponse, type NextRequest } from 'next/server';
import { MAX_DOCUMENT_BYTES, sealedCopyMetaSchema, SEAL_OVERHEAD, zodError } from './service';

/** Sealed bytes as a response. Only a holder of the document key can open them. */
export function sealedResponse(bytes: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** The multipart body of a signed-copy upload: `file` (sealed) and `meta` ({ sha256, bytes }). */
export async function readSealedUpload(
  request: NextRequest
): Promise<{ ok: true; sealed: Buffer; meta: { sha256: string; bytes: number } } | { ok: false; error: string; status: number }> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  // The certificate adds pages, so the signed copy may be somewhat larger than the original.
  const ceiling = 2 * MAX_DOCUMENT_BYTES;
  if (declared > ceiling + 64 * 1024) return { ok: false, error: 'The signed copy is too large', status: 413 };
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, error: 'Expected a multipart form with a file', status: 400 };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get('meta') ?? ''));
  } catch {
    return { ok: false, error: 'The "meta" field must be JSON', status: 400 };
  }
  const parsed = sealedCopyMetaSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: zodError(parsed.error), status: 400 };
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0 || file.size > ceiling + SEAL_OVERHEAD) {
    return { ok: false, error: 'A sealed file is required in the "file" field', status: 400 };
  }
  return { ok: true, sealed: Buffer.from(await file.arrayBuffer()), meta: parsed.data };
}
