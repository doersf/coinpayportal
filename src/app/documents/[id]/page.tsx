'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/auth/client';
import { blobRef, documentKeyFor, fetchAndOpen, keyText, linkWithKey, ownerHeaders, saveBytes, sealSignedCopy, uploadVersion } from '@/lib/documents/client';
import { signedFilename } from '@/lib/documents/types';
import type { CertificateInput } from '@/lib/documents/certificate';
import { Badge, button, card, day, docStatusLabel, docTone, ErrorBox, fileSize, ghost, input, NewVersionForm, Preview, roleLabel, Spinner, VaultGate, VersionHistory, type DocVersion } from '../ui';

interface Doc {
  id: string; business_id: string; title: string; message: string | null; filename: string; content_type: string; bytes: number;
  sha256: string; wrapped_key: string; current_version: number; status: string; signed_sha256: string | null; signed_available: boolean;
  completed_at: string | null; voided_at: string | null; void_reason: string | null; created_at: string;
}
interface Recipient {
  id: string; name: string; email: string; role: 'signer' | 'viewer' | 'editor'; status: string; sent_at: string | null; viewed_at: string | null;
  signed_at: string | null; signature_name: string | null; signature_ip: string | null; declined_at: string | null;
  decline_reason: string | null; expires_at: string | null; revoked_at: string | null;
}
interface DocEvent { id: number; actor: string; event: string; actor_label: string | null; ip: string | null; detail: Record<string, unknown> | null; created_at: string }
type Certificate = Omit<CertificateInput, 'document' | 'original' | 'businessName' | 'completedAt'> & { business_name: string; completed_at: string };

const EVENT_TEXT: Record<string, string> = {
  uploaded: 'Uploaded', shared: 'Shared', resent: 'New link sent', revoked: 'Access revoked', viewed: 'Opened', downloaded: 'Downloaded',
  consented: 'Agreed to sign electronically', signed: 'Signed', declined: 'Declined', completed: 'Completed', sealed: 'Signed copy sealed',
  voided: 'Voided', renamed: 'Renamed', version_added: 'New version',
};

const blankRow = { name: '', email: '', role: 'signer' as 'signer' | 'viewer' | 'editor' };

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [events, setEvents] = useState<DocEvent[]>([]);
  const [certificate, setCertificate] = useState<Certificate | null>(null);
  const [versions, setVersions] = useState<DocVersion[]>([]);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await authFetch(`/api/documents/${id}`, {}, router);
    if (!result) return;
    if (!result.data.success) {
      if (result.response?.status === 404) setMissing(true);
      else setError(result.data.error);
      return;
    }
    setDoc(result.data.document);
    setRecipients(result.data.recipients);
    setEvents(result.data.events);
    setCertificate(result.data.certificate);
    setVersions(result.data.versions ?? []);
  }, [id, router]);
  useEffect(() => { load(); }, [load]);

  if (missing) {
    return (
      <div className="min-h-screen bg-gray-900 py-8 px-4">
        <div className={`${card} max-w-md mx-auto text-center`}>
          <p className="text-white">Document not found.</p>
          <Link href="/documents" className={`${button} inline-block mt-4`}>All documents</Link>
        </div>
      </div>
    );
  }
  if (!doc) return error ? <div className="p-8"><ErrorBox message={error} /></div> : <Spinner />;

  return (
    <div className="min-h-screen bg-gray-900 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link href={`/documents?business_id=${doc.business_id}`} className="text-sm text-purple-400 hover:text-purple-300">← All documents</Link>
        <VaultGate businessId={doc.business_id}>
          <DocumentBody
            doc={doc}
            recipients={recipients}
            events={events}
            certificate={certificate}
            versions={versions}
            reload={load}
            busy={busy}
            setBusy={setBusy}
            error={error}
            setError={setError}
            notice={notice}
            setNotice={setNotice}
          />
        </VaultGate>
      </div>
    </div>
  );
}

function DocumentBody(props: {
  doc: Doc; recipients: Recipient[]; events: DocEvent[]; certificate: Certificate | null; versions: DocVersion[]; reload: () => Promise<void>;
  busy: boolean; setBusy: (b: boolean) => void; error: string; setError: (e: string) => void; notice: string; setNotice: (n: string) => void;
}) {
  const { doc, recipients, events, certificate, versions, reload, busy, setBusy, error, setError, notice, setNotice } = props;
  const router = useRouter();
  const [key, setKey] = useState<Uint8Array | null>(null);
  const [plain, setPlain] = useState<Uint8Array | null>(null);
  const [rows, setRows] = useState([{ ...blankRow }]);
  const [message, setMessage] = useState(doc.message ?? '');
  const [emailKey, setEmailKey] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [sealing, setSealing] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const k = await documentKeyFor(doc);
        setKey(k);
        setPlain(await fetchAndOpen(`/api/documents/${doc.id}/file`, k, blobRef(doc), ownerHeaders()));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open the document');
      }
    })();
  }, [doc, setError]);

  // A completed document with no signed copy yet: build it here (we have the key).
  useEffect(() => {
    if (!key || !plain || !certificate || doc.signed_available || sealing) return;
    setSealing(true);
    sealSignedCopy(
      `/api/documents/${doc.id}/file`,
      key,
      { document: doc, businessName: certificate.business_name, original: plain, signers: certificate.signers, events: certificate.events, completedAt: certificate.completed_at },
      ownerHeaders()
    )
      .then(reload)
      .catch((err) => setError(`Could not seal the signed copy: ${err instanceof Error ? err.message : err}`))
      .finally(() => setSealing(false));
  }, [key, plain, certificate, doc, sealing, reload, setError]);

  const call = async (url: string, method: string, body?: unknown) => {
    setError('');
    setNotice('');
    setBusy(true);
    const result = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, router);
    setBusy(false);
    if (!result?.data.success) {
      setError(result?.data.error || 'Something went wrong');
      return null;
    }
    return result.data;
  };

  const share = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key) return;
    const data = await call(`/api/documents/${doc.id}/recipients`, 'POST', {
      recipients: rows.filter((r) => r.email.trim()).map((r) => ({ name: r.name.trim() || r.email.trim(), email: r.email.trim(), role: r.role })),
      message: message.trim() || null,
      ...(emailKey ? { email_document_key: keyText(key) } : {}),
    });
    if (!data) return;
    const fresh: Record<string, string> = {};
    for (const r of data.recipients) fresh[r.id] = linkWithKey(r.url, key);
    setLinks((l) => ({ ...l, ...fresh }));
    setRows([{ ...blankRow }]);
    setNotice(emailKey ? 'Sent. The emails include the key.' : 'Sent. Now pass each person their full link (below) on another channel: the emails do not contain the key.');
    await reload();
  };

  const resend = async (r: Recipient) => {
    if (!key) return;
    const data = await call(`/api/documents/${doc.id}/recipients/${r.id}`, 'POST', emailKey ? { email_document_key: keyText(key) } : {});
    if (!data) return;
    setLinks((l) => ({ ...l, [r.id]: linkWithKey(data.url, key) }));
    setNotice(`New link for ${r.email}; the old one no longer works.`);
    await reload();
  };

  const revoke = async (r: Recipient) => {
    if (!window.confirm(`Revoke ${r.email}'s access? Their link stops working.`)) return;
    if (await call(`/api/documents/${doc.id}/recipients/${r.id}`, 'DELETE')) await reload();
  };

  const voidIt = async () => {
    const reason = window.prompt('Void this document? Nobody can open or sign it afterwards. Reason (optional):');
    if (reason === null) return;
    if (await call(`/api/documents/${doc.id}`, 'PATCH', { action: 'void', reason: reason || undefined })) await reload();
  };

  const remove = async () => {
    if (!window.confirm('Delete this document and its encrypted files for good?')) return;
    if (await call(`/api/documents/${doc.id}`, 'DELETE')) router.push(`/documents?business_id=${doc.business_id}`);
  };

  const downloadSigned = async () => {
    if (!key) return;
    try {
      const bytes = await fetchAndOpen(`/api/documents/${doc.id}/file?version=signed`, key, blobRef(doc, 'signed'), ownerHeaders());
      saveBytes(bytes, signedFilename(doc.filename), 'application/pdf');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const rebuild = async () => {
    if (!key || !plain || !certificate) return;
    setError('');
    setSealing(true);
    try {
      await sealSignedCopy(
        `/api/documents/${doc.id}/file?replace=1`,
        key,
        { document: doc, businessName: certificate.business_name, original: plain, signers: certificate.signers, events: certificate.events, completedAt: certificate.completed_at },
        ownerHeaders()
      );
      setNotice('Signed copy rebuilt from this browser.');
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rebuild the signed copy');
    } finally {
      setSealing(false);
    }
  };

  const downloadVersion = async (v: DocVersion) => {
    if (!key) return;
    try {
      const ref = blobRef(doc, { version: v.version, sha256: v.sha256 });
      saveBytes(await fetchAndOpen(`/api/documents/${doc.id}/file${ref.query}`, key, ref, ownerHeaders()), v.filename, v.content_type);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const newVersion = async (file: File, contentType: string, note: string | null) => {
    if (!key) throw new Error('Still decrypting');
    await uploadVersion(`/api/documents/${doc.id}/versions`, doc.id, key, doc.current_version + 1, file, { contentType, note }, ownerHeaders());
    setNotice(`Version ${doc.current_version + 1} uploaded.`);
    await reload();
  };

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setNotice('Link copied. It contains the key, so send it privately.');
  };

  const live = recipients.filter((r) => !r.revoked_at);
  const closed = ['voided', 'declined'].includes(doc.status);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-white break-words">{doc.title}</h1>
          <p className="text-sm text-gray-400 mt-1">
            {doc.filename} · {fileSize(doc.bytes)} · version {doc.current_version} · uploaded {day(doc.created_at)}
          </p>
          <p className="text-xs text-gray-500 mt-1 font-mono break-all">sha256 {doc.sha256}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={docTone[doc.status] ?? 'draft'} label={docStatusLabel[doc.status] ?? doc.status} />
          {plain && <button onClick={() => saveBytes(plain, doc.filename, doc.content_type)} className={ghost}>Download original</button>}
          {doc.signed_available && <button onClick={downloadSigned} className={button}>Download signed copy</button>}
          {doc.signed_available && <button disabled={sealing || !plain} onClick={rebuild} className={ghost} title="Build the signed copy again in this browser and replace the stored one">Rebuild</button>}
          {!['completed', 'voided'].includes(doc.status) && <button disabled={busy} onClick={voidIt} className={ghost}>Void</button>}
          <button disabled={busy} onClick={remove} className={ghost}>Delete</button>
        </div>
      </div>

      <ErrorBox message={error} />
      {notice && <div className="bg-green-500/10 border border-green-500/30 text-green-300 px-4 py-3 rounded-lg text-sm">{notice}</div>}
      {doc.status === 'voided' && <div className={card}><p className="text-gray-300">Voided {day(doc.voided_at)}{doc.void_reason ? `: ${doc.void_reason}` : ''}. Links no longer open it.</p></div>}
      {sealing && <p className="text-sm text-gray-400">Building and sealing the signed copy…</p>}

      <section className={card}>
        {plain ? <Preview bytes={plain} contentType={doc.content_type} title={doc.title} /> : <p className="text-gray-400 text-sm">Decrypting…</p>}
      </section>

      {['draft', 'shared', 'out_for_signature'].includes(doc.status) && !recipients.some((r) => r.status === 'signed' && !r.revoked_at) && (
        <NewVersionForm onUpload={newVersion} />
      )}

      {!closed && (
        <form onSubmit={share} className={`${card} space-y-3`}>
          <h2 className="text-lg font-semibold text-white">{doc.status === 'completed' ? 'Share the signed copy' : 'Send for signature or share'}</h2>
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-1 sm:grid-cols-7 gap-2">
              <input placeholder="Name" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} className={`${input} sm:col-span-2`} />
              <input required type="email" placeholder="Email" value={r.email} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))} className={`${input} sm:col-span-3`} />
              <select aria-label="Role" value={doc.status === 'completed' ? 'viewer' : r.role} disabled={doc.status === 'completed'} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, role: e.target.value as 'signer' | 'viewer' } : x)))} className={input}>
                <option value="signer">{roleLabel.signer}</option>
                <option value="editor">{roleLabel.editor}</option>
                <option value="viewer">{roleLabel.viewer}</option>
              </select>
              <button type="button" onClick={() => setRows(rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ ...blankRow }])} className={ghost}>Remove</button>
            </div>
          ))}
          <button type="button" onClick={() => setRows([...rows, { ...blankRow, role: doc.status === 'completed' ? 'viewer' : 'signer' }])} className="text-sm text-purple-400 hover:text-purple-300">+ Add person</button>
          <label className="block text-sm text-gray-300">
            Message (not encrypted; it goes in the email)
            <textarea value={message} maxLength={2000} rows={2} onChange={(e) => setMessage(e.target.value)} className={`${input} mt-1`} />
          </label>
          <label className="flex items-start gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={emailKey} onChange={(e) => setEmailKey(e.target.checked)} className="mt-1" />
            <span>
              Put the key in the email too. Convenient, but then the link in the email opens the document, so CoinPay&apos;s mail
              provider and anyone with access to the inbox could read it. Leave this off to keep it end-to-end: you send each
              person their full link yourself.
            </span>
          </label>
          <button disabled={busy || !key} className={button}>Send</button>
        </form>
      )}

      <section className={card}>
        <h2 className="text-lg font-semibold text-white mb-3">People</h2>
        {live.length === 0 ? (
          <p className="text-gray-400 text-sm">Nobody has this document yet.</p>
        ) : (
          <ul className="divide-y divide-gray-700">
            {live.map((r) => (
              <li key={r.id} className="py-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-white">{r.name} <span className="text-gray-500 text-sm">{r.email}</span></p>
                    <p className="text-xs text-gray-500">
                      {roleLabel[r.role]}
                      {r.viewed_at ? ` · opened ${day(r.viewed_at)}` : ''}
                      {r.signed_at ? ` · signed ${day(r.signed_at)} as “${r.signature_name}” from ${r.signature_ip ?? 'unknown address'}` : ''}
                      {r.declined_at ? ` · declined ${day(r.declined_at)}: ${r.decline_reason}` : ''}
                      {r.expires_at ? ` · link expires ${day(r.expires_at)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge status={docTone[r.status] ?? 'pending'} label={r.status} />
                    {doc.status !== 'voided' && <button disabled={busy || !key} onClick={() => resend(r)} className={ghost}>New link</button>}
                    {r.status !== 'signed' && doc.status !== 'voided' && <button disabled={busy} onClick={() => revoke(r)} className={ghost}>Revoke</button>}
                  </div>
                </div>
                {links[r.id] && (
                  <div className="flex gap-2">
                    <input readOnly value={links[r.id]} className={`${input} font-mono text-xs`} onFocus={(e) => e.target.select()} />
                    <button onClick={() => copy(links[r.id])} className={ghost}>Copy</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-gray-500 mt-3">
          Links are shown once, when created. CoinPay stores only a hash of each link and never the key, so to give someone their link again, make a new one.
        </p>
      </section>

      <VersionHistory versions={versions} current={doc.current_version} onDownload={downloadVersion} />

      <section className={card}>
        <h2 className="text-lg font-semibold text-white mb-3">Audit trail</h2>
        <ul className="space-y-1 text-sm">
          {events.map((e) => (
            <li key={e.id} className="text-gray-300">
              <span className="text-gray-500">{new Date(e.created_at).toLocaleString()}</span> · {EVENT_TEXT[e.event] ?? e.event}
              {e.actor_label ? ` · ${e.actor_label}` : ''}
              {e.ip ? <span className="text-gray-500"> · {e.ip}</span> : null}
            </li>
          ))}
        </ul>
        {doc.signed_sha256 && <p className="text-xs text-gray-500 mt-3 font-mono break-all">Signed copy sha256 {doc.signed_sha256}</p>}
      </section>
    </>
  );
}
