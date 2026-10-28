'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatMoney, formatDate } from '@/lib/finances/format';

/**
 * Due soon, recurring charges and the daily summary email, across every
 * linked account. Reads `/api/finances/due-soon`, which projects recurring
 * charges from their own cadence and adds statement due days set on cards
 * and loans in the accounts table below.
 */

type DueItem = {
  source: 'projected' | 'scheduled';
  payee: string;
  amount: number | null;
  owed: number | null;
  cadence: string;
  dueOn: string;
  daysUntil: number;
  status: 'overdue' | 'awaiting' | 'today' | 'soon' | 'paid';
  accountId: string;
  accountName: string;
  scope: 'business' | 'personal';
  isDebtService: boolean;
};

type RecurringCharge = {
  payee: string;
  amount: number;
  cadence: string;
  occurrences: number;
  lastSeen: string;
  nextExpected: string;
  monthlyEquivalent: number;
  scope: 'business' | 'personal';
  isDebtService: boolean;
  accountName: string;
  origin?: 'observed' | 'matched' | 'declared';
};

type DueSoon = {
  timezone: string;
  today: string;
  horizonDays: number;
  items: DueItem[];
  paid: DueItem[];
  missed: Array<{ payee: string; amount: number; expectedOn: string; lastSeen: string; accountName: string }>;
  totals: { due: number; overdue: number; unpriced: number };
  recurring: { charges: RecurringCharge[]; monthlyTotal: number; monthlyDebtService: number };
  currency: string | null;
};

type Schedule = { id: string; kind: string; hour: number; timezone: string; recipients: string[]; active: boolean; lastSentAt: string | null; nextRunAt: string | null };

const HORIZONS = [7, 14, 30];

const STATUS_STYLE: Record<DueItem['status'], string> = {
  overdue: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  awaiting: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
  today: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  soon: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  paid: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
};

function whenLabel(item: DueItem): string {
  if (item.status === 'paid') return 'Paid';
  if (item.status === 'awaiting') return 'not posted yet';
  if (item.daysUntil === 0) return 'Today';
  if (item.daysUntil === 1) return 'Tomorrow';
  if (item.daysUntil === -1) return 'Yesterday';
  if (item.daysUntil < 0) return `${-item.daysUntil}d late`;
  return `in ${item.daysUntil}d`;
}

export default function DueSoonSection({
  authHeaders,
  refreshKey,
}: {
  authHeaders: (extra?: HeadersInit) => HeadersInit;
  /** Changes whenever the page reloads its overview, e.g. after a sync. */
  refreshKey: unknown;
}) {
  const [horizon, setHorizon] = useState(7);
  const [data, setData] = useState<DueSoon | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRecurring, setShowRecurring] = useState(false);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailNote, setEmailNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [dueRes, schedRes] = await Promise.all([
        fetch(`/api/finances/due-soon?days=${horizon}`, { headers: authHeaders() }),
        fetch('/api/finances/email-schedules?kind=daily_summary', { headers: authHeaders() }),
      ]);
      if (!dueRes.ok) throw new Error('Could not load what is due.');
      const body = await dueRes.json();
      setData(body.dueSoon as DueSoon);
      if (schedRes.ok) setSchedule(((await schedRes.json()).schedule as Schedule | null) ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load what is due.');
    }
  }, [authHeaders, horizon]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const toggleDaily = async () => {
    setEmailBusy(true);
    setEmailNote(null);
    try {
      const res = schedule?.active
        ? await fetch('/api/finances/email-schedules?kind=daily_summary', { method: 'DELETE', headers: authHeaders() })
        : await fetch('/api/finances/email-schedules', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ kind: 'daily_summary', active: true }),
          });
      if (!res.ok) throw new Error('Could not change the daily summary.');
      await load();
    } catch (err) {
      setEmailNote(err instanceof Error ? err.message : 'Could not change the daily summary.');
    } finally {
      setEmailBusy(false);
    }
  };

  const sendNow = async () => {
    setEmailBusy(true);
    setEmailNote(null);
    try {
      const res = await fetch('/api/finances/email-schedules/send-now?kind=daily_summary', { method: 'POST', headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      setEmailNote(res.ok ? `Sent to ${(body.sent as string[] | undefined)?.join(', ') ?? 'recipients'}.` : 'Send failed.');
    } finally {
      setEmailBusy(false);
    }
  };

  if (error) {
    return (
      <section className="mb-10 rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</section>
    );
  }
  if (!data) return null;

  const currency = data.currency ?? 'USD';
  const rows = [...data.items, ...data.paid];

  return (
    <section className="mb-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-white">Due soon</h2>
        <div className="flex items-center gap-2">
          {HORIZONS.map((d) => (
            <button
              key={d}
              onClick={() => setHorizon(d)}
              className={`rounded px-3 py-1 text-xs border ${
                horizon === d ? 'border-purple-500/40 bg-purple-600/20 text-purple-200' : 'border-slate-700 text-gray-400 hover:bg-slate-800'
              }`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-900/50 overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-slate-800 px-4 py-3 text-sm">
          <span className="text-white font-semibold">{formatMoney(data.totals.due, currency)} due</span>
          {data.totals.overdue > 0 && <span className="text-rose-300">{formatMoney(data.totals.overdue, currency)} overdue</span>}
          {data.totals.unpriced > 0 && (
            <span className="text-gray-400">
              + {data.totals.unpriced} statement balance{data.totals.unpriced === 1 ? '' : 's'}
            </span>
          )}
          <span className="ml-auto text-xs text-gray-500">
            {data.today} · {data.timezone} · all accounts
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-gray-400">Nothing due in the next {data.horizonDays} days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {rows.map((item, i) => (
                  <tr key={`${item.accountId}:${item.payee}:${i}`} className="border-b border-slate-800/60 last:border-0">
                    <td className="px-4 py-2 whitespace-nowrap">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${STATUS_STYLE[item.status]}`}>{whenLabel(item)}</span>
                      <div className="text-xs text-gray-500 mt-1">{item.dueOn}</div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="text-gray-200">{item.payee}</div>
                      <div className="text-xs text-gray-500">
                        {item.accountName} · {item.source === 'scheduled' ? 'statement due' : item.isDebtService ? `${item.cadence} payment` : item.cadence} · {item.scope}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap text-gray-200">
                      {item.amount !== null
                        ? formatMoney(item.amount, currency)
                        : item.owed !== null
                          ? <span className="text-gray-400">balance {formatMoney(item.owed, currency)}</span>
                          : 'statement balance'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.missed.length > 0 && (
          <div className="border-t border-slate-800 px-4 py-3 text-xs text-gray-400">
            <span className="text-gray-300">Not seen lately:</span>{' '}
            {data.missed
              .slice(0, 8)
              .map((m) => `${m.payee} ${formatMoney(m.amount, currency)} (expected ${m.expectedOn})`)
              .join(' · ')}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-slate-800 px-4 py-3 text-xs text-gray-400">
          <span>
            Daily summary email:{' '}
            {schedule?.active ? (
              <span className="text-emerald-300">
                on, {String(schedule.hour).padStart(2, '0')}:00 {schedule.timezone} to {schedule.recipients.join(', ')}
              </span>
            ) : (
              <span>off</span>
            )}
          </span>
          <button onClick={toggleDaily} disabled={emailBusy} className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-50">
            {schedule?.active ? 'Turn off' : 'Turn on'}
          </button>
          {schedule?.active && (
            <button onClick={sendNow} disabled={emailBusy} className="rounded border border-slate-700 px-2 py-1 hover:bg-slate-800 disabled:opacity-50">
              Send now
            </button>
          )}
          {emailNote && <span className="text-gray-300">{emailNote}</span>}
          <span className="ml-auto">Set a card or loan&apos;s statement due day in Accounts below.</span>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-700 bg-slate-900/50 overflow-hidden">
        <button
          onClick={() => setShowRecurring((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-slate-800/50"
        >
          <span className="text-white font-semibold">
            Recurring charges · {data.recurring.charges.length}
          </span>
          <span className="text-gray-400">
            {formatMoney(data.recurring.monthlyTotal, currency)}/mo
            {data.recurring.monthlyDebtService > 0 && ` (${formatMoney(data.recurring.monthlyDebtService, currency)} debt service)`}
            <span className="ml-2">{showRecurring ? '▾' : '▸'}</span>
          </span>
        </button>
        {showRecurring && (
          <div className="overflow-x-auto border-t border-slate-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 text-left">
                  <th className="px-4 py-2 font-normal">Payee</th>
                  <th className="px-4 py-2 font-normal">Cadence</th>
                  <th className="px-4 py-2 font-normal">Last</th>
                  <th className="px-4 py-2 font-normal">Next</th>
                  <th className="px-4 py-2 font-normal text-right">Amount</th>
                  <th className="px-4 py-2 font-normal text-right">Per month</th>
                </tr>
              </thead>
              <tbody>
                {[...data.recurring.charges]
                  .sort((a, b) => (a.nextExpected || '9999').localeCompare(b.nextExpected || '9999'))
                  .map((c, i) => (
                    <tr key={`${c.payee}:${i}`} className="border-t border-slate-800/60">
                      <td className="px-4 py-2">
                        <div className="text-gray-200">{c.payee}</div>
                        <div className="text-xs text-gray-500">
                          {c.accountName} · {c.scope}
                          {c.isDebtService ? ' · debt payment' : ''}
                          {c.origin === 'declared' ? ' · declared, not in any feed' : c.origin === 'matched' ? ' · declared + seen' : ''}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-gray-400">
                        {c.cadence}{c.origin === 'declared' ? '' : ` · ${c.occurrences}×`}
                      </td>
                      <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{c.origin === 'declared' ? '—' : formatDate(c.lastSeen)}</td>
                      <td className="px-4 py-2 text-gray-300 whitespace-nowrap">{c.nextExpected ? formatDate(c.nextExpected) : '—'}</td>
                      <td className="px-4 py-2 text-right text-gray-200">{formatMoney(c.amount, currency)}</td>
                      <td className="px-4 py-2 text-right text-gray-400">{formatMoney(c.monthlyEquivalent, currency)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
