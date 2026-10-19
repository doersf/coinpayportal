/**
 * Publish a local directory to a business's documents: every file is
 * encrypted on this machine (see documents.js) and filed under the same
 * folder structure. Publishing again syncs: new files are uploaded, changed
 * files become a new version, unchanged ones are skipped, and documents that
 * are already signed are never touched. Nothing remote is ever deleted.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import {
  isSkippedPath,
  listDocuments,
  MAX_DOCUMENT_BYTES,
  normalizeFolder,
  sha256Hex,
  uploadDocument,
  uploadDocumentVersion,
} from './documents.js';

/** Every file under `dir`, with its path relative to `dir` ('/'-separated). Symlinks are not followed. */
export async function walkDirectory(dir, { includeHidden = false } = {}) {
  const root = resolve(dir);
  const out = [];
  let skipped = 0;
  const visit = async (abs) => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const child = join(abs, entry.name);
      const rel = relative(root, child).split(sep).join('/');
      if (!includeHidden && isSkippedPath(rel)) {
        skipped++;
        continue;
      }
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) out.push({ abs: child, rel, size: (await stat(child)).size });
    }
  };
  await visit(root);
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return { files: out, skipped };
}

const key = (folder, filename) => `${folder ?? ''}\u0000${filename}`;

/**
 * Decide what to do with each local file. `remote` is listDocuments() output
 * (newest first, so the first match for a path wins). Pure: no I/O.
 *
 * Actions: upload | version | unchanged | locked (signed, completed, declined
 * or voided remotely) | too_large | empty.
 */
export function planPublish(local, remote) {
  const byPath = new Map();
  for (const d of remote) if (!byPath.has(key(d.folder, d.filename))) byPath.set(key(d.folder, d.filename), d);
  return local.map((f) => {
    if (f.size === 0) return { ...f, action: 'empty' };
    if (f.size > MAX_DOCUMENT_BYTES) return { ...f, action: 'too_large' };
    const existing = byPath.get(key(f.folder, f.filename));
    if (!existing) return { ...f, action: 'upload' };
    if (existing.sha256 === f.sha256) return { ...f, action: 'unchanged', documentId: existing.id };
    const locked = ['completed', 'declined', 'voided'].includes(existing.status) || (existing.signed ?? 0) > 0;
    return { ...f, action: locked ? 'locked' : 'version', documentId: existing.id, status: existing.status };
  });
}

/**
 * Publish `dir`. `folder` is where its contents go: by default a folder named
 * like the directory (as a desktop copy would); pass '' or '/' for the top level.
 */
export async function publishDirectory(client, { businessId, vault, dir, folder, includeHidden = false, dryRun = false, concurrency = 3, onFile } = {}) {
  if (!businessId) throw new Error('businessId is required');
  const prefix = normalizeFolder(folder === undefined ? basename(resolve(dir)) : folder);
  const { files, skipped } = await walkDirectory(dir, { includeHidden });

  const local = [];
  for (const f of files) {
    const parts = f.rel.split('/');
    const filename = parts.pop();
    const entry = { ...f, filename, folder: normalizeFolder([prefix ?? '', ...parts].join('/')) };
    if (f.size > 0 && f.size <= MAX_DOCUMENT_BYTES) entry.sha256 = await sha256Hex(await readFile(f.abs));
    local.push(entry);
  }
  const plan = planPublish(local, await listDocuments(client, { businessId }));
  if (dryRun) return { plan, skippedHidden: skipped, folder: prefix };

  let next = 0;
  const work = plan.filter((p) => p.action === 'upload' || p.action === 'version');
  const worker = async () => {
    while (next < work.length) {
      const p = work[next++];
      try {
        const bytes = await readFile(p.abs);
        if (p.action === 'upload') {
          const doc = await uploadDocument(client, { businessId, vault, bytes, filename: p.filename, folder: p.folder });
          p.documentId = doc.id;
        } else {
          const result = await uploadDocumentVersion(client, p.documentId, { vault, bytes, filename: p.filename, note: 'published from ' + p.rel });
          p.version = result.version;
        }
        p.result = 'ok';
      } catch (err) {
        p.result = 'failed';
        p.error = err.message;
      }
      onFile?.(p);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, worker));
  return { plan, skippedHidden: skipped, folder: prefix };
}
