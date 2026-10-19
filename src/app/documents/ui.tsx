'use client';

import { useEffect, useRef, useState } from 'react';
import { button, card, ErrorBox, ghost, input } from '@/app/contractors/ui';
import { contentTypeFor, MAX_DOCUMENT_BYTES, PREVIEW_TYPES } from '@/lib/documents/types';
import { loadVaults, setupVault, unlock, vaultUnlocked } from '@/lib/documents/client';
import type { VaultRecord } from '@/lib/documents/e2e';

/** Shared bits for the document pages (business side and the signing page). */

export { Badge, button, card, day, ErrorBox, ghost, input, Spinner } from '@/app/contractors/ui';

export const docStatusLabel: Record<string, string> = {
  draft: 'draft',
  shared: 'shared',
  out_for_signature: 'awaiting signatures',
  completed: 'completed',
  declined: 'declined',
  voided: 'voided',
};

/** Maps document statuses onto the shared Badge tones. */
export const docTone: Record<string, string> = {
  draft: 'draft',
  shared: 'sent',
  out_for_signature: 'processing',
  completed: 'paid',
  declined: 'rejected',
  voided: 'ended',
  pending: 'pending',
  viewed: 'sent',
  signed: 'paid',
};

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decrypted bytes shown in the page from a blob: URL; nothing leaves the browser. */
export function Preview({ bytes, contentType, title }: { bytes: Uint8Array; contentType: string; title: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (contentType.startsWith('text/')) {
      setText(new TextDecoder().decode(bytes));
      return;
    }
    if (!PREVIEW_TYPES.has(contentType)) return;
    const u = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, contentType]);

  if (text !== null) {
    return <pre className="bg-gray-950 border border-gray-700 rounded-lg p-4 text-sm text-gray-200 whitespace-pre-wrap max-h-[70vh] overflow-auto">{text}</pre>;
  }
  if (!PREVIEW_TYPES.has(contentType)) {
    return <p className="text-gray-400 text-sm">This file type cannot be previewed here. Download it to read it before you sign.</p>;
  }
  if (!url) return null;
  if (contentType === 'application/pdf') {
    return <iframe title={title} src={url} className="w-full h-[75vh] rounded-lg border border-gray-700 bg-white" />;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={title} className="max-w-full rounded-lg border border-gray-700 bg-white mx-auto" />;
}

/** A drawn signature. Returns a PNG data URL, or null while the pad is empty. */
export function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext('2d')!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111827';
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = e.currentTarget.getContext('2d')!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d')!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    dirty.current = true;
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (dirty.current && canvas.current) onChange(canvas.current.toDataURL('image/png'));
  };
  const clear = () => {
    const c = canvas.current;
    if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    dirty.current = false;
    onChange(null);
  };

  return (
    <div>
      <canvas
        ref={canvas}
        aria-label="Draw your signature"
        className="w-full h-32 bg-white rounded-lg touch-none cursor-crosshair"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      />
      <button type="button" onClick={clear} className="text-xs text-gray-400 hover:text-gray-200 mt-1">Clear drawing</button>
    </div>
  );
}

/**
 * Unlock (or set up) the business's documents vault before anything else on
 * the page. The passphrase never leaves this browser.
 */
export function VaultGate({ businessId, children }: { businessId: string; children: React.ReactNode }) {
  const [vaults, setVaults] = useState<VaultRecord[] | null>(null);
  const [open, setOpen] = useState(vaultUnlocked(businessId));
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOpen(vaultUnlocked(businessId));
    setVaults(null);
    loadVaults(businessId).then(setVaults, (e) => setError(e.message));
  }, [businessId]);

  if (open) return <>{children}</>;
  if (!vaults) return <ErrorBox message={error} />;

  const first = vaults.length === 0;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (first && passphrase !== confirm) return setError('The passphrases do not match');
    if (first && passphrase.length < 10) return setError('Use at least 10 characters');
    setBusy(true);
    try {
      if (first) await setupVault(businessId, passphrase);
      else await unlock(businessId, vaults, passphrase);
      setPassphrase('');
      setConfirm('');
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={`${card} max-w-xl space-y-4`}>
      <div>
        <h2 className="text-lg font-semibold text-white">{first ? 'Set a documents passphrase' : 'Unlock documents'}</h2>
        <p className="text-sm text-gray-400 mt-1">
          Documents are end-to-end encrypted in your browser. CoinPay stores only ciphertext and cannot read them.
          {first
            ? ' Choose a passphrase and share it only with teammates who should see documents. If it is lost, nobody (including CoinPay) can recover the documents.'
            : ' Enter the documents passphrase for this business.'}
        </p>
      </div>
      <ErrorBox message={error} />
      <label className="block text-sm text-gray-300">
        Passphrase
        <input type="password" autoComplete={first ? 'new-password' : 'current-password'} required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className={`${input} mt-1`} />
      </label>
      {first && (
        <label className="block text-sm text-gray-300">
          Confirm passphrase
          <input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} className={`${input} mt-1`} />
        </label>
      )}
      <div className="flex gap-2">
        <button disabled={busy} className={button}>{busy ? 'Working…' : first ? 'Create vault' : 'Unlock'}</button>
        {!first && <span className="text-xs text-gray-500 self-center">Forgot it? An older passphrase also works if it was changed.</span>}
      </div>
    </form>
  );
}


export interface DocVersion {
  version: number;
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  note: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export const roleLabel: Record<string, string> = { signer: 'Needs to sign', viewer: 'Can view', editor: 'Can edit' };

/** Every version of the document, newest first, each downloadable (decrypted here). */
export function VersionHistory({
  versions,
  current,
  onDownload,
}: {
  versions: DocVersion[];
  current: number;
  onDownload: (v: DocVersion) => void;
}) {
  if (versions.length === 0) return null;
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold text-white mb-3">History</h2>
      <ul className="divide-y divide-gray-700">
        {versions.map((v) => (
          <li key={v.version} className="py-2 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-white text-sm">
                Version {v.version}
                {v.version === current ? <span className="ml-2 text-xs text-green-300">current</span> : null}
                <span className="text-gray-400"> · {v.filename} · {fileSize(v.bytes)}</span>
              </p>
              <p className="text-xs text-gray-500">
                {new Date(v.created_at).toLocaleString()}
                {v.uploaded_by ? ` · ${v.uploaded_by}` : ''}
                {v.note ? ` · ${v.note}` : ''}
              </p>
            </div>
            <button onClick={() => onDownload(v)} className={ghost}>Download</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Upload the next version; it is sealed in this browser before it leaves. */
export function NewVersionForm({ onUpload }: { onUpload: (file: File, contentType: string, note: string | null) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const contentType = contentTypeFor(file.name);
    if (!contentType) return setError('Upload a PDF, PNG, JPEG, Word, Excel, PowerPoint, text or CSV file');
    if (file.size > MAX_DOCUMENT_BYTES) return setError(`Files must be ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller`);
    setBusy(true);
    setError('');
    try {
      await onUpload(file, contentType, note.trim() || null);
      setFile(null);
      setNote('');
      (e.target as HTMLFormElement).reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className={`${card} space-y-3`}>
      <h2 className="text-lg font-semibold text-white">Upload a new version</h2>
      <p className="text-xs text-gray-500">Earlier versions stay in the history. Once anyone signs, the document can no longer change.</p>
      <ErrorBox message={error} />
      <div className="grid grid-cols-1 sm:grid-cols-5 gap-2 items-end">
        <input required type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className={`${input} sm:col-span-2`} />
        <input placeholder="What changed (optional)" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} className={`${input} sm:col-span-2`} />
        <button disabled={busy || !file} className={button}>{busy ? 'Encrypting…' : 'Upload version'}</button>
      </div>
    </form>
  );
}
