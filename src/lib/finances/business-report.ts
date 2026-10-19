import 'server-only';
import { getSupabaseAdmin } from '../supabase/server';
import { localDate, addDays } from './periods';
import { escapeHtml } from './render';
import { audit } from './audit';
import { signUnsubscribe } from './unsubscribe-token';
import type { EmailScheduleRow } from './schedules';
import type { CrawlProofReport } from '../integrations/crawlproof';

/**
 * The business report: OPT-IN, off for every merchant until its owner turns
 * it on. Never created by a backfill, and turning it off (the toggle, DELETE,
 * the one-click link in every email) deletes it.
 *
 * One email per recipient covering the previous seven local days:
 * - Books: the business-scope books for the week (when any account exists).
 * - CoinPay: settled crypto payments, invoices issued and paid, and what is
 *   still outstanding, across the merchant's own businesses.
 * - Website: the merchant's CrawlProof sites, only when CrawlProof is
 *   connected and answered; otherwise the section is left out.
 *
 * Every query is keyed by the schedule's merchant_id, so a merchant's report
 * can only ever describe that merchant.
 */

const SETTLED = ['confirmed', 'forwarded'];
const OUTSTANDING = ['sent', 'overdue'];

export interface MoneyByCurrency { currency: string; amount: number }

export interface CoinPayActivity {
  businesses: number;
  payments: { settled: number; settledUsd: number; created: number; expired: number };
  invoices: { issued: number; paid: number; paidTotals: MoneyByCurrency[]; outstanding: number; overdue: number; outstandingTotals: MoneyByCurrency[] };
}

export interface BusinessReportInput {
  label: string;
  appUrl: string;
  activity: CoinPayActivity;
  books: { totals: Array<{ currency: string; income: string; expenses: string; net: string }>; rows: number; unreviewed: number } | null;
  crawlproof: CrawlProofReport | null;
  crawlproofConnected: boolean;
  unsubscribeUrl: string;
  settingsUrl: string;
}

function addTo(list: MoneyByCurrency[], currency: string, amount: number) {
  const row = list.find((r) => r.currency === currency);
  if (row) row.amount += amount;
  else list.push({ currency, amount });
}

/** Sum CoinPay rows into the activity block. Pure, exported for tests. */
export function summarizeActivity(input: {
  businesses: number;
  payments: Array<{ status: string; amount: unknown; created_at: string | null; confirmed_at: string | null }>;
  invoices: Array<{ status: string; amount: unknown; currency: string | null; created_at: string | null; paid_at: string | null }>;
  outstanding: Array<{ status: string; amount: unknown; currency: string | null }>;
  start: string;
  end: string;
}): CoinPayActivity {
  const inWindow = (at: string | null) => Boolean(at) && at! >= input.start && at! < input.end;
  const activity: CoinPayActivity = {
    businesses: input.businesses,
    payments: { settled: 0, settledUsd: 0, created: 0, expired: 0 },
    invoices: { issued: 0, paid: 0, paidTotals: [], outstanding: 0, overdue: 0, outstandingTotals: [] },
  };
  for (const p of input.payments) {
    if (inWindow(p.created_at)) {
      activity.payments.created += 1;
      if (p.status === 'expired') activity.payments.expired += 1;
    }
    if (SETTLED.includes(p.status) && inWindow(p.confirmed_at ?? p.created_at)) {
      activity.payments.settled += 1;
      const amount = Number(p.amount);
      // payments.amount is USD; fee_amount is chain units and is never summed.
      if (Number.isFinite(amount)) activity.payments.settledUsd += amount;
    }
  }
  for (const inv of input.invoices) {
    if (inv.status !== 'draft' && inWindow(inv.created_at)) activity.invoices.issued += 1;
    if (inv.status === 'paid' && inWindow(inv.paid_at)) {
      activity.invoices.paid += 1;
      const amount = Number(inv.amount);
      if (Number.isFinite(amount)) addTo(activity.invoices.paidTotals, inv.currency || 'USD', amount);
    }
  }
  for (const inv of input.outstanding) {
    if (!OUTSTANDING.includes(inv.status)) continue;
    activity.invoices.outstanding += 1;
    if (inv.status === 'overdue') activity.invoices.overdue += 1;
    const amount = Number(inv.amount);
    if (Number.isFinite(amount)) addTo(activity.invoices.outstandingTotals, inv.currency || 'USD', amount);
  }
  activity.payments.settledUsd = Math.round(activity.payments.settledUsd * 100) / 100;
  for (const l of [activity.invoices.paidTotals, activity.invoices.outstandingTotals]) for (const r of l) r.amount = Math.round(r.amount * 100) / 100;
  return activity;
}

export async function loadCoinPayActivity(merchantId: string, start: string, end: string): Promise<CoinPayActivity> {
  const supabase = getSupabaseAdmin();
  const { data: biz, error: bizError } = await supabase.from('businesses').select('id').eq('merchant_id', merchantId).limit(500);
  if (bizError) throw new Error(`Could not read businesses: ${bizError.message}`);
  const ids = (biz ?? []).map((b) => b.id as string);
  if (ids.length === 0) return summarizeActivity({ businesses: 0, payments: [], invoices: [], outstanding: [], start, end });
  const [payments, invoices, outstanding] = await Promise.all([
    supabase
      .from('payments')
      .select('status, amount, created_at, confirmed_at')
      .in('business_id', ids)
      .or(`and(created_at.gte.${start},created_at.lt.${end}),and(confirmed_at.gte.${start},confirmed_at.lt.${end})`)
      .limit(10_000),
    supabase
      .from('invoices')
      .select('status, amount, currency, created_at, paid_at')
      .in('business_id', ids)
      .or(`and(created_at.gte.${start},created_at.lt.${end}),and(paid_at.gte.${start},paid_at.lt.${end})`)
      .limit(10_000),
    supabase.from('invoices').select('status, amount, currency').in('business_id', ids).in('status', OUTSTANDING).limit(10_000),
  ]);
  for (const r of [payments, invoices, outstanding]) if (r.error) throw new Error(`Could not read CoinPay activity: ${r.error.message}`);
  return summarizeActivity({
    businesses: ids.length,
    payments: (payments.data ?? []) as never,
    invoices: (invoices.data ?? []) as never,
    outstanding: (outstanding.data ?? []) as never,
    start,
    end,
  });
}

const fmtInt = (n: number | null) => (n === null ? 'n/a' : Math.round(n).toLocaleString('en-US'));
const fmtMoney = (list: MoneyByCurrency[]) =>
  list.length === 0 ? '0' : list.map((r) => `${r.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${r.currency}`).join(', ');
const cell = 'padding:4px 8px;border-bottom:1px solid #eee;font-size:13px';
const h3 = 'font-size:14px;margin:18px 0 6px';

function row(label: string, value: string): string {
  return `<tr><td style="${cell};color:#555">${escapeHtml(label)}</td><td style="${cell};text-align:right"><strong>${escapeHtml(value)}</strong></td></tr>`;
}

function trendText(pct: number | null): string {
  if (pct === null) return 'new';
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** The website section, or '' when there is nothing to show. Pure. */
export function renderCrawlProofSection(report: CrawlProofReport | null): string {
  if (!report || report.sites.length === 0) return '';
  const t = report.totals;
  const sites = report.sites
    .slice()
    .sort((a, b) => (b.visitors ?? 0) - (a.visitors ?? 0))
    .slice(0, 10)
    .map((s) => {
      const pages = s.top_pages.slice(0, 3).map((p) => `${escapeHtml(p.label)} (${fmtInt(p.value)})`).join(', ') || 'none yet';
      return `<tr><td style="${cell}">${escapeHtml(s.name)}</td><td style="${cell};text-align:right">${fmtInt(s.visitors)}</td><td style="${cell};text-align:right">${fmtInt(s.hits.bots)}</td><td style="${cell};text-align:right">${fmtInt(s.hits.ai)}</td><td style="${cell};text-align:right">${escapeHtml(trendText(s.trend.change_pct))}</td><td style="${cell};font-size:12px;color:#555">${pages}</td></tr>`;
    })
    .join('');
  const more = report.sites.length > 10 || report.truncated > 0 ? `<p style="font-size:12px;color:#555;margin:4px 0 0">Top 10 of ${report.sites.length + report.truncated} sites by visitors.</p>` : '';
  return `<h3 style="${h3}">Website (CrawlProof)</h3>
<table style="border-collapse:collapse;width:100%">${row('Human visitors', fmtInt(t.visitors))}${row('Page views', fmtInt(t.pageviews))}${row('Bot hits', fmtInt(t.bots))}${row('AI agent hits', fmtInt(t.ai))}</table>
<table style="border-collapse:collapse;width:100%;margin-top:8px"><tr><th style="${cell};text-align:left">Site</th><th style="${cell};text-align:right">Visitors</th><th style="${cell};text-align:right">Bots</th><th style="${cell};text-align:right">AI</th><th style="${cell};text-align:right">Trend</th><th style="${cell};text-align:left">Top pages</th></tr>${sites}</table>
${more}<p style="font-size:12px;color:#555;margin:4px 0 0">Trend compares the second half of the week with the first.</p>`;
}

export function businessReportSubject(input: Pick<BusinessReportInput, 'label' | 'activity'>): string {
  const p = input.activity.payments;
  return `CoinPay business report ${input.label}: ${p.settled} payment${p.settled === 1 ? '' : 's'}, $${p.settledUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The whole email body. Pure, exported for tests. */
export function renderBusinessReportHtml(input: BusinessReportInput): string {
  const a = input.activity;
  const base = input.appUrl.replace(/\/$/, '');
  const books = input.books
    ? `<h3 style="${h3}">Books (business)</h3><table style="border-collapse:collapse;width:100%">${input.books.totals
        .map((t) => `${row(`Income (${t.currency})`, t.income)}${row(`Expenses (${t.currency})`, t.expenses)}${row(`Net (${t.currency})`, t.net)}`)
        .join('') || row('Transactions', '0')}</table><p style="font-size:12px;color:#555;margin:4px 0 0">${input.books.rows} rows, ${input.books.unreviewed} not yet reviewed. <a href="${escapeHtml(`${base}/finances/books`)}">Review</a></p>`
    : '';
  const website = renderCrawlProofSection(input.crawlproof);
  const connectHint = !input.crawlproofConnected
    ? `<p style="font-size:12px;color:#555;margin:12px 0 0">Add your website traffic to this report: <a href="${escapeHtml(input.settingsUrl)}">connect CrawlProof</a>.</p>`
    : !website
      ? `<p style="font-size:12px;color:#555;margin:12px 0 0">Website section skipped: CrawlProof could not be read this time.</p>`
      : '';
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;color:#111">
<h2 style="font-size:18px;margin:0 0 4px">Business report</h2>
<p style="margin:0;color:#555;font-size:13px">${escapeHtml(input.label)} · ${a.businesses} business${a.businesses === 1 ? '' : 'es'}</p>
<h3 style="${h3}">Payments through CoinPay</h3>
<table style="border-collapse:collapse;width:100%">${row('Settled payments', String(a.payments.settled))}${row('Settled value (USD)', `$${a.payments.settledUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}${row('Checkouts started', String(a.payments.created))}${row('Expired unpaid', String(a.payments.expired))}</table>
<h3 style="${h3}">Invoices</h3>
<table style="border-collapse:collapse;width:100%">${row('Issued this week', String(a.invoices.issued))}${row('Paid this week', `${a.invoices.paid} (${fmtMoney(a.invoices.paidTotals)})`)}${row('Outstanding now', `${a.invoices.outstanding} (${fmtMoney(a.invoices.outstandingTotals)})`)}${row('Overdue now', String(a.invoices.overdue))}</table>
${books}
${website}
${connectHint}
<p style="font-size:12px;color:#666;margin:16px 0 0">You turned on this business report. <a href="${escapeHtml(input.settingsUrl)}">Settings</a> · <a href="${escapeHtml(input.unsubscribeUrl)}">Turn off business report</a></p>
</div>`;
}

export function businessReportLinks(appUrl: string, merchantId: string, to: string, secret?: string) {
  const base = appUrl.replace(/\/$/, '');
  const unsubscribeUrl = `${base}/api/finances/unsubscribe?t=${signUnsubscribe({ merchantId, kind: 'business_report', email: to }, secret)}`;
  return {
    unsubscribeUrl,
    settingsUrl: `${base}/finances/books#business-report`,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

/** Send one business report for a schedule: the previous seven local days. */
export async function sendBusinessReport(schedule: EmailScheduleRow, now: Date = new Date()): Promise<{ sent: string[]; failed: Array<{ to: string; error: string }>; crawlproof: boolean }> {
  const { appBaseUrl } = await import('./share');
  const { sendEmail } = await import('../email');
  const { loadCrawlProofForMerchant, getCrawlProofStatus } = await import('../integrations/crawlproof');
  const today = localDate(now, schedule.timezone);
  const from = addDays(today, -7);
  const label = `${from} to ${addDays(today, -1)}`;
  const { zonedMidnight } = await import('./periods');
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  const start = zonedMidnight(fy, fm, fd, schedule.timezone).toISOString();
  const end = zonedMidnight(ty, tm, td, schedule.timezone).toISOString();

  const activity = await loadCoinPayActivity(schedule.merchant_id, start, end);

  let books: BusinessReportInput['books'] = null;
  try {
    const { merchantHasAccounts } = await import('./schedules');
    if (await merchantHasAccounts(schedule.merchant_id)) {
      const { resolveBooksSelection } = await import('./emailing');
      const { booksSummary } = await import('./books');
      const { formatFixed } = await import('./decimal');
      const bounded = resolveBooksSelection({ from, to: today, timezone: schedule.timezone, scope: 'business' });
      const summary = await booksSummary(schedule.merchant_id, { start: bounded.start, end: bounded.effectiveEnd, scope: 'business' });
      books = {
        totals: summary.totals.map((t) => ({ currency: t.currency, income: formatFixed(t.income), expenses: formatFixed(t.expenses), net: formatFixed(t.net) })),
        rows: summary.rows,
        unreviewed: summary.unreviewed,
      };
    }
  } catch (error) {
    console.warn('[finances] business report: books unavailable', error instanceof Error ? error.message : error);
  }

  let connected = false;
  try {
    connected = (await getCrawlProofStatus(schedule.merchant_id)).connected;
  } catch {
    connected = false;
  }
  const crawlproof = connected ? await loadCrawlProofForMerchant(schedule.merchant_id, '1w') : null;

  const appUrl = appBaseUrl();
  const subject = businessReportSubject({ label, activity });
  const sent: string[] = [];
  const failed: Array<{ to: string; error: string }> = [];
  for (const to of schedule.recipients) {
    const links = businessReportLinks(appUrl, schedule.merchant_id, to);
    const html = renderBusinessReportHtml({ label, appUrl, activity, books, crawlproof, crawlproofConnected: connected, unsubscribeUrl: links.unsubscribeUrl, settingsUrl: links.settingsUrl });
    const result = await sendEmail({ to, subject, html, headers: links.headers });
    if (result.success) sent.push(to);
    else failed.push({ to, error: result.error ?? 'send failed' });
  }
  await audit(schedule.merchant_id, 'business_report.email', 'schedule', schedule.id, { recipients: schedule.recipients.length, sent: sent.length, failed: failed.length, crawlproof: crawlproof ? 'yes' : 'no' });
  return { sent, failed, crawlproof: Boolean(crawlproof) };
}
