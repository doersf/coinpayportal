import 'server-only';
import { audit } from './audit';
import { signUnsubscribe } from './unsubscribe-token';
import { renderReportHtml, reportSubject, type GoalPeriod } from './goals';
import type { EmailScheduleRow } from './schedules';

/**
 * The opt-in goals report: every active goal's progress over the schedule's
 * cadence (daily, weekly, monthly or quarterly), on track or behind, and what
 * it takes per month to finish on time. One email per recipient, each with
 * its own one-click unsubscribe.
 */

export function goalsDigestLinks(appUrl: string, merchantId: string, to: string, secret?: string) {
  const base = appUrl.replace(/\/$/, '');
  const unsubscribeUrl = `${base}/api/finances/unsubscribe?t=${signUnsubscribe({ merchantId, kind: 'goals_digest', email: to }, secret)}`;
  return {
    unsubscribeUrl,
    settingsUrl: `${base}/finances/goals#goals-report`,
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

export async function sendGoalsDigest(schedule: EmailScheduleRow, now: Date = new Date()): Promise<{ sent: string[]; failed: Array<{ to: string; error: string }>; goals: number; period: GoalPeriod }> {
  const { goalsReport } = await import('./goals-store');
  const { sendEmail } = await import('../email');
  const { appBaseUrl } = await import('./share');
  const period: GoalPeriod = schedule.cadence ?? 'weekly';
  const report = await goalsReport(schedule.merchant_id, period, schedule.timezone, now);
  const appUrl = appBaseUrl();
  const subject = reportSubject(report);
  const sent: string[] = [];
  const failed: Array<{ to: string; error: string }> = [];
  for (const to of schedule.recipients) {
    const links = goalsDigestLinks(appUrl, schedule.merchant_id, to);
    const html = renderReportHtml(report, { appUrl, settingsUrl: links.settingsUrl, unsubscribeUrl: links.unsubscribeUrl });
    const result = await sendEmail({ to, subject, html, headers: links.headers });
    if (result.success) sent.push(to);
    else failed.push({ to, error: result.error ?? 'send failed' });
  }
  await audit(schedule.merchant_id, 'goals_digest.email', 'schedule', schedule.id, { recipients: schedule.recipients.length, sent: sent.length, failed: failed.length, goals: report.goals.length, period });
  return { sent, failed, goals: report.goals.length, period };
}
