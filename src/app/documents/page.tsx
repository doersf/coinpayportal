'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/auth/client';
import { uploadMany, type UploadItem, type UploadStatus } from '@/lib/documents/client';
import { MAX_DOCUMENT_BYTES, normalizeFolder } from '@/lib/documents/types';
import { itemsFromDrop, itemsFromInput } from './pick';
import { Badge, button, card, day, docStatusLabel, docTone, ErrorBox, fileSize, ghost, input, Spinner, VaultGate } from './ui';

interface Business { id: string; name: string }
interface DocumentItem {
  id: string; title: string; folder: string | null; filename: string; bytes: number; status: string; created_at: string;
  completed_at: string | null; signers: number; signed: number; viewers: number;
}
interface FolderNode { name: string; path: string; folders: Map<string, FolderNode>; docs: DocumentItem[]; total: number }

function buildTree(docs: DocumentItem[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: new Map(), docs: [], total: 0 };
  for (const d of docs) {
    let node = root;
    node.total++;
    for (const part of d.folder ? d.folder.split('/') : []) {
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path, folders: new Map(), docs: [], total: 0 });
      node = node.folders.get(part)!;
      node.total++;
    }
    node.docs.push(d);
  }
  return root;
}

function allFolderPaths(node: FolderNode, out: string[] = []): string[] {
  for (const f of node.folders.values()) {
    out.push(f.path);
    allFolderPaths(f, out);
  }
  return out;
}

type Job = { item: UploadItem; status: UploadStatus };

export default function DocumentsPage() {
  const router = useRouter();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [target, setTarget] = useState('');
  const [includeHidden, setIncludeHidden] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [skippedHidden, setSkippedHidden] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement | null>(null);
  // webkitdirectory is not in React's typings, and this input only mounts once
  // the vault is unlocked (inside VaultGate), so set it as the node attaches.
  const folderPicker = useCallback((node: HTMLInputElement | null) => {
    folderInput.current = node;
    node?.setAttribute('webkitdirectory', '');
    node?.setAttribute('directory', '');
  }, []);

  useEffect(() => {
    (async () => {
      const result = await authFetch('/api/businesses', {}, router);
      if (result?.data.success && result.data.businesses.length > 0) {
        setBusinesses(result.data.businesses);
        const wanted = new URLSearchParams(window.location.search).get('business_id');
        const match = result.data.businesses.find((b: Business) => b.id === wanted);
        setBusinessId(match?.id ?? result.data.businesses[0].id);
      }
      setLoading(false);
    })();
  }, [router]);

  const load = useCallback(async () => {
    if (!businessId) return;
    const result = await authFetch(`/api/documents?business_id=${businessId}`, {}, router);
    setDocuments(result?.data.success ? result.data.documents : []);
  }, [businessId, router]);
  useEffect(() => { load(); }, [load]);

  const start = async (picked: { items: UploadItem[]; skipped: number }) => {
    setError('');
    setSkippedHidden(picked.skipped);
    if (!picked.items.length) return setError(picked.skipped ? 'Everything you picked was a hidden file or dependency folder.' : 'Nothing to upload.');
    setJobs(picked.items.map((item) => ({ item, status: { state: 'queued' } })));
    setUploading(true);
    await uploadMany(businessId, picked.items, (i, status) =>
      setJobs((prev) => prev.map((j, k) => (k === i ? { ...j, status } : j)))
    );
    setUploading(false);
    // Show where the files went.
    const folders = new Set<string>();
    for (const it of picked.items) {
      const parts = it.folder ? it.folder.split('/') : [];
      parts.forEach((_, n) => folders.add(parts.slice(0, n + 1).join('/')));
    }
    setOpen((o) => new Set([...o, ...folders]));
    await load();
  };

  const base = (): string | null => {
    try {
      return normalizeFolder(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid folder');
      throw err;
    }
  };

  const onPick = (files: FileList | null) => {
    if (!files?.length) return;
    let b: string | null;
    try { b = base(); } catch { return; }
    start(itemsFromInput(files, b, includeHidden));
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    let b: string | null;
    try { b = base(); } catch { return; }
    start(await itemsFromDrop(e.dataTransfer, b, includeHidden));
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return documents;
    return documents.filter((d) => `${d.folder ?? ''}/${d.title} ${d.filename}`.toLowerCase().includes(q));
  }, [documents, search]);
  const tree = useMemo(() => buildTree(filtered), [filtered]);
  const searching = search.trim().length > 0;
  const isOpen = (path: string) => searching || open.has(path);
  const toggle = (path: string) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });

  if (loading) return <Spinner />;

  const done = jobs.filter((j) => j.status.state === 'done').length;
  const failed = jobs.filter((j) => j.status.state === 'failed');
  const skipped = jobs.filter((j) => j.status.state === 'skipped');

  const renderFolder = (node: FolderNode, depth: number): React.ReactNode => (
    <>
      {[...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((f) => (
        <li key={`f:${f.path}`}>
          <div className="flex items-center justify-between gap-2 rounded-lg hover:bg-gray-800/60 pr-2" style={{ paddingLeft: depth * 18 }}>
            <button type="button" onClick={() => toggle(f.path)} aria-expanded={isOpen(f.path)} className="flex-1 text-left py-2 flex items-center gap-2 text-gray-100">
              <span className="w-4 text-gray-400">{isOpen(f.path) ? '▾' : '▸'}</span>
              <span aria-hidden>📁</span>
              <span className="font-medium">{f.name}</span>
              <span className="text-xs text-gray-500">{f.total}</span>
            </button>
            <button type="button" onClick={() => setTarget(f.path)} className="text-xs text-purple-400 hover:text-purple-300" title="Upload into this folder">Upload here</button>
          </div>
          {isOpen(f.path) && <ul>{renderFolder(f, depth + 1)}</ul>}
        </li>
      ))}
      {[...node.docs].sort((a, b) => a.title.localeCompare(b.title)).map((d) => (
        <li key={d.id}>
          <Link href={`/documents/${d.id}`} className="py-2 pr-2 flex flex-wrap items-center justify-between gap-3 hover:bg-gray-800/60 rounded-lg" style={{ paddingLeft: depth * 18 + 24 }}>
            <div className="min-w-0">
              <p className="text-white truncate">{d.title}</p>
              <p className="text-xs text-gray-500">{d.filename} · {fileSize(d.bytes)} · {day(d.created_at)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {d.signers > 0 && <span className="text-xs text-gray-400">{d.signed}/{d.signers} signed</span>}
              <Badge status={docTone[d.status] ?? 'draft'} label={docStatusLabel[d.status] ?? d.status} />
            </div>
          </Link>
        </li>
      ))}
    </>
  );

  return (
    <div className="min-h-screen bg-gray-900 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Documents</h1>
            <p className="mt-2 text-gray-400 max-w-2xl">
              Upload files or whole folders, share them by private link, and collect e-signatures. Everything is end-to-end
              encrypted in your browser: CoinPay cannot read your documents.
            </p>
          </div>
          {businesses.length > 1 && (
            <select aria-label="Business" value={businessId} onChange={(e) => setBusinessId(e.target.value)} className="px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white">
              {businesses.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          )}
        </div>

        {businesses.length === 0 && (
          <div className={card}>
            <p className="text-gray-300">Create a business first; documents belong to a business.</p>
            <Link href="/businesses" className={`${button} inline-block mt-4`}>Create a business</Link>
          </div>
        )}

        {businessId && (
          <VaultGate businessId={businessId}>
            <section
              className={`${card} space-y-3 ${dragging ? 'ring-2 ring-purple-400' : ''}`}
              onDragOver={(e) => { e.preventDefault(); if (!uploading) setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm text-gray-300 flex-1 min-w-[14rem]">
                  Into folder
                  <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="top level (or e.g. contracts/2026)" className={`${input} mt-1`} />
                </label>
                <button type="button" disabled={uploading} onClick={() => filesInput.current?.click()} className={button}>Choose files</button>
                <button type="button" disabled={uploading} onClick={() => folderInput.current?.click()} className={ghost}>Choose folder</button>
                <input ref={filesInput} type="file" multiple hidden onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
                <input ref={folderPicker} type="file" multiple hidden onChange={(e) => { onPick(e.target.files); e.target.value = ''; }} />
              </div>
              <div className="border-2 border-dashed border-gray-600 rounded-xl py-6 text-center text-sm text-gray-400">
                {uploading ? `Encrypting and uploading… ${done}/${jobs.length}` : 'Or drop files and folders here. Folders keep their structure.'}
              </div>
              <label className="flex items-center gap-2 text-xs text-gray-400">
                <input type="checkbox" checked={includeHidden} onChange={(e) => setIncludeHidden(e.target.checked)} />
                Include hidden files (.git, .DS_Store) and node_modules
              </label>
              <p className="text-xs text-gray-500">
                Any file type, up to {MAX_DOCUMENT_BYTES / (1024 * 1024)} MB each. Each file is encrypted with its own key before it leaves
                this browser. Folder and file names are not encrypted, because they appear in the emails CoinPay sends.
              </p>

              {jobs.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-gray-300">
                    {done} uploaded{skipped.length ? ` · ${skipped.length} skipped` : ''}{failed.length ? ` · ${failed.length} failed` : ''}
                    {skippedHidden ? ` · ${skippedHidden} hidden files left out` : ''}
                  </p>
                  {(failed.length > 0 || skipped.length > 0 || uploading) && (
                    <ul className="max-h-48 overflow-auto text-xs space-y-0.5 bg-gray-950 rounded-lg p-2">
                      {jobs.filter((j) => j.status.state !== 'done').map((j, i) => (
                        <li key={i} className={j.status.state === 'failed' ? 'text-red-400' : 'text-gray-400'}>
                          {j.item.folder ? `${j.item.folder}/` : ''}{j.item.file.name} — {j.status.state}{j.status.note ? `: ${j.status.note}` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>

            <ErrorBox message={error} />

            <section className={card}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search documents and folders" className={`${input} max-w-sm`} />
                <div className="flex gap-2 text-xs">
                  <button type="button" onClick={() => setOpen(new Set(allFolderPaths(tree)))} className="text-purple-400 hover:text-purple-300">Expand all</button>
                  <button type="button" onClick={() => setOpen(new Set())} className="text-purple-400 hover:text-purple-300">Collapse all</button>
                </div>
              </div>
              {documents.length === 0 ? (
                <p className="text-gray-400">No documents yet. Upload files or a folder above, then share them or send them for signature.</p>
              ) : filtered.length === 0 ? (
                <p className="text-gray-400">Nothing matches “{search}”.</p>
              ) : (
                <ul>{renderFolder(tree, 0)}</ul>
              )}
            </section>
          </VaultGate>
        )}
      </div>
    </div>
  );
}
