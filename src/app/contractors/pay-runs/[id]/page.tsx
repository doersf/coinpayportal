'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authFetch } from '@/lib/auth/client';
import { Badge, button, card, day, ErrorBox, ghost, input, kindLabel, Spinner, usd } from '../../ui';

interface Line { id: string; kind: string; description: string; work_date: string; minutes: number | null; amount: string }
interface Item {
  id: string; contractor_id: string; amount: string; status: string; method: string | null; tx_hash: string | null; error: string | null;
  invoice_number: string; payout_currency: string | null; payout_wallet: string | null; paid_at: string | null;
  contractors: { name: string; email: string; payout_currency: string | null; payout_wallet: string | null; tax_status: string } | null;
  contractor_work_items: Line[];
  warnings: string[];
  can_send_from_wallet: boolean;
}
interface Run { id: string; business_id: string; number: number; pay_date: string; status: string; total: string; auto_drafted: boolean; paid_at: string | null }
interface Outcome { item_id: string; contractor: string; status: string; tx_hash?: string | null; error?: string }

export default function PayRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const r = await authFetch(`/api/pay-runs/${id}`, {}, router);
    if (r?.data.success) {
      setRun(r.data.pay_run);
      setItems(r.data.items);
    } else if (r) setError(r.data.error || 'Not found');
    setLoaded(true);
  }, [id, router]);
  useEffect(() => { load(); }, [load]);

  const pay = async (body: unknown) => {
    setError('');
    setBusy(true);
    const r = await authFetch(`/api/pay-runs/${id}/pay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, router);
    setBusy(false);
    if (!r) return;
    if (r.data.outcomes) setOutcomes(r.data.outcomes);
    if (!r.data.success && !r.data.outcomes) setError(r.data.error || 'Payment failed');
    load();
  };

  const payable = items.filter((i) => i.status === 'pending' || i.status === 'failed');
  const walletReady = payable.filter((i) => i.can_send_from_wallet && i.contractors?.payout_wallet);

  const payAllFromWallet = () => {
    const total = walletReady.reduce((s, i) => s + Number(i.amount), 0);
    const warned = walletReady.filter((i) => i.warnings.length).length;
    const msg = `Send ${usd(total)} to ${walletReady.length} contractor(s) from the business wallet now?` +
      (warned ? `\n\n${warned} of them have warnings. Check them first.` : '') +
      '\n\nCrypto payments cannot be reversed.';
    if (window.confirm(msg)) pay({ method: 'wallet', item_ids: walletReady.map((i) => i.id) });
  };

  const recordManual = (item: Item) => {
    const tx = (hashes[item.id] || '').trim();
    if (tx.length < 8) {
      setError('Paste the transaction hash of the payment you sent');
      return;
    }
    pay({ method: 'manual', payments: [{ item_id: item.id, tx_hash: tx }] });
  };

  const discard = async () => {
    if (!window.confirm('Delete this draft? Its lines go back to the approved pool for the next run.')) return;
    const r = await authFetch(`/api/pay-runs/${id}`, { method: 'DELETE' }, router);
    if (r?.data.success) router.push(`/contractors?business_id=${run?.business_id}&tab=payruns`);
    else setError(r?.data.error || 'Could not delete');
  };

  if (!loaded) return <Spinner />;
  if (!run) return <div className="min-h-screen bg-gray-900 py-8 px-4"><div className="max-w-5xl mx-auto"><ErrorBox message={error || 'Not found'} /></div></div>;

  return (
    <div className="min-h-screen bg-gray-900 py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <Link href={`/contractors?business_id=${run.business_id}&tab=payruns`} className="text-purple-400 hover:text-purple-300 text-sm inline-block">← Pay runs</Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-white">Pay run #{run.number}</h1>
            <p className="text-gray-400 mt-1">Pay date {day(run.pay_date)}{run.auto_drafted ? ' · drafted by the schedule' : ''}{run.paid_at ? ` · paid ${day(run.paid_at)}` : ''}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-semibold text-white">{usd(run.total)}</p>
            <div className="mt-1"><Badge status={run.status} /></div>
          </div>
        </div>

        <ErrorBox message={error} />

        {outcomes.length > 0 && (
          <section className={card}>
            <h2 className="text-white font-semibold mb-2">Result</h2>
            <ul className="text-sm space-y-1">
              {outcomes.map((o) => (
                <li key={o.item_id} className={o.error ? 'text-red-300' : 'text-green-300'}>
                  {o.contractor}: {o.status}{o.tx_hash ? ` · ${o.tx_hash}` : ''}{o.error ? ` · ${o.error}` : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        {payable.length > 0 && (
          <section className={`${card} flex flex-wrap items-center justify-between gap-4`}>
            <div className="text-sm text-gray-300 max-w-xl">
              <p className="text-white font-medium mb-1">How to pay</p>
              <p>
                <strong>From the business wallet:</strong> CoinPay converts each amount at the live rate and sends it to every contractor whose coin
                you hold a payout wallet for ({walletReady.length} of {payable.length} ready).
              </p>
              <p className="mt-1"><strong>From your own wallet:</strong> send each payment yourself, then paste its transaction hash below.</p>
              <p className="mt-1 text-xs text-gray-500">Only the business owner can pay. Crypto payments cannot be reversed.</p>
            </div>
            <div className="flex gap-2">
              {run.status === 'draft' && <button disabled={busy} onClick={discard} className={ghost}>Delete draft</button>}
              <button disabled={busy || walletReady.length === 0} onClick={payAllFromWallet} className={button}>
                {busy ? 'Paying…' : `Pay ${walletReady.length} from wallet`}
              </button>
            </div>
          </section>
        )}

        <section className="space-y-4">
          {items.map((item) => {
            const c = item.contractors;
            const wallet = item.payout_wallet ?? c?.payout_wallet;
            const coin = item.payout_currency ?? c?.payout_currency;
            return (
              <div key={item.id} className={card}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/contractors/${item.contractor_id}`} className="text-white font-medium hover:text-purple-300">{c?.name}</Link>
                    <p className="text-xs text-gray-500">{item.invoice_number} · {c?.email}</p>
                    <p className="text-xs text-gray-400 mt-1 break-all font-mono">{coin ? `${coin} → ${wallet ?? 'no wallet'}` : 'No payout wallet yet'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-xl text-white">{usd(item.amount)}</p>
                    <Badge status={item.status} />
                  </div>
                </div>

                {item.warnings.length > 0 && item.status !== 'paid' && (
                  <ul className="mt-3 text-xs text-amber-300 space-y-1">{item.warnings.map((w) => <li key={w}>⚠ {w}</li>)}</ul>
                )}
                {item.error && item.status !== 'paid' && <p className="mt-2 text-xs text-red-300">{item.error}</p>}
                {item.tx_hash && <p className="mt-2 text-xs text-green-300 break-all">Paid {day(item.paid_at)} · {item.method} · {item.tx_hash}</p>}

                <ul className="mt-3 text-sm divide-y divide-gray-700/60">
                  {item.contractor_work_items.map((l) => (
                    <li key={l.id} className="py-1.5 flex justify-between gap-3 text-gray-300">
                      <span className="min-w-0">{kindLabel[l.kind]}{l.minutes ? ` · ${(l.minutes / 60).toFixed(2)} h` : ''} · {l.description} <span className="text-gray-500">({day(l.work_date)})</span></span>
                      <span>{usd(l.amount)}</span>
                    </li>
                  ))}
                </ul>

                {(item.status === 'pending' || item.status === 'failed' || item.status === 'indeterminate') && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <input
                      aria-label={`Transaction hash for ${c?.name}`}
                      placeholder={item.status === 'indeterminate' ? 'It landed? Paste its tx hash' : 'Paid from your own wallet? Paste the tx hash'}
                      value={hashes[item.id] ?? ''}
                      onChange={(e) => setHashes({ ...hashes, [item.id]: e.target.value })}
                      className={`${input} flex-1 min-w-[240px]`}
                    />
                    <button disabled={busy} onClick={() => recordManual(item)} className={ghost}>Record payment</button>
                    {item.status === 'indeterminate' && (
                      <button disabled={busy} onClick={() => window.confirm('You checked the chain and this payment did NOT land?') && pay({ method: 'mark_failed', item_id: item.id })} className={ghost}>
                        It did not land
                      </button>
                    )}
                    {item.can_send_from_wallet && item.status !== 'indeterminate' && wallet && (
                      <button disabled={busy} onClick={() => window.confirm(`Send ${usd(item.amount)} to ${c?.name} now?`) && pay({ method: 'wallet', item_ids: [item.id] })} className={button}>
                        Pay from wallet
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
