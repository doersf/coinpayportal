'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { requireAuth } from '@/lib/auth/client';

/**
 * /finances/books — the bookkeeping desk.
 *
 * Every transaction arrives with a suggested category, tax category and
 * scope from a rule, the heuristics or the model. This page is where a
 * person agrees, corrects, and (with one checkbox) turns a correction into
 * a rule so the next sync gets it right on its own. The Tax summary tab
 * totals the reviewed books by tax category for a year or quarter and
 * exports the pack a CPA works from. Nothing here is tax advice, and the
 * export says how many rows are still unreviewed.
 */

interface Row {
  id: string;
  accountId: string;
  accountName: string;
  orgName: string | null;
  currency: string;
  posted: string | null;
  amount: string;
  payee: string | null;
  description: string | null;
  memo: string | null;
  category: string | null;
  categorySource: string;
  categoryConfidence: number | null;
  taxCategory: string | null;
  taxCategoryLabel: string;
  scope: string;
  accountScope: string;
  reviewedAt: string | null;
  note: string | null;
  suggestion: { category: string | null; taxCategory: string | null; confidence: number | null; by: string | null } | null;
}

interface Rule {
  id: string;
  match_field: string;
  match_type: string;
  pattern: string;
  category: string;
  tax_category: string | null;
  scope: string | null;
  hits: number;
}

interface SummaryLine {
  taxCategory: string;
  label: string;
  currency: string;
  total: string;
  rows: number;
  excluded: boolean;
  income: boolean;
}

type Tab = 'review' | 'rules' | 'summary';

type SortDir = 'asc' | 'desc';
interface SortState<K extends string> { key: K; dir: SortDir }

/** Server-side sort keys for the review queue (see QUEUE_SORTS in lib/finances/books). */
type QueueSortKey = 'posted' | 'payee' | 'account' | 'amount' | 'category' | 'tax_category' | 'confidence' | 'scope';

/** Next sort for a header click: same column flips, a new one starts at `first`. */
function nextSort<K extends string>(cur: SortState<K>, key: K, first: SortDir = 'asc'): SortState<K> {
  return cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: first };
}

/** Sort a copy; numbers (and numeric strings like amounts) compare as numbers, blanks last. */
function sortRows<T>(rows: T[], get: (r: T) => string | number | null | undefined, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === null || x === undefined || x === '') return y === null || y === undefined || y === '' ? 0 : 1;
    if (y === null || y === undefined || y === '') return -1;
    const nx = typeof x === 'number' ? x : Number(x);
    const ny = typeof y === 'number' ? y : Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) return (nx - ny) * sign;
    return String(x).localeCompare(String(y), undefined, { sensitivity: 'base', numeric: true }) * sign;
  });
}

function SortTh<K extends string>({ label, k, sort, onSort, align = 'left', first = 'asc', title }: { label: string; k: K; sort: SortState<K>; onSort: (s: SortState<K>) => void; align?: 'left' | 'right'; first?: SortDir; title?: string }) {
  const active = sort.key === k;
  return (
    <th className={`px-2 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(nextSort(sort, k, first))} title={title} className={`inline-flex items-center gap-1 hover:text-gray-200 ${active ? 'text-gray-100' : ''}`}>
        {label}
        <span className="text-[10px] text-gray-500">{active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

const GUESSED_TZ = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';

function authHeaders(extra?: HeadersInit): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('auth_token') : null;
  const headers: Record<string, string> = { ...(extra as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function readError(data: unknown, fallback: string): string {
  const err = (data as { error?: unknown } | null)?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message;
  return fallback;
}

export default function BooksContent() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('review');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // review queue
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [unreviewed, setUnreviewed] = useState(0);
  const [status, setStatus] = useState<'unreviewed' | 'reviewed' | 'all'>('unreviewed');
  const [scope, setScope] = useState<'all' | 'business' | 'personal'>('all');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [categories, setCategories] = useState<string[]>([]);
  const [taxCategories, setTaxCategories] = useState<Array<{ id: string; label: string }>>([]);
  const [modelEnabled, setModelEnabled] = useState(false);
  const [edits, setEdits] = useState<Record<string, { category: string; taxCategory: string; scope: string; always: boolean }>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [categorizing, setCategorizing] = useState(false);
  const [job, setJob] = useState<{ id: string; status: string; result?: Record<string, unknown> | null } | null>(null);
  const [queueSort, setQueueSort] = useState<SortState<QueueSortKey>>({ key: 'posted', dir: 'desc' });
  const [autoAccept, setAutoAccept] = useState(true);
  const [rulesSort, setRulesSort] = useState<SortState<'pattern' | 'category' | 'tax' | 'scope' | 'hits'>>({ key: 'pattern', dir: 'asc' });
  const [summarySort, setSummarySort] = useState<SortState<'label' | 'currency' | 'total' | 'rows'>>({ key: 'label', dir: 'asc' });

  // rules
  const [rules, setRules] = useState<Rule[]>([]);

  // summary
  const currentYear = new Date().getFullYear();
  const [period, setPeriod] = useState(String(currentYear));
  const [summaryScope, setSummaryScope] = useState<'business' | 'personal' | 'all'>('business');
  const [summary, setSummary] = useState<{ lines: SummaryLine[]; totals: Array<{ currency: string; income: string; expenses: string; net: string; excluded: string }>; rows: number; unreviewed: number; uncategorized: number; notice: string; period: { label: string } } | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // email + weekly digest
  const [packTo, setPackTo] = useState('');
  const [packMessage, setPackMessage] = useState('');
  const [packSending, setPackSending] = useState(false);
  const [digest, setDigest] = useState<{ id: string; weekdays: number[]; hour: number; timezone: string; recipients: string[]; scope: string; formats: string[]; active: boolean; lastSentAt: string | null; nextRunAt: string | null } | null>(null);
  const [digestDays, setDigestDays] = useState<number[]>([1, 5]);
  const [digestHour, setDigestHour] = useState(8);
  const [digestTo, setDigestTo] = useState('');
  const [digestScope, setDigestScope] = useState<'business' | 'personal' | 'all'>('all');
  const [digestOptedOut, setDigestOptedOut] = useState(false);
  const [digestBusy, setDigestBusy] = useState(false);

  // business report (opt-in) + Connect CrawlProof
  const [bizReport, setBizReport] = useState<{ active: boolean; recipients: string[]; nextRunAt: string | null; lastSentAt: string | null } | null>(null);
  const [bizBusy, setBizBusy] = useState(false);
  const [crawlproof, setCrawlproof] = useState<{ connected: boolean; tokenPrefix: string | null; sitesCount: number; lastOkAt: string | null; lastError: string | null; tokensUrl: string } | null>(null);
  const [cpToken, setCpToken] = useState('');

  const loadDigest = useCallback(async () => {
    const res = await fetch('/api/finances/email-schedules', { headers: authHeaders(), cache: 'no-store' });
    const data = await res.json();
    if (res.ok) setDigestOptedOut(Boolean(data.weeklyDigestOptedOutAt));
    if (res.ok && data.schedule) {
      setDigest(data.schedule);
      setDigestDays(data.schedule.weekdays);
      setDigestHour(data.schedule.hour);
      setDigestTo(data.schedule.recipients.join(', '));
      setDigestScope(data.schedule.scope);
    }
  }, []);

  const loadBusiness = useCallback(async () => {
    const [sched, cp] = await Promise.all([
      fetch('/api/finances/email-schedules?kind=business_report', { headers: authHeaders(), cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/finances/integrations/crawlproof', { headers: authHeaders(), cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (sched) setBizReport(sched.schedule ?? null);
    if (cp?.crawlproof) setCrawlproof(cp.crawlproof);
  }, []);

  // The report emails' Settings links land on #weekly-digest / #business-report, on the summary tab.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id !== 'weekly-digest' && id !== 'business-report') return;
    setTab('summary');
    const timer = setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'center' }), 300);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    void loadBusiness();
  }, [loadBusiness]);

  const toggleBusinessReport = async (on: boolean) => {
    setBizBusy(true);
    setError(null);
    try {
      const res = on
        ? await fetch('/api/finances/email-schedules', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ kind: 'business_report', timezone: GUESSED_TZ, active: true }) })
        : await fetch('/api/finances/email-schedules?kind=business_report', { method: 'DELETE', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not save the business report'));
      setNotice(on ? `Business report on. Next send ${data.schedule?.nextRunAt ? new Date(data.schedule.nextRunAt).toLocaleString() : 'soon'} to ${data.schedule?.recipients?.join(', ')}.` : 'Business report off.');
      await loadBusiness();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the business report');
    } finally {
      setBizBusy(false);
    }
  };

  const sendBusinessNow = async () => {
    setBizBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/finances/email-schedules/send-now?kind=business_report', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not send the business report'));
      setNotice(`Business report sent to ${data.sent.join(', ')}${data.crawlproof ? ' with your CrawlProof numbers' : ''}.`);
      void loadBusiness();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the business report');
    } finally {
      setBizBusy(false);
    }
  };

  const connectCrawlproof = async (connect: boolean) => {
    setBizBusy(true);
    setError(null);
    try {
      const res = connect
        ? await fetch('/api/finances/integrations/crawlproof', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify({ token: cpToken.trim() }) })
        : await fetch('/api/finances/integrations/crawlproof', { method: 'DELETE', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, connect ? 'Could not connect CrawlProof' : 'Could not disconnect CrawlProof'));
      setCpToken('');
      setNotice(connect ? `CrawlProof connected: ${data.crawlproof.sitesCount} site(s).` : 'CrawlProof disconnected; the stored token was deleted.');
      await loadBusiness();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'CrawlProof request failed');
    } finally {
      setBizBusy(false);
    }
  };

  useEffect(() => {
    void loadDigest();
  }, [loadDigest]);

  const sendPack = async () => {
    setPackSending(true);
    setError(null);
    try {
      const res = await fetch('/api/finances/books/send', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ to: packTo, period, scope: summaryScope, timezone: GUESSED_TZ, formats: ['pdf', 'csv'], message: packMessage || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not send the pack'));
      setNotice(`Sent the ${period} ${summaryScope} pack to ${data.sent.join(', ')}${data.failed?.length ? ` (failed: ${data.failed.map((f: { to: string }) => f.to).join(', ')})` : ''}; ${data.unreviewed} rows were still unreviewed. Link expires ${String(data.linkExpiresAt).slice(0, 10)}.`);
      setPackMessage('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the pack');
    } finally {
      setPackSending(false);
    }
  };

  const saveDigest = async (active: boolean) => {
    setDigestBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/finances/email-schedules', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ weekdays: digestDays, hour: digestHour, timezone: GUESSED_TZ, recipients: digestTo.trim() ? digestTo : undefined, scope: digestScope, formats: ['pdf', 'csv'], active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not save the digest'));
      setDigest(data.schedule);
      setDigestOptedOut(!active);
      setNotice(active ? `Weekly digest on. Next send ${data.schedule.nextRunAt ? new Date(data.schedule.nextRunAt).toLocaleString() : 'soon'} to ${data.schedule.recipients.join(', ')}.` : 'Weekly digest off. It stays off until you turn it back on.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the digest');
    } finally {
      setDigestBusy(false);
    }
  };

  const sendDigestNow = async () => {
    setDigestBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/finances/email-schedules/send-now', { method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not send the digest'));
      setNotice(`Digest sent to ${data.sent.join(', ')}${data.failed?.length ? ` (failed: ${data.failed.map((f: { to: string }) => f.to).join(', ')})` : ''}.`);
      void loadDigest();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the digest');
    } finally {
      setDigestBusy(false);
    }
  };

  const PAGE = 50;

  const loadQueue = useCallback(async () => {
    if (!requireAuth(router)) return;
    const params = new URLSearchParams({ status, scope, limit: String(PAGE), offset: String(offset) });
    if (search.trim()) params.set('search', search.trim());
    // Scope is per row (an override or the account's), so it sorts the loaded page only.
    if (queueSort.key !== 'scope') {
      params.set('sort', queueSort.key);
      params.set('dir', queueSort.dir);
    }
    const res = await fetch(`/api/finances/books/queue?${params.toString()}`, { headers: authHeaders(), cache: 'no-store' });
    const data = await res.json();
    if (res.status === 401 || res.status === 403) {
      setError('Your session has expired. Please log in again.');
      return;
    }
    if (!res.ok) throw new Error(readError(data, 'Could not load the queue'));
    setRows(data.rows);
    setTotal(data.total);
    setUnreviewed(data.unreviewed);
    setCategories(data.categories);
    setTaxCategories(data.taxCategories);
    setModelEnabled(data.modelEnabled === true);
    if (typeof data.autoAccept === 'boolean') setAutoAccept(data.autoAccept);
    setEdits({});
    setSelected(new Set());
  }, [router, status, scope, search, offset, queueSort]);

  const loadRules = useCallback(async () => {
    const res = await fetch('/api/finances/books/rules', { headers: authHeaders(), cache: 'no-store' });
    const data = await res.json();
    if (res.ok) setRules(data.rules ?? []);
  }, []);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const params = new URLSearchParams({ period, scope: summaryScope, timezone: GUESSED_TZ });
      const res = await fetch(`/api/finances/books/summary?${params.toString()}`, { headers: authHeaders(), cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not load the summary'));
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the summary');
    } finally {
      setSummaryLoading(false);
    }
  }, [period, summaryScope]);

  useEffect(() => {
    setLoading(true);
    loadQueue()
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the queue'))
      .finally(() => setLoading(false));
  }, [loadQueue]);

  useEffect(() => {
    void loadRules();
  }, [loadRules]);

  useEffect(() => {
    if (tab === 'summary') void loadSummary();
  }, [tab, loadSummary]);

  // Poll a running categorisation job.
  useEffect(() => {
    if (!job || ['completed', 'failed', 'cancelled', 'partial'].includes(job.status)) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/finances/jobs/${job.id}`, { headers: authHeaders(), cache: 'no-store' });
      const data = await res.json();
      if (res.ok) {
        setJob(data.job);
        if (['completed', 'failed'].includes(data.job.status)) {
          const r = data.job.result ?? {};
          setNotice(
            data.job.status === 'completed'
              ? `Categorisation finished: ${r.examined ?? 0} examined, ${r.fromRules ?? 0} by rule, ${r.fromModel ?? 0} by model, ${r.autoAccepted ?? 0} accepted, ${r.queued ?? 0} for review.${r.reviewed ? ` Auto-accept approved ${r.reviewed}.` : ''}${r.modelError ? ` Model pass skipped: ${r.modelError}` : ''}`
              : `Categorisation failed: ${data.job.errorMessage ?? 'unknown error'}`,
          );
          setCategorizing(false);
          void loadQueue();
        }
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [job, loadQueue]);

  const editFor = (r: Row) =>
    edits[r.id] ?? {
      category: r.category ?? r.suggestion?.category ?? '',
      taxCategory: r.taxCategory ?? r.suggestion?.taxCategory ?? 'uncategorized',
      scope: r.scope,
      always: false,
    };

  const setEdit = (id: string, patch: Partial<{ category: string; taxCategory: string; scope: string; always: boolean }>) => {
    setEdits((prev) => {
      const row = rows.find((r) => r.id === id);
      const base = row ? editFor(row) : { category: '', taxCategory: 'uncategorized', scope: 'personal', always: false };
      return { ...prev, [id]: { ...base, ...(prev[id] ?? {}), ...patch } };
    });
  };

  const confirm = async (r: Row) => {
    const e = editFor(r);
    setBusy(r.id);
    setError(null);
    try {
      const res = await fetch(`/api/finances/books/transactions/${r.id}`, {
        method: 'PATCH',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ category: e.category || null, taxCategory: e.taxCategory, scope: e.scope, createRule: e.always }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not save'));
      setRows((prev) => (status === 'unreviewed' ? prev.filter((x) => x.id !== r.id) : prev.map((x) => (x.id === r.id ? data.transaction : x))));
      setUnreviewed((n) => Math.max(0, n - (r.reviewedAt ? 0 : 1)));
      if (e.always) void loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const confirmSelected = async () => {
    if (selected.size === 0) return;
    setBusy('bulk');
    setError(null);
    try {
      const res = await fetch('/api/finances/books/bulk', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ ids: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not save'));
      setNotice(`Confirmed ${data.reviewed} row(s) as suggested.`);
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  const approveAll = async () => {
    const n = status === 'unreviewed' ? total : unreviewed;
    const filtered = scope !== 'all' || search.trim();
    if (!window.confirm(`Approve ${filtered ? 'every unreviewed row matching these filters' : `all ${n.toLocaleString()} unreviewed rows`} as suggested? Rows with no suggestion are approved as uncategorised.`)) return;
    setBusy('all');
    setError(null);
    try {
      const res = await fetch('/api/finances/books/bulk', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ all: true, scope, search: search.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not approve the queue'));
      setNotice(`Approved ${Number(data.reviewed).toLocaleString()} row(s) as suggested.`);
      setOffset(0);
      await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve the queue');
    } finally {
      setBusy(null);
    }
  };

  const toggleAutoAccept = async (on: boolean) => {
    setBusy('auto');
    setError(null);
    try {
      const res = await fetch('/api/finances/books/settings', {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ autoAccept: on }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not save the setting'));
      setAutoAccept(data.autoAccept);
      setNotice(on
        ? `Auto-accept on: suggestions are approved as they arrive${data.reviewed ? `; ${Number(data.reviewed).toLocaleString()} waiting row(s) approved now` : ''}.`
        : 'Auto-accept off: new rows wait here for you to confirm.');
      if (data.reviewed) await loadQueue();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the setting');
    } finally {
      setBusy(null);
    }
  };

  const categorize = async () => {
    setCategorizing(true);
    setError(null);
    try {
      const res = await fetch('/api/finances/books/categorize', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ useModel: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(readError(data, 'Could not start categorisation'));
      setJob(data.job);
      setNotice(data.modelEnabled ? 'Auto-categorisation started (rules, heuristics, then the model).' : 'Auto-categorisation started with rules and heuristics. Set ANTHROPIC_API_KEY on the server to add the model pass.');
    } catch (err) {
      setCategorizing(false);
      setError(err instanceof Error ? err.message : 'Could not start categorisation');
    }
  };

  const deleteRule = async (rule: Rule) => {
    if (!window.confirm(`Delete the rule "${rule.pattern}" → ${rule.category}? Rows it already categorised keep their values.`)) return;
    const res = await fetch(`/api/finances/books/rules/${rule.id}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) setError(readError(await res.json().catch(() => null), 'Could not delete the rule'));
    await loadRules();
  };

  const download = async (format: string) => {
    try {
      const params = new URLSearchParams({ period, scope: summaryScope, timezone: GUESSED_TZ, format });
      const res = await fetch(`/api/finances/books/export?${params.toString()}`, { headers: authHeaders(), cache: 'no-store' });
      if (!res.ok) throw new Error(readError(await res.json().catch(() => null), `Export failed (HTTP ${res.status})`));
      const blob = await res.blob();
      const match = /filename="?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = match ? match[1] : `books-${period}.${format}`;
      a.style.visibility = 'hidden';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    }
  };

  const inputClass = 'rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-gray-200';
  const btnPrimary = 'rounded bg-purple-600 px-3 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50';
  const btnSecondary = 'rounded border border-slate-600 px-3 py-2 text-sm text-gray-300 hover:bg-slate-800 disabled:opacity-50';
  const money = (v: string, c: string) => `${v} ${c}`;

  const confidenceTone = (r: Row) => {
    const c = r.categoryConfidence ?? r.suggestion?.confidence ?? 0;
    return c >= 0.9 ? 'text-emerald-300' : c >= 0.6 ? 'text-amber-300' : 'text-red-300';
  };

  // Server already ordered the page; account (grouped by id server-side) and scope are refined here.
  const viewRows = useMemo(() => {
    if (queueSort.key === 'account') return sortRows(rows, (r) => r.accountName, queueSort.dir);
    if (queueSort.key === 'scope') return sortRows(rows, (r) => editFor(r).scope, queueSort.dir);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, edits, queueSort]);

  const viewRules = useMemo(() => {
    const get: Record<typeof rulesSort.key, (r: Rule) => string | number | null> = {
      pattern: (r) => r.pattern,
      category: (r) => r.category,
      tax: (r) => r.tax_category,
      scope: (r) => r.scope,
      hits: (r) => r.hits,
    };
    return sortRows(rules, get[rulesSort.key], rulesSort.dir);
  }, [rules, rulesSort]);

  const viewSummaryLines = useMemo(() => {
    if (!summary) return [];
    const get: Record<typeof summarySort.key, (l: SummaryLine) => string | number> = {
      label: (l) => l.label,
      currency: (l) => l.currency,
      total: (l) => l.total,
      rows: (l) => l.rows,
    };
    return sortRows(summary.lines, get[summarySort.key], summarySort.dir);
  }, [summary, summarySort]);

  const onQueueSort = (next: SortState<QueueSortKey>) => {
    setOffset(0);
    setQueueSort(next);
  };

  const periodOptions = useMemo(() => {
    const opts: string[] = [];
    for (let y = currentYear; y >= currentYear - 3; y -= 1) {
      opts.push(String(y));
      for (let q = 4; q >= 1; q -= 1) opts.push(`${y}-Q${q}`);
    }
    return opts;
  }, [currentYear]);

  if (loading) return <div className="container mx-auto px-4 py-16 text-center text-gray-400">Loading the books…</div>;

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h1 className="text-3xl font-bold text-white">Books</h1>
          <p className="text-gray-400 mt-1">
            Every transaction gets a suggested category, tax bucket and business/personal scope. You confirm; a checkbox turns a correction into a rule.{' '}
            <Link href="/finances" className="text-purple-300 hover:underline">Back to finances</Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={categorize} disabled={categorizing} className={btnPrimary} title={modelEnabled ? 'Rules, heuristics, then the model' : 'Rules and heuristics (no model key configured)'}>
            {categorizing ? 'Categorising…' : 'Auto-categorise unreviewed'}
          </button>
        </div>
      </div>

      {notice && <div className="mb-4 rounded border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">{notice}</div>}
      {error && <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>}

      <div className="flex gap-1 mb-4">
        {(['review', 'rules', 'summary'] as Tab[]).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`rounded px-3 py-1 text-sm ${tab === t ? 'bg-purple-600 text-white' : 'border border-slate-700 text-gray-300'}`}>
            {t === 'review' ? `Review (${unreviewed} to go)` : t === 'rules' ? `Rules (${rules.length})` : 'Tax summary'}
          </button>
        ))}
      </div>

      {tab === 'review' && (
        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <select value={status} onChange={(e) => { setOffset(0); setStatus(e.target.value as typeof status); }} className={inputClass}>
              <option value="unreviewed">Needs review</option>
              <option value="reviewed">Reviewed</option>
              <option value="all">All</option>
            </select>
            <select value={scope} onChange={(e) => { setOffset(0); setScope(e.target.value as typeof scope); }} className={inputClass}>
              <option value="all">Business and personal</option>
              <option value="business">Business accounts</option>
              <option value="personal">Personal accounts</option>
            </select>
            <input type="search" placeholder="Search payee, description" value={search} onChange={(e) => { setOffset(0); setSearch(e.target.value); }} className={`${inputClass} w-56`} />
            <span className="text-xs text-gray-500">{total.toLocaleString()} rows</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-gray-300 cursor-pointer" title="Approve suggestions from rules, heuristics and the model as they arrive (each sync and categorisation run). Rows nothing could categorise still wait here.">
                <input type="checkbox" checked={autoAccept} disabled={busy === 'auto'} onChange={(e) => toggleAutoAccept(e.target.checked)} />
                Auto-accept suggestions
              </label>
              <button type="button" className={btnSecondary} disabled={selected.size === 0 || busy === 'bulk'} onClick={confirmSelected}>
                Confirm {selected.size} selected as suggested
              </button>
              <button type="button" className={btnPrimary} disabled={unreviewed === 0 || status === 'reviewed' || busy === 'all'} onClick={approveAll}>
                {busy === 'all' ? 'Approving…' : `Approve all${status === 'unreviewed' && total > 0 ? ` ${total.toLocaleString()}` : ''}`}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-gray-400">
                <tr className="border-b border-slate-800">
                  <th className="px-2 py-2 text-left"><input type="checkbox" checked={selected.size > 0 && selected.size === rows.length} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                  <SortTh label="Date" k="posted" sort={queueSort} onSort={onQueueSort} first="desc" />
                  <SortTh label="Payee / description" k="payee" sort={queueSort} onSort={onQueueSort} />
                  <SortTh label="Account" k="account" sort={queueSort} onSort={onQueueSort} />
                  <SortTh label="Amount" k="amount" sort={queueSort} onSort={onQueueSort} align="right" />
                  <SortTh label="Category" k="category" sort={queueSort} onSort={onQueueSort} />
                  <SortTh label="Tax category" k="tax_category" sort={queueSort} onSort={onQueueSort} />
                  <SortTh label="Scope" k="scope" sort={queueSort} onSort={onQueueSort} title="Sorts the rows on this page" />
                  <SortTh label="Source" k="confidence" sort={queueSort} onSort={onQueueSort} first="desc" title="By confidence" />
                  <th className="px-2 py-2 text-left"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={10} className="px-2 py-6 text-center text-gray-500">{status === 'unreviewed' ? 'Nothing waiting for review.' : 'No rows.'}</td></tr>
                )}
                {viewRows.map((r) => {
                  const e = editFor(r);
                  return (
                    <tr key={r.id} className="border-b border-slate-800/60 align-top">
                      <td className="px-2 py-2"><input type="checkbox" checked={selected.has(r.id)} onChange={(ev) => { const next = new Set(selected); if (ev.target.checked) next.add(r.id); else next.delete(r.id); setSelected(next); }} /></td>
                      <td className="px-2 py-2 whitespace-nowrap text-gray-300">{(r.posted ?? '').slice(0, 10)}</td>
                      <td className="px-2 py-2 text-gray-100">
                        {r.payee || r.description || '(no description)'}
                        {r.payee && r.description && <div className="text-gray-500">{r.description}</div>}
                        {r.note && <div className="text-gray-500 italic">{r.note}</div>}
                      </td>
                      <td className="px-2 py-2 text-gray-400">{r.accountName}<div className="text-gray-600">{r.orgName}</div></td>
                      <td className={`px-2 py-2 text-right whitespace-nowrap ${r.amount.startsWith('-') ? 'text-gray-200' : 'text-emerald-300'}`}>{money(r.amount, r.currency)}</td>
                      <td className="px-2 py-2">
                        <select value={e.category} onChange={(ev) => setEdit(r.id, { category: ev.target.value })} className={inputClass}>
                          <option value="">(none)</option>
                          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <select value={e.taxCategory} onChange={(ev) => setEdit(r.id, { taxCategory: ev.target.value })} className={inputClass}>
                          {taxCategories.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                        </select>
                      </td>
                      <td className="px-2 py-2">
                        <select value={e.scope} onChange={(ev) => setEdit(r.id, { scope: ev.target.value })} className={inputClass}>
                          <option value="business">business</option>
                          <option value="personal">personal</option>
                        </select>
                      </td>
                      <td className={`px-2 py-2 whitespace-nowrap ${confidenceTone(r)}`}>
                        {r.reviewedAt ? 'you' : (r.suggestion?.by ?? r.categorySource)} {r.reviewedAt ? '' : `${Math.round(((r.categoryConfidence ?? r.suggestion?.confidence ?? 0) as number) * 100)}%`}
                      </td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        <label className="mr-2 text-gray-400"><input type="checkbox" className="mr-1" checked={e.always} onChange={(ev) => setEdit(r.id, { always: ev.target.checked })} disabled={!r.payee} title={r.payee ? `Always categorise "${r.payee}" this way` : 'No payee to build a rule from'} />always</label>
                        <button type="button" className="rounded bg-purple-600 px-2 py-1 text-xs text-white disabled:opacity-50" disabled={busy === r.id} onClick={() => confirm(r)}>
                          {busy === r.id ? '…' : r.reviewedAt ? 'Update' : 'Confirm'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {total > PAGE && (
            <div className="flex items-center justify-between mt-3 text-xs text-gray-400">
              <button type="button" className={btnSecondary} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
              <span>{offset + 1}–{Math.min(offset + PAGE, total)} of {total.toLocaleString()}</span>
              <button type="button" className={btnSecondary} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>Older →</button>
            </div>
          )}
        </section>
      )}

      {tab === 'rules' && (
        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <p className="text-xs text-gray-500 mb-3">A rule matches the payee (or description) and sets the category, tax category and scope on every future sync. Created from the review queue with the "always" checkbox.</p>
          {rules.length === 0 && <p className="text-xs text-gray-500">No rules yet.</p>}
          <table className="w-full text-xs">
            {rules.length > 0 && (
              <thead className="text-gray-400">
                <tr className="border-b border-slate-800">
                  <SortTh label="Match" k="pattern" sort={rulesSort} onSort={setRulesSort} />
                  <SortTh label="Category" k="category" sort={rulesSort} onSort={setRulesSort} />
                  <SortTh label="Tax category" k="tax" sort={rulesSort} onSort={setRulesSort} />
                  <SortTh label="Scope" k="scope" sort={rulesSort} onSort={setRulesSort} />
                  <SortTh label="Hits" k="hits" sort={rulesSort} onSort={setRulesSort} align="right" first="desc" />
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
            )}
            <tbody>
              {viewRules.map((rule) => (
                <tr key={rule.id} className="border-b border-slate-800/60">
                  <td className="px-2 py-2 text-gray-300">{rule.match_field} {rule.match_type} <span className="text-gray-100">“{rule.pattern}”</span></td>
                  <td className="px-2 py-2 text-gray-300">{rule.category}</td>
                  <td className="px-2 py-2 text-gray-400">{rule.tax_category ?? '—'}</td>
                  <td className="px-2 py-2 text-gray-400">{rule.scope ?? 'account scope'}</td>
                  <td className="px-2 py-2 text-right text-gray-400">{rule.hits}</td>
                  <td className="px-2 py-2 text-right"><button type="button" className="rounded border border-red-500/30 px-2 py-1 text-xs text-red-300" onClick={() => deleteRule(rule)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {tab === 'summary' && (
        <section className="rounded-lg border border-slate-700 bg-slate-900/50 p-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <select value={period} onChange={(e) => setPeriod(e.target.value)} className={inputClass}>
              {periodOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <select value={summaryScope} onChange={(e) => setSummaryScope(e.target.value as typeof summaryScope)} className={inputClass}>
              <option value="business">Business</option>
              <option value="personal">Personal</option>
              <option value="all">All</option>
            </select>
            <span className="text-xs text-gray-500">{GUESSED_TZ}</span>
            <div className="ml-auto flex gap-2">
              {['csv', 'pdf', 'html', 'json'].map((f) => (
                <button key={f} type="button" className={btnSecondary} onClick={() => download(f)}>{f.toUpperCase()}</button>
              ))}
            </div>
          </div>
          {summaryLoading && <p className="text-xs text-gray-500">Adding up…</p>}
          {summary && !summaryLoading && (
            <>
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 mb-3">{summary.notice}</div>
              <div className="grid gap-3 md:grid-cols-4 mb-4">
                {summary.totals.map((t) => (
                  <div key={t.currency} className="rounded border border-slate-800 p-3 text-sm">
                    <div className="text-gray-400 text-xs">{t.currency}</div>
                    <div className="text-emerald-300">Income {t.income}</div>
                    <div className="text-gray-200">Expenses {t.expenses}</div>
                    <div className="text-white font-semibold">Net {t.net}</div>
                    <div className="text-gray-500 text-xs">Excluded {t.excluded}</div>
                  </div>
                ))}
                {summary.totals.length === 0 && <div className="text-xs text-gray-500">No posted rows in this period and scope.</div>}
              </div>
              <table className="w-full text-xs">
                <thead className="text-gray-400">
                  <tr className="border-b border-slate-800">
                    <SortTh label="Tax category" k="label" sort={summarySort} onSort={setSummarySort} />
                    <SortTh label="Currency" k="currency" sort={summarySort} onSort={setSummarySort} />
                    <SortTh label="Total" k="total" sort={summarySort} onSort={setSummarySort} align="right" first="desc" />
                    <SortTh label="Rows" k="rows" sort={summarySort} onSort={setSummarySort} align="right" first="desc" />
                  </tr>
                </thead>
                <tbody>
                  {viewSummaryLines.map((l) => (
                    <tr key={`${l.taxCategory}-${l.currency}`} className={`border-b border-slate-800/60 ${l.excluded ? 'text-gray-500' : 'text-gray-200'}`}>
                      <td className="px-2 py-2">{l.label}</td>
                      <td className="px-2 py-2">{l.currency}</td>
                      <td className="px-2 py-2 text-right">{l.total}</td>
                      <td className="px-2 py-2 text-right">{l.rows}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">{summary.rows} rows · {summary.unreviewed} unreviewed · {summary.uncategorized} uncategorised. Confirm the queue to tighten these numbers before exporting.</p>
            </>
          )}

          <div className="mt-6 rounded border border-slate-800 bg-slate-950/40 p-3">
            <h3 className="text-sm font-semibold text-gray-200 mb-1">Email this pack</h3>
            <p className="text-xs text-gray-500 mb-2">Sends the {period} {summaryScope} pack (PDF and CSV) as attachments plus a download link that needs no login and expires in 14 days. Bank data leaves CoinPay when you press send.</p>
            <div className="grid gap-2 md:grid-cols-3">
              <input type="text" value={packTo} onChange={(e) => setPackTo(e.target.value)} placeholder="cpa@example.com, you@example.com" className={inputClass} />
              <input type="text" value={packMessage} onChange={(e) => setPackMessage(e.target.value)} placeholder="Optional note to the recipient" className={inputClass} />
              <button type="button" onClick={sendPack} disabled={packSending || !packTo.trim()} className={btnPrimary}>{packSending ? 'Sending…' : 'Send pack'}</button>
            </div>
          </div>

          <div id="weekly-digest" className="mt-4 rounded border border-slate-800 bg-slate-950/40 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="text-sm font-semibold text-gray-200">
                Weekly digest <span className="ml-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-gray-400">Default report</span>{' '}
                {digest?.active
                  ? <span className="text-emerald-300 font-normal text-xs">on · next {digest.nextRunAt ? new Date(digest.nextRunAt).toLocaleString() : 'soon'}</span>
                  : <span className="text-gray-500 font-normal text-xs">{digest || digestOptedOut ? 'off' : 'on by default once a bank is linked'}</span>}
              </h3>
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" role="switch" aria-label="Weekly digest on" checked={Boolean(digest?.active)} disabled={digestBusy || digestDays.length === 0} onChange={(e) => saveDigest(e.target.checked)} />
                {digest?.active ? 'On' : 'Off'}
              </label>
            </div>
            <p className="text-xs text-gray-500 mb-2">On for every account with a linked bank. Last seven days of your books, PDF and CSV attached ({GUESSED_TZ}). Every email has a one-click off link.</p>
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-300">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, day) => (
                <label key={label} className={`rounded border px-2 py-1 cursor-pointer ${digestDays.includes(day) ? 'border-purple-500 text-gray-100' : 'border-slate-700 text-gray-500'}`}>
                  <input type="checkbox" className="mr-1" checked={digestDays.includes(day)} onChange={(e) => setDigestDays(e.target.checked ? [...digestDays, day].sort() : digestDays.filter((d) => d !== day))} />{label}
                </label>
              ))}
              <select value={digestHour} onChange={(e) => setDigestHour(Number(e.target.value))} className={inputClass}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
              <select value={digestScope} onChange={(e) => setDigestScope(e.target.value as typeof digestScope)} className={inputClass}>
                <option value="business">Business</option><option value="personal">Personal</option><option value="all">All</option>
              </select>
              <input type="text" value={digestTo} onChange={(e) => setDigestTo(e.target.value)} placeholder="Recipients (default: your account email)" className={`${inputClass} w-72`} />
            </div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => saveDigest(true)} disabled={digestBusy || digestDays.length === 0} className={btnPrimary}>{digest?.active ? 'Save' : 'Turn on'}</button>
              {digest?.active && <button type="button" onClick={() => saveDigest(false)} disabled={digestBusy} className={btnSecondary}>Turn off</button>}
              {digest && <button type="button" onClick={sendDigestNow} disabled={digestBusy} className={btnSecondary}>Send now</button>}
              {digest?.lastSentAt && <span className="text-xs text-gray-500 self-center">last sent {new Date(digest.lastSentAt).toLocaleString()}</span>}
            </div>
          </div>

          <div id="business-report" className="mt-4 rounded border border-slate-800 bg-slate-950/40 p-3">
            <div className="flex items-center justify-between gap-2 mb-1">
              <h3 className="text-sm font-semibold text-gray-200">
                Business report <span className="ml-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-gray-400">Opt-in</span>{' '}
                {bizReport?.active
                  ? <span className="text-emerald-300 font-normal text-xs">on · next {bizReport.nextRunAt ? new Date(bizReport.nextRunAt).toLocaleString() : 'soon'}</span>
                  : <span className="text-gray-500 font-normal text-xs">off</span>}
              </h3>
              <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
                <input type="checkbox" role="switch" aria-label="Business report on" checked={Boolean(bizReport?.active)} disabled={bizBusy} onChange={(e) => toggleBusinessReport(e.target.checked)} />
                {bizReport?.active ? 'On' : 'Off'}
              </label>
            </div>
            <p className="text-xs text-gray-500 mb-2">Mondays 08:00 ({GUESSED_TZ}) to your account email: last week&apos;s payments and invoices through CoinPay, your business books, and your website traffic when CrawlProof is connected. Off unless you turn it on; every email has a one-click off link.</p>
            <div className="flex flex-wrap gap-2">
              {bizReport?.active && <button type="button" onClick={sendBusinessNow} disabled={bizBusy} className={btnSecondary}>Send now</button>}
              {bizReport?.lastSentAt && <span className="text-xs text-gray-500 self-center">last sent {new Date(bizReport.lastSentAt).toLocaleString()}</span>}
            </div>

            <div id="connect-crawlproof" className="mt-3 border-t border-slate-800 pt-3">
              <h4 className="text-xs font-semibold text-gray-300 mb-1">
                CrawlProof{' '}
                {crawlproof?.connected
                  ? <span className="text-emerald-300 font-normal">connected · {crawlproof.tokenPrefix}… · {crawlproof.sitesCount} site(s){crawlproof.lastError ? ` · last read failed: ${crawlproof.lastError}` : ''}</span>
                  : <span className="text-gray-500 font-normal">not connected</span>}
              </h4>
              {crawlproof?.connected ? (
                <button type="button" onClick={() => connectCrawlproof(false)} disabled={bizBusy} className={btnSecondary}>Disconnect</button>
              ) : (
                <>
                  <p className="text-xs text-gray-500 mb-2">
                    Adds visitors, bot and AI-agent hits, top pages and trend for your sites. In CrawlProof, generate an API token with <em>Read-only</em> ticked (<a href={crawlproof?.tokensUrl ?? 'https://crawlproof.com/dashboard/api-tokens'} target="_blank" rel="noreferrer" className="underline">CrawlProof API tokens</a>) and paste it here. Full-access tokens are refused; the token is stored encrypted and only reads your stats.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input type="password" autoComplete="off" value={cpToken} onChange={(e) => setCpToken(e.target.value)} placeholder="crp_…" className={`${inputClass} w-72`} />
                    <button type="button" onClick={() => connectCrawlproof(true)} disabled={bizBusy || !cpToken.trim()} className={btnPrimary}>Connect CrawlProof</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
