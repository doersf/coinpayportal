/** Constants and pure helpers shared by the server and the browser (no Node imports). */

/**
 * Plaintext ceiling. The ciphertext is 29 bytes larger, and uploads are
 * buffered by the Next proxy, whose default ceiling is 10 MB.
 */
export const MAX_DOCUMENT_BYTES = 9 * 1024 * 1024;
export const SEAL_OVERHEAD = 1 + 12 + 16;

/**
 * What can be uploaded, by extension. The server only ever holds ciphertext,
 * so the type is the uploader's declaration; the recipient's browser renders
 * only the inline types itself and offers everything else as a download.
 */
export const DOCUMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const ALLOWED_CONTENT_TYPES = new Set(Object.values(DOCUMENT_TYPES));

/** Types the page previews itself from the decrypted bytes. */
export const PREVIEW_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']);

export function contentTypeFor(filename: string): string | null {
  return DOCUMENT_TYPES[filename.toLowerCase().split('.').pop() ?? ''] ?? null;
}

/** A filename safe to echo back in headers and emails. */
export function cleanFilename(name: string | null | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, '').trim().slice(0, 200);
  return cleaned || 'document';
}

/** The filename of the signed copy, which is always a PDF. */
export function signedFilename(filename: string): string {
  return `${filename.replace(/\.[A-Za-z0-9]{1,5}$/, '')}-signed.pdf`;
}
