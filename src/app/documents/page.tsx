'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/auth/client';
import { uploadDocument } from '@/lib/documents/client';
import { contentTypeFor, DOCUMENT_TYPES, MAX_DOCUMENT_BYTES } from '@/lib/documents/types';
import { Badge, button, card, day, docStatusLabel, docTone, ErrorBox, fileSize, input, Spinner, VaultGate } from './ui';

interface Business { id: string; name: string }
interface DocumentItem {
  id: string; title: string; filename: string; bytes: number; status: string; created_at: string; completed_at: string | null;
  signers: number; signed: number; viewers: number;
}

const ACCEPT = Object.keys(DOCUMENT_TYPES).map((e) => `.${e}`).join(',');

export default function DocumentsPage() {
  const router = useRouter();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [businessId, setBusinessId] = useState('');
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

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

  const pick = (f: File | null) => {
    setError('');
    setFile(f);
    if (f && !title) setTitle(f.name.replace(/\.[A-Za-z0-9]{1,5}$/, ''));
  };

  const upload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const contentType = contentTypeFor(file.name);
    if (!contentType) return setError('Upload a PDF, PNG, JPEG, Word, Excel, PowerPoint, text or CSV file');
    if (file.size > MAX_DOCUMENT_BYTES) return setError(`Files must be ${MAX_DOCUMENT_BYTES / (1024 * 1024)} MB or smaller`);
    setBusy(true);
    setError('');
    try {
      const { id } = await uploadDocument(businessId, file, { title: title.trim() || file.name, message: null, contentType });
      router.push(`/documents/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setBusy(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <div className="min-h-screen bg-gray-900 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Documents</h1>
            <p className="mt-2 text-gray-400 max-w-2xl">
              Upload contracts and files, share them by private link, and collect legally binding e-signatures.
              Everything is end-to-end encrypted in your browser: CoinPay cannot read your documents.
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
            <form onSubmit={upload} className={`${card} grid grid-cols-1 sm:grid-cols-5 gap-3 items-end`}>
              <label className="text-sm text-gray-300 sm:col-span-2">
                File *
                <input required type="file" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0] ?? null)} className={`${input} mt-1 file:mr-3 file:rounded file:border-0 file:bg-gray-600 file:text-white file:px-2 file:py-1`} />
              </label>
              <label className="text-sm text-gray-300 sm:col-span-2">
                Title
                <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className={`${input} mt-1`} />
              </label>
              <button disabled={busy || !file} className={button}>{busy ? 'Encrypting…' : 'Upload'}</button>
              <p className="sm:col-span-5 text-xs text-gray-500">
                PDF, images, Office files, text or CSV up to {MAX_DOCUMENT_BYTES / (1024 * 1024)} MB. The file is encrypted before it leaves
                this browser. The title and filename are not encrypted, because they appear in the emails CoinPay sends.
              </p>
            </form>

            <ErrorBox message={error} />

            <section className={card}>
              {documents.length === 0 ? (
                <p className="text-gray-400">No documents yet. Upload one above, then share it or send it for signature.</p>
              ) : (
                <ul className="divide-y divide-gray-700">
                  {documents.map((d) => (
                    <li key={d.id}>
                      <Link href={`/documents/${d.id}`} className="py-3 flex flex-wrap items-center justify-between gap-3 hover:bg-gray-800/60 rounded-lg px-2 -mx-2">
                        <div className="min-w-0">
                          <p className="text-white font-medium truncate">{d.title}</p>
                          <p className="text-xs text-gray-500">{d.filename} · {fileSize(d.bytes)} · {day(d.created_at)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {d.signers > 0 && <span className="text-xs text-gray-400">{d.signed}/{d.signers} signed</span>}
                          {d.viewers > 0 && <span className="text-xs text-gray-400">{d.viewers} viewer{d.viewers === 1 ? '' : 's'}</span>}
                          <Badge status={docTone[d.status] ?? 'draft'} label={docStatusLabel[d.status] ?? d.status} />
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </VaultGate>
        )}
      </div>
    </div>
  );
}
