import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const updates: Array<{ patch: Record<string, unknown>; ids: string[] }> = [];
let queueRows: Array<Record<string, unknown>> = [];

/** A chainable stand-in for the bits of the PostgREST builder acceptSuggestions uses. */
function builder() {
  const state: { patch?: Record<string, unknown>; ids?: string[] } = {};
  const b: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'not', 'gte', 'lt', 'or']) b[m] = () => b;
  b.is = () => (state.patch ? (updates.push({ patch: state.patch, ids: state.ids ?? [] }), Promise.resolve({ error: null })) : b);
  b.in = (col: string, ids: string[]) => {
    if (col === 'id') state.ids = ids;
    return b;
  };
  b.update = (patch: Record<string, unknown>) => {
    state.patch = patch;
    return b;
  };
  b.range = () => Promise.resolve({ data: queueRows, error: null });
  return b;
}

vi.mock('@/lib/supabase/server', () => ({ getSupabaseAdmin: () => ({ from: () => builder() }) }));
vi.mock('./summary', () => ({
  listAccounts: async () => [
    { id: 'biz', effective_scope: 'business' },
    { id: 'home', effective_scope: 'personal' },
  ],
}));
vi.mock('./audit', () => ({ audit: async () => undefined }));

import { acceptSuggestions, isQueueSort } from './books';

describe('acceptSuggestions', () => {
  beforeEach(() => {
    updates.length = 0;
  });

  it('approves each row with its category, else the suggestion, grouped by shared values', async () => {
    queueRows = [
      { id: 'a', account_id: 'biz', amount: '-10', category: 'software', tax_category: 'software_subscriptions', scope_override: null, suggested_category: null, suggested_tax_category: null },
      { id: 'b', account_id: 'biz', amount: '-12', category: 'software', tax_category: 'software_subscriptions', scope_override: null, suggested_category: null, suggested_tax_category: null },
      { id: 'c', account_id: 'home', amount: '-5', category: null, tax_category: null, scope_override: null, suggested_category: 'dining', suggested_tax_category: null },
      { id: 'd', account_id: 'home', amount: '-1', category: null, tax_category: null, scope_override: null, suggested_category: null, suggested_tax_category: null },
    ];
    const n = await acceptSuggestions('m');
    expect(n).toBe(4);
    const byIds = Object.fromEntries(updates.map((u) => [u.ids.join(','), u.patch]));
    expect(byIds['a,b']).toMatchObject({ category: 'software', tax_category: 'software_subscriptions' });
    expect(byIds['c']).toMatchObject({ category: 'dining', tax_category: 'personal' });
    expect(byIds['d']).toMatchObject({ category: null });
    for (const u of updates) expect(typeof u.patch.reviewed_at).toBe('string');
  });

  it('leaves rows nothing categorised in the queue when categorizedOnly', async () => {
    queueRows = [
      { id: 'c', account_id: 'home', amount: '-5', category: null, tax_category: null, scope_override: null, suggested_category: 'dining', suggested_tax_category: null },
      { id: 'd', account_id: 'home', amount: '-1', category: null, tax_category: null, scope_override: null, suggested_category: null, suggested_tax_category: null },
    ];
    const n = await acceptSuggestions('m', {}, { categorizedOnly: true });
    expect(n).toBe(1);
    expect(updates.flatMap((u) => u.ids)).toEqual(['c']);
  });
});

describe('isQueueSort', () => {
  it('accepts known columns only', () => {
    expect(isQueueSort('amount')).toBe(true);
    expect(isQueueSort('posted')).toBe(true);
    expect(isQueueSort('amount; drop table')).toBe(false);
    expect(isQueueSort(null)).toBe(false);
  });
});
