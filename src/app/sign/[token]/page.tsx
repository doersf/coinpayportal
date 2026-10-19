'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { fetchAndOpen, saveBytes, sealSignedCopy } from '@/lib/documents/client';
import { keyFromFragment, sha256Hex } from '@/lib/documents/e2e';
import { signedFilename } from '@/lib/documents/types';
import type { CertificateInput } from '@/lib/documents/certificate';
import { Badge, button, card, day, docTone, ErrorBox, fileSize, ghost, input, Preview, SignaturePad, Spinner } from '@/app/documents/ui';

interface View {
  business: { name: string };
  document: {
    id: string; business_id: string; title: string; message: string | null; filename: string; content_type: string; bytes: number;
    sha256: string; status: string; created_at: string; completed_at: string | null; signed_available: boolean; signed_sha256: string | null;
  };
  recipient: { name: string; email: string; role: 'signer' | 'viewer'; status: string; signed_at: string | null; signature_name: string | null };
  signers: { name: string; status: string; signed_at: string | null; you: boolean }[];
  certificate: (Omit<CertificateInput, 'document' | 'original' | 'businessName' | 'completedAt'> & { business_name: string; completed_at: string }) | null;
}

export default function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [view, setView] = useState<View | null>(null);
  const [gone, setGone] = useState('');
  const [key, setKey] = useState<Uint8Array | null>(null);
  const [needKey, setNeedKey] = useState(false);
  const [pasted, setPasted] = useState('');
  const [plain, setPlain] = useState<Uint8Array | null>(null);
  const [hash, setHash] = useState('');
  const [name, setName] = useState('');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [sealing, setSealing] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/sign/${token}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({ success: false, error: 'Something went wrong' }));
    if (!data.success) {
      if (res.status === 404 || res.status === 410) setGone(data.error);
      else setError(data.error);
      return;
    }
    setView(data);
    setName((n) => n || data.recipient.name);
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // The key is in the link fragment, which the browser never sent to the server.
  useEffect(() => {
    const k = keyFromFragment(window.location.hash);
    if (k) setKey(k);
    else setNeedKey(true);
  }, []);

  useEffect(() => {
    if (!view || !key) return;
    (async () => {
      try {
        const bytes = await fetchAndOpen(`/api/sign/${token}/file`, key, view.document, 'original');
        setPlain(bytes);
        setHash(await sha256Hex(bytes));
        setNeedKey(false);
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the document');
        setNeedKey(true);
      }
    })();
  }, [view?.document.id, key, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Everyone has signed and nobody has sealed the signed copy yet: this browser can.
  useEffect(() => {
    if (!view?.certificate || view.document.signed_available || !key || !plain || sealing) return;
    setSealing(true);
    const c = view.certificate;
    sealSignedCopy(`/api/sign/${token}/file`, key, {
      document: view.document,
      businessName: c.business_name,
      original: plain,
      signers: c.signers,
      events: c.events,
      completedAt: c.completed_at,
    })
      .then(load)
      .catch(() => undefined)
      .finally(() => setSealing(false));
  }, [view, key, plain, sealing, token, load]);

  const usePasted = () => {
    const k = keyFromFragment(pasted.includes('#') ? pasted.slice(pasted.indexOf('#')) : `k=${pasted.trim()}`);
    if (!k) return setError('That is not a full document link. It should end with #k= followed by the key.');
    setError('');
    setKey(k);
  };

  const act = async (body: Record<string, unknown>, done: string) => {
    setError('');
    setNotice('');
    setBusy(true);
    const res = await fetch(`/api/sign/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ success: false, error: 'Something went wrong' }));
    setBusy(false);
    if (!data.success) return setError(data.error || 'Something went wrong');
    setNotice(done);
    await load();
  };

  const sign = (e: React.FormEvent) => {
    e.preventDefault();
    act({ action: 'sign', signature_name: name.trim(), signature_image: drawn, document_sha256: hash, consent }, 'Signed. Thank you.');
  };

  const downloadSigned = async () => {
    if (!view || !key) return;
    try {
      const bytes = await fetchAndOpen(`/api/sign/${token}/file?version=signed&download=1`, key, view.document, 'signed');
      saveBytes(bytes, signedFilename(view.document.filename), 'application/pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  if (gone) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
        <div className={`${card} max-w-md text-center`}>
          <h1 className="text-xl text-white font-semibold">This link no longer works</h1>
          <p className="text-gray-400 mt-2">{gone}. Ask the sender for a new link.</p>
        </div>
      </div>
    );
  }
  if (!view) return error ? <div className="p-8"><ErrorBox message={error} /></div> : <Spinner />;

  const { document: doc, recipient } = view;
  const canSign = recipient.role === 'signer' && ['pending', 'viewed'].includes(recipient.status) && doc.status === 'out_for_signature';

  return (
    <div className="min-h-screen bg-gray-900 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <p className="text-sm text-gray-400">{view.business.name} {recipient.role === 'signer' ? 'asked you to sign' : 'shared with you'}</p>
          <h1 className="text-2xl font-bold text-white break-words">{doc.title}</h1>
          <p className="text-xs text-gray-500 mt-1">{doc.filename} · {fileSize(doc.bytes)} · end-to-end encrypted</p>
          {doc.message && <p className="mt-3 text-gray-300 whitespace-pre-wrap">{doc.message}</p>}
        </div>

        <ErrorBox message={error} />
        {notice && <div className="bg-green-500/10 border border-green-500/30 text-green-300 px-4 py-3 rounded-lg text-sm">{notice}</div>}

        {needKey && !plain && (
          <div className={`${card} space-y-3`}>
            <h2 className="text-lg font-semibold text-white">Paste your full link</h2>
            <p className="text-sm text-gray-400">
              This document is end-to-end encrypted. The key is the part of the link after <code>#k=</code>, and {view.business.name} sends
              it to you separately from the email. Paste the full link (or just the key) here; it stays in this browser.
            </p>
            <div className="flex gap-2">
              <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://coinpayportal.com/sign/…#k=…" className={`${input} font-mono text-xs`} />
              <button onClick={usePasted} className={button}>Open</button>
            </div>
          </div>
        )}

        {plain && (
          <section className={card}>
            <Preview bytes={plain} contentType={doc.content_type} title={doc.title} />
            <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
              <p className="text-xs text-gray-500 font-mono break-all">sha256 {hash} ✓ matches the sender&apos;s upload</p>
              <button onClick={() => saveBytes(plain, doc.filename, doc.content_type)} className={ghost}>Download</button>
            </div>
          </section>
        )}

        {view.signers.length > 0 && (
          <section className={card}>
            <h2 className="text-lg font-semibold text-white mb-3">Signatures</h2>
            <ul className="space-y-2">
              {view.signers.map((s, i) => (
                <li key={i} className="flex items-center justify-between text-sm">
                  <span className="text-gray-200">{s.name}{s.you ? ' (you)' : ''}</span>
                  <span className="flex items-center gap-2">
                    {s.signed_at && <span className="text-gray-500">{day(s.signed_at)}</span>}
                    <Badge status={docTone[s.status] ?? 'pending'} label={s.status} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {doc.status === 'completed' && (
          <section className={`${card} flex flex-wrap items-center justify-between gap-3`}>
            <p className="text-gray-200">Everyone has signed{doc.completed_at ? ` (${day(doc.completed_at)})` : ''}.</p>
            {doc.signed_available ? (
              <button disabled={!key} onClick={downloadSigned} className={button}>Download signed copy</button>
            ) : (
              <span className="text-sm text-gray-400">{sealing ? 'Sealing the signed copy…' : 'The signed copy is being prepared.'}</span>
            )}
          </section>
        )}
        {doc.status === 'declined' && <div className={card}><p className="text-gray-300">A signer declined this document, so it can no longer be signed.</p></div>}

        {canSign && plain && !declining && (
          <form onSubmit={sign} className={`${card} space-y-4`}>
            <h2 className="text-lg font-semibold text-white">Sign</h2>
            <label className="block text-sm text-gray-300">
              Type your full name *
              <input required minLength={2} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={`${input} mt-1 text-xl`} style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic' }} />
            </label>
            <div className="text-sm text-gray-300">
              Draw your signature (optional)
              <div className="mt-1"><SignaturePad onChange={setDrawn} /></div>
            </div>
            <label className="flex items-start gap-2 text-sm text-gray-300">
              <input type="checkbox" required checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
              <span>
                I agree to sign this document electronically, that my electronic signature is the legal equivalent of my handwritten
                signature, and that I have reviewed the document above (sha256 {hash.slice(0, 12)}…).
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button disabled={busy || !consent || name.trim().length < 2} className={button}>{busy ? 'Signing…' : 'Sign document'}</button>
              <button type="button" onClick={() => setDeclining(true)} className={ghost}>Decline</button>
            </div>
          </form>
        )}

        {canSign && declining && (
          <form onSubmit={(e) => { e.preventDefault(); act({ action: 'decline', reason: reason.trim() }, 'You declined. The sender has been told.'); }} className={`${card} space-y-3`}>
            <h2 className="text-lg font-semibold text-white">Decline to sign</h2>
            <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tell the sender why" className={input} />
            <div className="flex gap-2">
              <button disabled={busy || !reason.trim()} className={button}>Decline</button>
              <button type="button" onClick={() => setDeclining(false)} className={ghost}>Back</button>
            </div>
          </form>
        )}

        {recipient.status === 'signed' && doc.status !== 'completed' && (
          <div className={card}><p className="text-gray-300">You signed as “{recipient.signature_name}” on {day(recipient.signed_at)}. You will get an email when everyone has signed.</p></div>
        )}
      </div>
    </div>
  );
}
