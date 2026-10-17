import { escapeHtml } from './render';
import type { DueItem, DueSoon } from './due-soon';
import type { SpendTrend } from './spend-trend';

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
  /** Spend & cuts: the 30-day trend and what recurring changed. Omitted when it could not be built. */
  spend?: SpendTrend;
  /** The owner's $/day spend target; null or omitted when none is set. */
  target?: number | null;
  /** This recipient's signed one-click unsubscribe link. */
  unsubscribeUrl?: string;
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

/** A signed whole percentage: "-12%", "+4%", "0%". */
export function percent(change: number): string {
  const rounded = Math.round(change * 100);
  return `${rounded > 0 ? '+' : ''}${rounded}%`;
}

/**
 * Spend & cuts. Down is good here, so a falling figure is green and a rising
 * one red; the reader is cutting costs and wants to see it land.
 */
export function renderSpendBlock(spend: SpendTrend, currency: string | null): string {
  const delta = spend.runRate - spend.runRateBefore;
  const trend = spend.change === null
    ? `<span style="color:${C.muted}">nothing to compare against yet</span>`
    : `<strong style="color:${spend.change <= 0 ? C.paid : C.overdue}">${spend.change <= 0 ? 'down' : 'up'} ${escapeHtml(percent(Math.abs(spend.change)).replace('+', ''))}</strong> from ${escapeHtml(money(spend.previous, currency))} the ${spend.windowDays} days before`;
  const row = (c: SpendTrend['stopped'][number], note: string) => `<tr><td style="padding:4px 8px;border-bottom:1px solid ${C.rule}">${escapeHtml(c.payee)}<div style="font-size:11px;color:${C.muted}">${escapeHtml(c.accountName)} · ${escapeHtml(c.cadence)} · ${escapeHtml(note)}</div></td>
<td style="padding:4px 8px;border-bottom:1px solid ${C.rule};text-align:right;white-space:nowrap">${escapeHtml(money(c.monthly, currency))}/mo</td></tr>`;
  const stopped = spend.stopped.length
    ? `<h4 style="font-size:13px;margin:12px 0 4px;color:${C.paid}">Stopped: saving ${escapeHtml(money(spend.stopped.reduce((s, c) => s + c.monthly, 0), currency))}/mo</h4>${table(spend.stopped.map((c) => row(c, `last charged ${c.lastSeen.slice(0, 10)}`)).join('\n'))}`
    : '';
  const started = spend.started.length
    ? `<h4 style="font-size:13px;margin:12px 0 4px;color:${C.overdue}">Started: adding ${escapeHtml(money(spend.started.reduce((s, c) => s + c.monthly, 0), currency))}/mo</h4>${table(spend.started.map((c) => row(c, `since about ${c.lastSeen.slice(0, 10)}`)).join('\n'))}`
    : '';
  const vendors = spend.topVendors.length
    ? `<h4 style="font-size:13px;margin:12px 0 4px">Where it went (${spend.windowDays} days)</h4>${table(spend.topVendors.map((v) => `<tr><td style="padding:3px 8px;border-bottom:1px solid ${C.rule}">${escapeHtml(v.name)}<span style="color:${C.muted};font-size:11px"> · ${v.count}×</span></td><td style="padding:3px 8px;border-bottom:1px solid ${C.rule};text-align:right">${escapeHtml(money(v.spent, currency))}</td></tr>`).join('\n'))}`
    : '';
  return `<h3 style="font-size:14px;margin:18px 0 6px">Spend &amp; cuts</h3>
<p style="margin:0 0 4px;font-size:13px">Spent <strong>${escapeHtml(money(spend.spent, currency))}</strong> in the last ${spend.windowDays} days, ${trend}.</p>
<p style="margin:0 0 4px;font-size:13px">Recurring bills and subscriptions: <strong>${escapeHtml(money(spend.runRate, currency))}/mo</strong>, ${delta === 0 ? 'unchanged' : `<strong style="color:${delta < 0 ? C.paid : C.overdue}">${delta < 0 ? '−' : '+'}${escapeHtml(money(Math.abs(delta), currency))}/mo</strong>`} from a month ago.</p>
<p style="margin:0 0 6px;font-size:11px;color:${C.muted}">Net of refunds; transfers, card payments, investments, income and debt payments left out. Fees and interest count.</p>
${renderCutsBlock(spend, currency)}
${stopped}
${started}
${vendors}`;
}

/** A target worth suggesting: 10% under the current rate, in round dollars ($5 steps above $50). */
export function suggestTarget(perDay: number): number | null {
  if (!(perDay > 1)) return null;
  const aim = perDay * 0.9;
  return aim >= 50 ? Math.floor(aim / 5) * 5 : Math.max(1, Math.floor(aim));
}

/**
 * The top line: "Spent $X/day over the last 30 days. Target $T/day. You're
 * $D/day over." Without a target, the rate and a suggested one. Plain text,
 * so it can be tested and reused in other surfaces.
 */
export function spendTargetLine(spend: Pick<SpendTrend, 'perDay' | 'windowDays'>, target: number | null | undefined, currency: string | null): string {
  const rate = `Spent ${money(spend.perDay, currency)}/day over the last ${spend.windowDays} days.`;
  if (target === null || target === undefined) {
    const suggestion = suggestTarget(spend.perDay);
    return suggestion === null
      ? `${rate} No daily target set.`
      : `${rate} No daily target set; try ${money(suggestion, currency)}/day: coinpay finances daily --target ${suggestion}`;
  }
  const diff = Math.round((spend.perDay - target) * 100) / 100;
  const verdict = diff === 0 ? "You're right on target." : `You're ${money(Math.abs(diff), currency)}/day ${diff > 0 ? 'over' : 'under'}.`;
  return `${rate} Target ${money(target, currency)}/day. ${verdict}`;
}

function renderTargetLine(spend: SpendTrend, target: number | null | undefined, currency: string | null): string {
  const line = escapeHtml(spendTargetLine(spend, target, currency));
  const over = target !== null && target !== undefined && spend.perDay > target;
  const under = target !== null && target !== undefined && spend.perDay <= target;
  const color = over ? C.overdue : under ? C.paid : C.text;
  return `<p style="margin:0 0 12px;font-size:15px;font-weight:600;color:${color}">${line.replace(/coinpay finances daily --target (\d+)/, '<code>coinpay finances daily --target $1</code>')}</p>`;
}

/** Top cuts: what to cancel, and the fees and interest to stop paying. */
export function renderCutsBlock(spend: SpendTrend, currency: string | null): string {
  if (!spend.cuts?.length) return '';
  const rows = spend.cuts
    .map((c) => {
      const fee = c.kind !== 'recurring';
      return `<tr><td style="padding:4px 8px;border-bottom:1px solid ${C.rule}">${fee ? `<strong style="color:${C.overdue}">` : ''}${escapeHtml(c.payee)}${fee ? '</strong>' : ''}<div style="font-size:11px;color:${C.muted}">${escapeHtml(c.accountName)} · ${escapeHtml(c.note)}</div></td>
<td style="padding:4px 8px;border-bottom:1px solid ${C.rule};text-align:right;white-space:nowrap">${escapeHtml(money(c.monthly, currency))}/mo</td></tr>`;
    })
    .join('\n');
  return `<h4 style="font-size:13px;margin:12px 0 4px">Top cuts</h4>
<p style="margin:0 0 4px;font-size:11px;color:${C.muted}">The biggest recurring charges you could cancel, and fees and interest you paid lately (red). Loan and card payments are not listed.</p>${table(rows)}`;
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
  if (input.spend) {
    const cur = input.position.currency;
    parts.push(`spent ${money(input.spend.spent, cur)} in ${input.spend.windowDays}d${input.spend.change === null ? '' : ` (${percent(input.spend.change)})`}`);
    if (input.target !== null && input.target !== undefined && input.spend.perDay !== undefined) {
      parts.push(`${money(input.spend.perDay, cur)}/day vs ${money(input.target, cur)} target`);
    }
  }
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
            (t) => `<tr><td style="padding:4px 8px;border-bottom:1px solid ${C.rule};white-space:nowrap;color:${C.muted}">${escapeHtml(t.posted ? t.posted.slice(0, 10) : 'pending')}</td>
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

  const spendBlock = input.spend ? renderSpendBlock(input.spend, cur) : '';

  const base = appUrl.replace(/\/$/, '');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:${C.text};max-width:640px">
<h2 style="margin:0 0 4px">Daily summary</h2>
<p style="margin:0 0 12px;color:${C.muted};font-size:13px">${escapeHtml(due.today)} · ${escapeHtml(due.timezone)} · every linked account, business and personal</p>
${input.spend ? renderTargetLine(input.spend, input.target, cur) : ''}
${headline}
${spendBlock}
${overdueBlock}
${upcomingBlock}
${awaitingBlock}
${paidBlock}
${missedBlock}
${activityBlock}
${positionBlock}
<p style="margin:18px 0 4px;font-size:13px"><a href="${escapeHtml(base)}/finances">Open Finances</a></p>
<p style="font-size:11px;color:${C.muted};margin:8px 0 0">Projected dates come from each charge's past cadence and run a day or two early against when banks post. Statement due days are the ones set on each account. Sent by CoinPay to this account's owner about this account's own linked banks and cards; every account with a linked bank or card gets one. ${input.unsubscribeUrl ? `<a href="${escapeHtml(input.unsubscribeUrl)}" style="color:${C.muted}">Unsubscribe</a> in one click, or turn` : 'Turn'} it off with <code>coinpay finances daily off</code>. Set a daily target with <code>coinpay finances daily --target 100</code>.</p>
</div>`;
}
