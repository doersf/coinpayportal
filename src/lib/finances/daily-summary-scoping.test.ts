import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

/**
 * One merchant's daily summary describes that merchant's accounts and goes to
 * that schedule's recipients, never another's. Two merchants' fixtures sit
 * side by side; sending A's schedule must touch only A.
 */

const A = 'merchant-aaa';
const B = 'merchant-bbb';
const ACCOUNTS: Record<string, Array<{ id: string; name: string; currency: string }>> = {
  [A]: [{ id: 'acct-a1', name: 'Alice Checking', currency: 'USD' }],
  [B]: [{ id: 'acct-b1', name: 'Bob Checking', currency: 'USD' }],
};
const TX = [
  { account_id: 'acct-a1', posted: '2026-10-16', amount: -42, payee: 'ALICE COFFEE', description: null },
  { account_id: 'acct-b1', posted: '2026-10-16', amount: -999, payee: 'BOB SECRET VENDOR', description: null },
];

const calls = { accounts: [] as string[], due: [] as string[], spend: [] as string[], prefs: [] as string[], txAccountIds: [] as unknown[] };
const sent: Array<{ to: string; html: string; headers?: Record<string, string> }> = [];

vi.mock('./summary', () => ({
  listAccounts: async (merchantId: string) => { calls.accounts.push(merchantId); return ACCOUNTS[merchantId] ?? []; },
}));
vi.mock('./due-soon-load', () => ({
  loadDueSoon: async (merchantId: string) => {
    calls.due.push(merchantId);
    return {
      dueSoon: { today: '2026-10-17', timezone: 'America/Los_Angeles', horizonDays: 7, items: [], paid: [], missed: [], totals: { due: 0, overdue: 0, unpriced: 0 }, recurring: { charges: [], monthlyTotal: 0 } },
      summary: { primaryCurrency: 'USD', totals: [{ currency: 'USD', assets: 0, liabilities: 0, net: 0 }] },
    };
  },
}));
vi.mock('./spend-trend-load', () => ({
  loadSpendTrend: async (merchantId: string) => {
    calls.spend.push(merchantId);
    return { currency: 'USD', windowDays: 30, spent: 300, perDay: 10, previous: 0, change: null, runRate: 0, runRateBefore: 0, stopped: [], started: [], missed: [], topVendors: [], cuts: [] };
  },
}));
vi.mock('./daily-subscriptions', () => ({
  getEmailPreferences: async (merchantId: string) => { calls.prefs.push(merchantId); return { merchant_id: merchantId, daily_spend_target: merchantId === A ? 100 : 5, daily_summary_opted_out_at: null }; },
}));
vi.mock('./audit', () => ({ audit: async () => {} }));
vi.mock('../email', () => ({
  sendEmail: async (input: { to: string; html: string; headers?: Record<string, string> }) => { sent.push(input); return { success: true }; },
}));
vi.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: () => {
      let ids: unknown[] = [];
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'gte', 'order', 'limit', 'eq']) b[m] = () => b;
      b.in = (_c: string, v: unknown[]) => { ids = v; calls.txAccountIds.push(...v); return b; };
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: TX.filter((t) => ids.includes(t.account_id)), error: null });
      return b;
    },
  }),
}));

process.env.FINANCE_UNSUBSCRIBE_SECRET = (await import('crypto')).randomBytes(32).toString('hex');
const { sendDailySummary } = await import('./schedules');
const { verifyUnsubscribe } = await import('./unsubscribe-token');

function schedule(merchantId: string, recipients: string[]) {
  return { id: `sched-${merchantId}`, merchant_id: merchantId, kind: 'daily_summary' as const, weekdays: [0, 1, 2, 3, 4, 5, 6], hour: 7, timezone: 'America/Los_Angeles', recipients, scope: 'all' as const, formats: ['html'], active: true, last_sent_at: null, next_run_at: null, created_at: '', updated_at: '' };
}

beforeEach(() => {
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k].length = 0;
  sent.length = 0;
});

describe('daily summary scoping', () => {
  it('reads only the schedule merchant’s data and mails only its recipients', async () => {
    const result = await sendDailySummary(schedule(A, ['alice@example.com']), new Date('2026-10-17T14:00:00Z'));
    expect(result.sent).toEqual(['alice@example.com']);
    expect(new Set([...calls.accounts, ...calls.due, ...calls.spend, ...calls.prefs])).toEqual(new Set([A]));
    expect(calls.txAccountIds).toEqual(['acct-a1']);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('alice@example.com');
    expect(sent[0].html).toContain('ALICE COFFEE');
    expect(sent[0].html).not.toContain('BOB');
    expect(sent[0].html).toContain('Target $100.00/day');
  });

  it('gives each recipient its own unsubscribe link and the one-click headers', async () => {
    await sendDailySummary(schedule(A, ['alice@example.com', 'cpa@example.com']), new Date('2026-10-17T14:00:00Z'));
    expect(sent.map((s) => s.to)).toEqual(['alice@example.com', 'cpa@example.com']);
    for (const s of sent) {
      expect(s.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
      const url = /^<(.+)>$/.exec(s.headers?.['List-Unsubscribe'] ?? '')?.[1] ?? '';
      expect(url).toMatch(/\/api\/finances\/unsubscribe\?t=/);
      expect(s.html).toContain(url);
      expect(verifyUnsubscribe(new URL(url).searchParams.get('t'))).toEqual({ merchantId: A, kind: 'daily_summary', email: s.to });
    }
  });
});
