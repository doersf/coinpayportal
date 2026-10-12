import { escapeHtml } from './render';
import type { DueItem, DueSoon } from './due-soon';

/**
 * The daily summary email: what is due, what is overdue, what arrived since
 * yesterday, and where the balance sheet stands — across every account.
 *
 * Rendering is pure (this file) so the whole email is testable from
 * fixtures; `daily-summary-send.ts` gathers the data and sends it.
 */

export interface DailyActivity {
  /** Rows imported since the last summary (or the last 24 hours). */
  count: number;
  moneyIn: number;
  moneyOut: number;
  /** Largest debits among them, already sorted. */
  largest: Array<{ payee: string; amount: number; accountName: string; posted: string }>;
  since: string;
}

export interface DailyPosition {
  currency: string | null;
  assets: number;
  liabilities: number;
  net: number;
  recurringMonthly: number;
  recurringCount: number;
}

export interface DailySummaryInput {
  due: DueSoon;
  activity: DailyActivity;
  position: DailyPosition;
  appUrl: string;
}

const C = {
  text: '#111',
  muted: '#666',
  rule: '#e5e5e5',
  overdue: '#b42318',
  overdueBg: '#fef3f2',
  today: '#b54708',
  todayBg: '#fffaeb',
  soon: '#175cd3',
  paid: '#067647',
};

export function money(amount: number, currency: string | null = 'USD'): string {
  const code = currency || 'USD';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(amount);
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

/** "Today", "Tomorrow", "Yesterday", "3 days late" or "Wed Oct 14". */
export function whenLabel(item: Pick<DueItem, 'daysUntil' | 'dueOn'>): string {
  if (item.daysUntil === 0) return 'Today';
  if (item.daysUntil === 1) return 'Tomorrow';
  if (item.daysUntil === -1) return 'Yesterday';
  if (item.daysUntil < 0) return `${-item.daysUntil} days late`;
  const [y, m, d] = item.dueOn.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function amountText(item: DueItem, currency: string | null): string {
  if (item.amount !== null) return money(item.amount, currency);
  return item.owed !== null ? `balance ${money(item.owed, currency)}` : 'statement balance';
}

export function dailySummarySubject(input: DailySummaryInput): string {
  const { due } = input;
  const overdue = due.items.filter((i) => i.status === 'overdue').length;
  const today = due.items.filter((i) => i.status === 'today').length;
  const parts: string[] = [];
  if (overdue) parts.push(`${overdue} overdue`);
  if (today) parts.push(`${today} due today`);
  parts.push(`${money(due.totals.due, input.position.currency)} due in ${due.horizonDays} days`);
  return `CoinPay daily summary ${due.today}: ${parts.join(', ')}`;
}

function dueRows(items: DueItem[], currency: string | null): string {
  return items
    .map((i) => {
      const color = i.status === 'overdue' ? C.overdue : i.status === 'today' ? C.today : i.status === 'paid' ? C.paid : C.text;
      const bg = i.status === 'overdue' ? C.overdueBg : i.status === 'today' ? C.todayBg : 'transparent';
      const label = i.status === 'paid' ? 'Paid' : i.status === 'awaiting' ? `${whenLabel(i)}?` : whenLabel(i);
      const tag = i.source === 'scheduled' ? 'statement due' : i.isDebtService ? `${i.cadence} payment` : i.cadence;
      return `<tr style="background:${bg}">
<td style="padding:6px 8px;border-bottom:1px solid ${C.rule};color:${color};white-space:nowrap;font-weight:600">${escapeHtml(label)}</td>
<td style="padding:6px 8px;border-bottom:1px solid ${C.rule}">${escapeHtml(i.payee)}<div style="font-size:11px;color:${C.muted}">${escapeHtml(i.accountName)} · ${escapeHtml(tag)} · ${escapeHtml(i.scope)}</div></td>
<td style="padding:6px 8px;border-bottom:1px solid ${C.rule};text-align:right;white-space:nowrap">${escapeHtml(amountText(i, currency))}</td>
</tr>`;
    })
    .join('\n');
}

function table(rows: string): string {
  return `<table style="border-collapse:collapse;width:100%;font-size:13px">${rows}</table>`;
}

export function renderDailySummaryHtml(input: DailySummaryInput): string {
  const { due, activity, position, appUrl } = input;
  const cur = position.currency;
  const overdue = due.items.filter((i) => i.status === 'overdue');
  const upcoming = due.items.filter((i) => i.status !== 'overdue' && i.status !== 'awaiting');
  const awaiting = due.items.filter((i) => i.status === 'awaiting');

  const headline = `<p style="margin:0 0 14px;font-size:15px">
<strong>${escapeHtml(money(due.totals.due, cur))}</strong> due across ${due.items.length} charge${due.items.length === 1 ? '' : 's'} in the next ${due.horizonDays} days${due.totals.overdue > 0 ? `, <strong style="color:${C.overdue}">${escapeHtml(money(due.totals.overdue, cur))} overdue</strong>` : ''}${due.totals.unpriced ? ` (plus ${due.totals.unpriced} statement balance${due.totals.unpriced === 1 ? '' : 's'})` : ''}.</p>`;

  const overdueBlock = overdue.length
    ? `<h3 style="font-size:14px;margin:16px 0 6px;color:${C.overdue}">Overdue</h3>${table(dueRows(overdue, cur))}`
    : '';
  const upcomingBlock = `<h3 style="font-size:14px;margin:16px 0 6px">Due soon</h3>${
    upcoming.length ? table(dueRows(upcoming, cur)) : `<p style="margin:0;color:${C.muted};font-size:13px">Nothing due in the next ${due.horizonDays} days.</p>`
  }`;
  const awaitingBlock = awaiting.length
    ? `<h3 style="font-size:14px;margin:16px 0 6px">Not posted yet</h3>
<p style="margin:0 0 6px;font-size:12px;color:${C.muted}">Expected already, but these accounts have not reported anything since, so they may well be paid. Not counted above.</p>${table(dueRows(awaiting, cur))}`
    : '';
  const paidBlock = due.paid.length
    ? `<h3 style="font-size:14px;margin:16px 0 6px;color:${C.paid}">Already paid this cycle</h3>${table(dueRows(due.paid, cur))}`
    : '';
  const missedBlock = due.missed.length
    ? `<h3 style="font-size:14px;margin:16px 0 6px">Not seen lately</h3>
<p style="margin:0 0 6px;font-size:12px;color:${C.muted}">Recurring charges that should have posted by now and have not: cancelled, moved to another card, or a feed that is behind.</p>
<ul style="margin:0;padding-left:18px;font-size:13px">${due.missed
        .slice(0, 10)
        .map((m) => `<li>${escapeHtml(m.payee)} ${escapeHtml(money(m.amount, cur))}, expected ${escapeHtml(m.expectedOn)}, last ${escapeHtml(m.lastSeen)} on ${escapeHtml(m.accountName)}</li>`)
        .join('')}</ul>`
    : '';

  const activityBlock = `<h3 style="font-size:14px;margin:18px 0 6px">New since ${escapeHtml(activity.since.slice(0, 16).replace('T', ' '))} UTC</h3>
<p style="margin:0 0 6px;font-size:13px">${activity.count} transaction${activity.count === 1 ? '' : 's'} imported · in ${escapeHtml(money(activity.moneyIn, cur))} · out ${escapeHtml(money(activity.moneyOut, cur))} <span style="color:${C.muted};font-size:11px">(gross, transfers and card payments included)</span></p>
${
  activity.largest.length
    ? table(
        activity.largest
          .map(
            (t) => `<tr><td style="padding:4px 8px;border-bottom:1px solid ${C.rule};white-space:nowrap;color:${C.muted}">${escapeHtml(t.posted.slice(0, 10))}</td>
<td style="padding:4px 8px;border-bottom:1px solid ${C.rule}">${escapeHtml(t.payee)}<div style="font-size:11px;color:${C.muted}">${escapeHtml(t.accountName)}</div></td>
<td style="padding:4px 8px;border-bottom:1px solid ${C.rule};text-align:right">${escapeHtml(money(t.amount, cur))}</td></tr>`,
          )
          .join('\n'),
      )
    : ''
}`;

  const positionBlock = `<h3 style="font-size:14px;margin:18px 0 6px">Position</h3>
<table style="border-collapse:collapse;font-size:13px">
<tr><td style="padding:2px 12px 2px 0;color:${C.muted}">Assets</td><td style="text-align:right">${escapeHtml(money(position.assets, cur))}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:${C.muted}">Debt</td><td style="text-align:right">${escapeHtml(money(position.liabilities, cur))}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:${C.muted}">Net</td><td style="text-align:right;font-weight:600">${escapeHtml(money(position.net, cur))}</td></tr>
<tr><td style="padding:2px 12px 2px 0;color:${C.muted}">Recurring</td><td style="text-align:right">${escapeHtml(money(position.recurringMonthly, cur))}/mo across ${position.recurringCount} charges</td></tr>
</table>`;

  const base = appUrl.replace(/\/$/, '');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${C.text};max-width:640px">
<h2 style="margin:0 0 4px">Daily summary</h2>
<p style="margin:0 0 12px;color:${C.muted};font-size:13px">${escapeHtml(due.today)} · ${escapeHtml(due.timezone)} · every linked account, business and personal</p>
${headline}
${overdueBlock}
${upcomingBlock}
${awaitingBlock}
${paidBlock}
${missedBlock}
${activityBlock}
${positionBlock}
<p style="margin:18px 0 4px;font-size:13px"><a href="${escapeHtml(base)}/finances">Open Finances</a></p>
<p style="font-size:11px;color:${C.muted};margin:8px 0 0">Projected dates come from each charge's past cadence and run a day or two early against when banks post. Statement due days are the ones set on each account. Sent by CoinPay because a daily summary is scheduled on this account; turn it off with <code>coinpay finances daily --off</code> or DELETE /api/finances/email-schedules?kind=daily_summary.</p>
</div>`;
}
