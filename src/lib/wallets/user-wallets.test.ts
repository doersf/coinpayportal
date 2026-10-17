import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth/authz', () => ({
  getAccessibleBusinessRoles: vi.fn(),
}));

import { listUserWallets } from './user-wallets';
import { getAccessibleBusinessRoles } from '@/lib/auth/authz';

const USER = 'user-123';
const BIZ = 'biz-abc';
const OTHER_BIZ = 'biz-xyz';

type TableResults = Record<string, { data: any[] | null; error: { message: string } | null }>;

/**
 * Minimal Supabase stub: `.select()` returns a thenable that also accepts the
 * `.eq()` / `.in()` filters the helper chains onto it.
 */
function createMockSupabase(tables: TableResults) {
  const calls: Record<string, { eq: any[][]; in: any[][] }> = {};

  const from = vi.fn((table: string) => {
    calls[table] ||= { eq: [], in: [] };
    const result = tables[table] ?? { data: [], error: null };

    const query: any = {
      eq: vi.fn((...args: any[]) => {
        calls[table].eq.push(args);
        return query;
      }),
      in: vi.fn((...args: any[]) => {
        calls[table].in.push(args);
        return query;
      }),
      then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
    };

    return { select: vi.fn(() => query) };
  });

  return { supabase: { from } as any, from, calls };
}

const accountWallet = (over: Partial<Record<string, any>> = {}) => ({
  id: 'mw-1',
  merchant_id: USER,
  cryptocurrency: 'BTC',
  wallet_address: 'bc1qaccount',
  label: 'Global BTC',
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...over,
});

const businessWallet = (over: Partial<Record<string, any>> = {}) => ({
  id: 'bw-1',
  business_id: BIZ,
  cryptocurrency: 'ETH',
  wallet_address: '0xbusiness',
  is_active: true,
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
  ...over,
});

describe('listUserWallets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (getAccessibleBusinessRoles as any).mockResolvedValue(new Map([[BIZ, 'owner']]));
  });

  it('merges account-level wallets with the wallets of accessible businesses', async () => {
    const { supabase } = createMockSupabase({
      merchant_wallets: { data: [accountWallet()], error: null },
      businesses: { data: [{ id: BIZ, name: 'Acme Inc' }], error: null },
      business_wallets: { data: [businessWallet()], error: null },
    });

    const result = await listUserWallets(supabase, USER);

    expect(result.success).toBe(true);
    expect(result.wallets).toHaveLength(2);

    const btc = result.wallets!.find((w) => w.cryptocurrency === 'BTC')!;
    expect(btc.source).toBe('account');
    expect(btc.business_id).toBeNull();

    const eth = result.wallets!.find((w) => w.cryptocurrency === 'ETH')!;
    expect(eth.source).toBe('business');
    expect(eth.business_id).toBe(BIZ);
    expect(eth.business_name).toBe('Acme Inc');
    expect(eth.wallet_address).toBe('0xbusiness');
  });

  it('returns business wallets even when the account has none — the reported bug', async () => {
    const { supabase } = createMockSupabase({
      merchant_wallets: { data: [], error: null },
      businesses: { data: [{ id: BIZ, name: 'Acme Inc' }], error: null },
      business_wallets: { data: [businessWallet()], error: null },
    });

    const result = await listUserWallets(supabase, USER);

    expect(result.success).toBe(true);
    expect(result.wallets).toHaveLength(1);
    expect(result.wallets![0].wallet_address).toBe('0xbusiness');
  });

  it('collapses the same address appearing in both stores, preferring the account row', async () => {
    const shared = 'bc1qshared';
    const { supabase } = createMockSupabase({
      merchant_wallets: { data: [accountWallet({ wallet_address: shared })], error: null },
      businesses: { data: [{ id: BIZ, name: 'Acme Inc' }], error: null },
      business_wallets: {
        // Imported copy — same coin, same address, different capitalisation.
        data: [businessWallet({ cryptocurrency: 'BTC', wallet_address: shared.toUpperCase() })],
        error: null,
      },
    });

    const result = await listUserWallets(supabase, USER);

    expect(result.wallets).toHaveLength(1);
    expect(result.wallets![0].source).toBe('account');
  });

  it('keeps distinct addresses for the same coin across businesses', async () => {
    (getAccessibleBusinessRoles as any).mockResolvedValue(
      new Map([
        [BIZ, 'owner'],
        [OTHER_BIZ, 'admin'],
      ])
    );

    const { supabase } = createMockSupabase({
      merchant_wallets: { data: [], error: null },
      businesses: {
        data: [
          { id: BIZ, name: 'Acme Inc' },
          { id: OTHER_BIZ, name: 'Other LLC' },
        ],
        error: null,
      },
      business_wallets: {
        data: [
          businessWallet(),
          businessWallet({ id: 'bw-2', business_id: OTHER_BIZ, wallet_address: '0xother' }),
        ],
        error: null,
      },
    });

    const result = await listUserWallets(supabase, USER);

    expect(result.wallets).toHaveLength(2);
    expect(result.wallets!.map((w) => w.business_name).sort()).toEqual(['Acme Inc', 'Other LLC']);
  });

  it('source=account returns only account wallets and never touches business tables', async () => {
    const { supabase, from } = createMockSupabase({
      merchant_wallets: { data: [accountWallet()], error: null },
      business_wallets: { data: [businessWallet()], error: null },
    });

    const result = await listUserWallets(supabase, USER, { source: 'account' });

    expect(result.wallets).toHaveLength(1);
    expect(result.wallets![0].source).toBe('account');
    expect(from).not.toHaveBeenCalledWith('business_wallets');
    expect(getAccessibleBusinessRoles).not.toHaveBeenCalled();
  });

  it('source=business excludes account wallets', async () => {
    const { supabase, from } = createMockSupabase({
      merchant_wallets: { data: [accountWallet()], error: null },
      businesses: { data: [{ id: BIZ, name: 'Acme Inc' }], error: null },
      business_wallets: { data: [businessWallet()], error: null },
    });

    const result = await listUserWallets(supabase, USER, { source: 'business' });

    expect(result.wallets).toHaveLength(1);
    expect(result.wallets![0].source).toBe('business');
    expect(from).not.toHaveBeenCalledWith('merchant_wallets');
  });

  it('scopes to a single business when business_id is given', async () => {
    (getAccessibleBusinessRoles as any).mockResolvedValue(
      new Map([
        [BIZ, 'owner'],
        [OTHER_BIZ, 'owner'],
      ])
    );

    const { supabase, calls } = createMockSupabase({
      businesses: { data: [{ id: BIZ, name: 'Acme Inc' }], error: null },
      business_wallets: { data: [businessWallet()], error: null },
    });

    const result = await listUserWallets(supabase, USER, { businessId: BIZ });

    expect(result.success).toBe(true);
    expect(calls.business_wallets.in).toEqual([['business_id', [BIZ]]]);
    expect(result.wallets![0].business_id).toBe(BIZ);
  });

  it('404s for a business the user cannot read', async () => {
    const { supabase } = createMockSupabase({});

    const result = await listUserWallets(supabase, USER, { businessId: OTHER_BIZ });

    expect(result.success).toBe(false);
    expect(result.status).toBe(404);
  });

  it('excludes businesses the role cannot read', async () => {
    (getAccessibleBusinessRoles as any).mockResolvedValue(new Map([[BIZ, 'nonsense-role']]));

    const { supabase, from } = createMockSupabase({
      merchant_wallets: { data: [], error: null },
    });

    const result = await listUserWallets(supabase, USER);

    expect(result.success).toBe(true);
    expect(result.wallets).toEqual([]);
    expect(from).not.toHaveBeenCalledWith('business_wallets');
  });

  it('rejects business_id combined with source=account', async () => {
    const { supabase } = createMockSupabase({});

    const result = await listUserWallets(supabase, USER, {
      businessId: BIZ,
      source: 'account',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
  });

  it('filters inactive wallets when activeOnly is set', async () => {
    const { supabase, calls } = createMockSupabase({
      merchant_wallets: { data: [accountWallet()], error: null },
      businesses: { data: [{ id: BIZ, name: 'Acme Inc' }], error: null },
      business_wallets: { data: [businessWallet()], error: null },
    });

    await listUserWallets(supabase, USER, { activeOnly: true });

    expect(calls.merchant_wallets.eq).toContainEqual(['is_active', true]);
    expect(calls.business_wallets.eq).toContainEqual(['is_active', true]);
  });

  it('surfaces a database error', async () => {
    const { supabase } = createMockSupabase({
      merchant_wallets: { data: null, error: { message: 'boom' } },
    });

    const result = await listUserWallets(supabase, USER);

    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('rejects a missing user id instead of querying for undefined', async () => {
    const { supabase, from } = createMockSupabase({});

    const result = await listUserWallets(supabase, '' as any);

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(from).not.toHaveBeenCalled();
  });

  describe('linked web wallets', () => {
    const links = [
      { id: 'link-1', wallet_id: 'ww-1', business_id: null, label: 'My web wallet', created_at: '2026-03-01T00:00:00Z' },
      { id: 'link-2', wallet_id: 'ww-2', business_id: BIZ, label: null, created_at: '2026-03-02T00:00:00Z' },
    ];
    const addresses = [
      { id: 'wa-1', wallet_id: 'ww-1', chain: 'SOL', address: 'SoLWebAddr0', derivation_index: 0, is_active: true },
      { id: 'wa-2', wallet_id: 'ww-1', chain: 'SOL', address: 'SoLWebAddr1', derivation_index: 1, is_active: true },
      { id: 'wa-3', wallet_id: 'ww-2', chain: 'BTC', address: 'bc1qweb', derivation_index: 0, is_active: true },
    ];

    it("includes the first address per linked wallet and chain as source 'web_wallet'", async () => {
      const { supabase, calls } = createMockSupabase({
        merchant_wallets: { data: [accountWallet()], error: null },
        businesses: { data: [], error: null },
        business_wallets: { data: [], error: null },
        wallet_account_links: { data: links, error: null },
        wallet_addresses: { data: addresses, error: null },
      });

      const result = await listUserWallets(supabase, USER);
      expect(result.success).toBe(true);
      const web = result.wallets!.filter((w) => w.source === 'web_wallet');
      expect(web.map((w) => w.wallet_address).sort()).toEqual(['SoLWebAddr0', 'bc1qweb']);
      expect(web.find((w) => w.wallet_address === 'bc1qweb')!.business_id).toBe(BIZ);
      expect(web.find((w) => w.wallet_address === 'SoLWebAddr0')!.label).toBe('My web wallet');
      expect(calls.wallet_account_links.eq).toContainEqual(['merchant_id', USER]);
    });

    it('prefers an account or business row for the same address', async () => {
      const { supabase } = createMockSupabase({
        merchant_wallets: { data: [accountWallet({ cryptocurrency: 'BTC', wallet_address: 'bc1qweb' })], error: null },
        wallet_account_links: { data: links, error: null },
        wallet_addresses: { data: addresses, error: null },
      });

      const result = await listUserWallets(supabase, USER, { source: 'all' });
      const btc = result.wallets!.filter((w) => w.wallet_address === 'bc1qweb');
      expect(btc).toHaveLength(1);
      expect(btc[0].source).toBe('account');
    });

    it('source=web_wallet returns only linked web wallets', async () => {
      const { supabase, from } = createMockSupabase({
        wallet_account_links: { data: links, error: null },
        wallet_addresses: { data: addresses, error: null },
      });

      const result = await listUserWallets(supabase, USER, { source: 'web_wallet' });
      expect(result.wallets!.every((w) => w.source === 'web_wallet')).toBe(true);
      expect(from).not.toHaveBeenCalledWith('merchant_wallets');
      expect(from).not.toHaveBeenCalledWith('business_wallets');
    });

    it('is not consulted for source=account or a business_id filter', async () => {
      const { supabase, from } = createMockSupabase({});
      await listUserWallets(supabase, USER, { source: 'account' });
      await listUserWallets(supabase, USER, { businessId: BIZ });
      expect(from).not.toHaveBeenCalledWith('wallet_account_links');
    });
  });
});
