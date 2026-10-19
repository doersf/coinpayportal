'use client';

import { isSkippedPath, normalizeFolder } from '@/lib/documents/types';
import type { UploadItem } from '@/lib/documents/client';

/**
 * Turning what the person picked or dropped into files with folder paths.
 * A folder keeps its own name as the top folder, like a desktop copy does.
 */

function folderOf(relativePath: string, base: string | null): string | null {
  const parts = relativePath.split('/');
  parts.pop();
  return normalizeFolder([base ?? '', ...parts].join('/'));
}

/** From an <input type=file> (multiple, or webkitdirectory). */
export function itemsFromInput(files: FileList | File[], base: string | null, includeHidden: boolean): { items: UploadItem[]; skipped: number } {
  const items: UploadItem[] = [];
  let skipped = 0;
  for (const file of Array.from(files)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!includeHidden && isSkippedPath(rel)) {
      skipped++;
      continue;
    }
    items.push({ file, folder: folderOf(rel, base) });
  }
  return { items, skipped };
}

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (e: unknown) => void) => void };
};

async function walk(entry: Entry, out: { file: File; path: string }[]): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail));
    out.push({ file, path: entry.fullPath.replace(/^\//, '') });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns at most ~100 entries per call; keep reading until empty.
    for (;;) {
      const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail));
      if (!batch.length) break;
      for (const child of batch) await walk(child, out);
    }
  }
}

/** From a drop: files and whole folders, recursively. */
export async function itemsFromDrop(data: DataTransfer, base: string | null, includeHidden: boolean): Promise<{ items: UploadItem[]; skipped: number }> {
  const entries = Array.from(data.items)
    .map((i) => (i.kind === 'file' ? (i.webkitGetAsEntry?.() as unknown as Entry | null) : null))
    .filter((e): e is Entry => Boolean(e));
  // Browsers without the entries API fall back to the flat file list.
  if (!entries.length) return itemsFromInput(data.files, base, includeHidden);
  const found: { file: File; path: string }[] = [];
  for (const e of entries) await walk(e, found);
  const items: UploadItem[] = [];
  let skipped = 0;
  for (const { file, path } of found) {
    if (!includeHidden && isSkippedPath(path)) {
      skipped++;
      continue;
    }
    items.push({ file, folder: folderOf(path, base) });
  }
  return { items, skipped };
}
