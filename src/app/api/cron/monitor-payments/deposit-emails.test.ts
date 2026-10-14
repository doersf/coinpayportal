import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendEmail: mocks.send }));

import { sendDepositNotifications, type EmailStats } from './email-monitor';
import { claimOpsSlot } from '@/lib/ops/alerts';

type Row = Record<string, any>;

/**
 * A tiny in-memory PostgREST: enough filters for the deposit sweep, plus the
 * one constraint that matters — email_queue is unique on (payment_id, event_type).
 */
function database(tables: Record<string, Row[]>) {
  const client = { from(table: string) {
    const rows = (tables[table] ??= []);
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: Row | undefined;
    let mode: 'many' | 'single' | 'maybe' = 'many';
    const preds: Array<(r: Row) => boolean> = [];
    const query: any = {
      select() { return query; },
      insert(v: Row) { op = 'insert'; payload = v; return query; },
      update(v: Row) { op = 'update'; payload = v; return query; },
      eq(k: string, v: unknown) { preds.push((r) => r[k] === v); return query; },
      lt(k: string, v: string) { preds.push((r) => r[k] < v); return query; },
      gte(k: string, v: string) { preds.push((r) => r[k] >= v); return query; },
      in(k: string, vs: unknown[]) { preds.push((r) => vs.includes(r[k])); return query; },
      not(k: string, _op: string, _v: null) { preds.push((r) => r[k] != null); return query; },
      order() { return query; }, limit() { return query; },
      single() { mode = 'single'; return query; },
      maybeSingle() { mode = 'maybe'; return query; },
      then(resolve: (v: unknown) => unknown) {
        if (op === 'insert') {
          const row = { id: `${table}-${rows.length + 1}`, ...payload };
          const clash = table === 'email_queue'
            ? rows.some((r) => r.payment_id === row.payment_id && r.event_type === row.event_type)
            : table === 'ops_alerts' && rows.some((r) => r.key === row.key);
          if (clash) return Promise.resolve({ data: null, error: { code: '23505' } }).then(resolve);
          rows.push(row);
          return Promise.resolve({ data: [row], error: null }).then(resolve);
        }
        const hit = rows.filter((r) => preds.every((p) => p(r)));
        if (op === 'update') {
          hit.forEach((r) => Object.assign(r, payload));
          return Promise.resolve({ data: hit, error: null }).then(resolve);
        }
        if (mode === 'single') return Promise.resolve({ data: hit[0] ?? null, error: hit[0] ? null : { code: 'PGRST116' } }).then(resolve);
        if (mode === 'maybe') return Promise.resolve({ data: hit[0] ?? null, error: null }).then(resolve);
        return Promise.resolve({ data: hit, error: null }).then(resolve);
      },
    };
    return query;
  } };
  return { client: client as unknown as SupabaseClient, tables };
}

const NOW = new Date('2026-10-14T06:00:00.000Z');
const stats = (): EmailStats => ({ reminders_sent: 0, settlements_sent: 0, status_change_sent: 0, deposits_sent: 0, errors: 0 });

function fixture(overrides: { settings?: Row[]; confirmedAt?: string } = {}) {
  return database({
    payments: [{
      id: 'pay-1', business_id: 'biz-1', amount: 15, currency: 'USD', blockchain: 'USDC_POL',
      crypto_amount: '15.013003', crypto_currency: 'USDC', customer_paid_amount: null, tx_hash: null,
      confirmed_at: overrides.confirmedAt ?? '2026-10-13T11:05:02.037Z', status: 'forwarding',
    }],
    businesses: [{ id: 'biz-1', name: 'smshub.dev', merchant_id: 'm-1' }],
    merchants: [{ id: 'm-1', email: 'owner@example.com' }],
    merchant_settings: overrides.settings ?? [],
    email_queue: [],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.send.mockResolvedValue({ success: true });
});

describe('deposit emails to the merchant', () => {
  it('emails the merchant once, by default, when a payment is received', async () => {
    const db = fixture();
    const s = stats();

    await sendDepositNotifications(db.client, NOW, s);
    await sendDepositNotifications(db.client, NOW, s);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      to: 'owner@example.com',
      subject: expect.stringContaining('smshub.dev'),
      html: expect.stringContaining('15.013003'),
    }));
    expect(s.deposits_sent).toBe(1);
    expect(db.tables.email_queue).toEqual([expect.objectContaining({ payment_id: 'pay-1', event_type: 'payment.confirmed', status: 'sent' })]);
  });

  it('respects a merchant who turned email notifications off', async () => {
    const db = fixture({ settings: [{ merchant_id: 'm-1', notifications_enabled: true, email_notifications: false }] });
    await sendDepositNotifications(db.client, NOW, stats());
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send when another worker already claimed the email', async () => {
    const db = fixture();
    // The other worker's row lands between our read and our claim.
    const realFrom = db.client.from.bind(db.client);
    let reads = 0;
    (db.client as any).from = (table: string) => {
      if (table === 'email_queue' && reads++ === 0) {
        db.tables.email_queue.push({ id: 'other', payment_id: 'pay-1', event_type: 'payment.confirmed', status: 'pending' });
        return realFrom('email_queue').select().eq('payment_id', 'nobody');
      }
      return realFrom(table);
    };
    await sendDepositNotifications(db.client, NOW, stats());
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not email payments confirmed before the lookback window', async () => {
    const db = fixture({ confirmedAt: '2026-10-01T00:00:00.000Z' });
    await sendDepositNotifications(db.client, NOW, stats());
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe('operator alert throttle', () => {
  it('lets one caller through per interval', async () => {
    const db = database({ ops_alerts: [] });
    const hour = 60 * 60 * 1000;
    expect(await claimOpsSlot(db.client, 'k', hour, NOW)).toBe(true);
    expect(await claimOpsSlot(db.client, 'k', hour, new Date(NOW.getTime() + 10 * 60 * 1000))).toBe(false);
    expect(await claimOpsSlot(db.client, 'k', hour, new Date(NOW.getTime() + 2 * hour))).toBe(true);
  });
});
