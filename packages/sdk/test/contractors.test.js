/**
 * Contractors and pay runs: the request each SDK call makes, and the MCP
 * guarantee that no tool can send money.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addContractor,
  createContract,
  createPayRun,
  get1099Summary,
  listWorkItems,
  payPayRun,
  recordPayRunPayments,
  reviewWorkItem,
} from '../src/contractors.js';
import { handleMessage, TOOLS } from '../src/mcp.js';

function recorder(response = {}) {
  const calls = [];
  return {
    calls,
    request: async (endpoint, options = {}) => {
      calls.push({ endpoint, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
      return response;
    },
  };
}

describe('contractors SDK', () => {
  it('invites with snake_case fields and can skip the email', async () => {
    const c = recorder({ contractor: { id: 'c1' }, portal_url: 'u' });
    await addContractor(c, { businessId: 'b1', name: 'Ada', email: 'ada@x.io', jobTitle: 'Dev', sendInvite: false });
    expect(c.calls[0]).toEqual({ endpoint: '/contractors', method: 'POST', body: { business_id: 'b1', name: 'Ada', email: 'ada@x.io', job_title: 'Dev', send_invite: false } });
  });

  it('drafts a fixed contract', async () => {
    const c = recorder({ contract: { id: 'k1' } });
    await createContract(c, 'c 1', { title: 'Retainer', kind: 'fixed', rate: 2000, frequency: 'monthly', firstPayDate: '2026-11-01' });
    expect(c.calls[0]).toMatchObject({ endpoint: '/contractors/c%201/contracts', method: 'POST', body: { title: 'Retainer', kind: 'fixed', rate: 2000, frequency: 'monthly', first_pay_date: '2026-11-01' } });
  });

  it('lists and reviews work', async () => {
    const c = recorder({ work_items: [], work_item: {} });
    await listWorkItems(c, { businessId: 'b1', status: 'submitted' });
    await reviewWorkItem(c, 'w1', { action: 'reject', note: 'wrong week' });
    expect(c.calls[0].endpoint).toBe('/contractor-work-items?business_id=b1&status=submitted');
    expect(c.calls[1]).toEqual({ endpoint: '/contractor-work-items/w1', method: 'PATCH', body: { action: 'reject', note: 'wrong week' } });
  });

  it('drafts, pays and records pay runs', async () => {
    const c = recorder({ pay_run: {}, outcomes: [] });
    await createPayRun(c, { payDate: '2026-10-31' });
    await payPayRun(c, 'r1', { itemIds: ['i1'] });
    await recordPayRunPayments(c, 'r1', [{ itemId: 'i2', txHash: '0xabc123456' }]);
    await get1099Summary(c, { businessId: 'b1', year: 2026 });
    expect(c.calls.map((x) => [x.endpoint, x.method])).toEqual([
      ['/pay-runs', 'POST'],
      ['/pay-runs/r1/pay', 'POST'],
      ['/pay-runs/r1/pay', 'POST'],
      ['/contractors/1099?business_id=b1&year=2026', 'GET'],
    ]);
    expect(c.calls[1].body).toEqual({ method: 'wallet', item_ids: ['i1'] });
    expect(c.calls[2].body).toEqual({ method: 'manual', payments: [{ item_id: 'i2', tx_hash: '0xabc123456' }] });
  });
});

describe('contractor MCP tools', () => {
  it('are listed and none of them can pay a run', () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['contractor_list', 'contractor_work_review', 'pay_run_draft', 'contractor_1099_summary']));
    expect(names.some((n) => /pay_run_pay|payout|send/.test(n))).toBe(false);
  });

  it('drafting a run calls POST /pay-runs only', async () => {
    const c = recorder({ pay_run: { id: 'r1', number: 1 } });
    const ctx = { version: '0', home: mkdtempSync(join(tmpdir(), 'coinpay-mcp-')), log: () => {}, getClient: async () => c };
    const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pay_run_draft', arguments: { payDate: '2026-10-31' } } }, ctx);
    expect(c.calls).toEqual([{ endpoint: '/pay-runs', method: 'POST', body: { pay_date: '2026-10-31' } }]);
    expect(JSON.parse(res.result.content[0].text).pay_run.id).toBe('r1');
  });
});
