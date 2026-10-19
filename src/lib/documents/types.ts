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
/** Anything else uploads as an opaque file: it is ciphertext to us, and the page offers it as a download. */
export const GENERIC_CONTENT_TYPE = 'application/octet-stream';
export const ALLOWED_CONTENT_TYPES = new Set([...Object.values(DOCUMENT_TYPES), GENERIC_CONTENT_TYPE]);

/** Types the page previews itself from the decrypted bytes. */
export const PREVIEW_TYPES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'text/csv']);

export function contentTypeFor(filename: string): string {
  const ext = filename.includes('.') ? filename.toLowerCase().split('.').pop() ?? '' : '';
  return DOCUMENT_TYPES[ext] ?? GENERIC_CONTENT_TYPE;
}

export const MAX_FOLDER_DEPTH = 20;

/**
 * A folder path as stored: segments joined by '/', trimmed, no empty, '.' or
 * '..' segments, no leading or trailing slash. Null means the top level.
 * Throws on '..' rather than silently collapsing it.
 */
export function normalizeFolder(input: string | null | undefined): string | null {
  if (input == null) return null;
  const segments = String(input)
    .split(/[\\/]+/)
    // eslint-disable-next-line no-control-regex
    .map((s) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim())
    .filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) throw new Error('Folder paths cannot contain ".."');
  if (segments.length > MAX_FOLDER_DEPTH) throw new Error(`Folders can be at most ${MAX_FOLDER_DEPTH} levels deep`);
  const joined = segments.map((s) => s.slice(0, 100)).join('/');
  if (joined.length > 1000) throw new Error('Folder path is too long');
  return joined || null;
}

/** Files a folder upload skips unless asked: hidden files and directories, and dependency trees. */
export function isSkippedPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]+/).some((s) => (s.startsWith('.') && s !== '.' && s !== '..') || s === 'node_modules' || s === 'Thumbs.db' || s === 'desktop.ini');
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
