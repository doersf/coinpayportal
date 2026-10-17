import { describe, it, expect } from 'vitest';
import { signUnsubscribe, verifyUnsubscribe, unsubscribeSecret } from './unsubscribe-token';

const SECRET = 'test-secret-'.padEnd(48, 'x');
const claim = { merchantId: 'merchant-aaa', kind: 'daily_summary' as const, email: 'Alice@Example.com' };

describe('unsubscribe tokens', () => {
  it('round-trips, with the address lower-cased', () => {
    const token = signUnsubscribe(claim, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyUnsubscribe(token, SECRET)).toEqual({ ...claim, email: 'alice@example.com' });
  });

  it('cannot be re-pointed at another merchant or address', () => {
    const token = signUnsubscribe(claim, SECRET);
    const [, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ m: 'merchant-bbb', k: 'daily_summary', e: 'alice@example.com' })).toString('base64url');
    expect(verifyUnsubscribe(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(verifyUnsubscribe(token, 'another-secret'.padEnd(48, 'y'))).toBeNull();
  });

  it('rejects malformed input', () => {
    for (const bad of [null, '', 'abc', 'a.b.c', `${'a'.repeat(3000)}.b`, '.']) expect(verifyUnsubscribe(bad, SECRET)).toBeNull();
  });

  it('derives its key from ENCRYPTION_KEY when no dedicated secret is set, never the key itself', () => {
    const before = { e: process.env.ENCRYPTION_KEY, s: process.env.FINANCE_UNSUBSCRIBE_SECRET };
    process.env.ENCRYPTION_KEY = '3f9a1c7e5b2d4f60a8e1c3b5d7f90213a4c6e8f0b2d4f6a8c0e2b4d6f8a0c2e4';
    delete process.env.FINANCE_UNSUBSCRIBE_SECRET;
    try {
      const derived = unsubscribeSecret();
      expect(derived).toMatch(/^[0-9a-f]{64}$/);
      expect(derived).not.toBe(process.env.ENCRYPTION_KEY);
      expect(verifyUnsubscribe(signUnsubscribe(claim))).not.toBeNull();
      delete process.env.ENCRYPTION_KEY;
      expect(() => unsubscribeSecret()).toThrow(/ENCRYPTION_KEY/);
    } finally {
      if (before.e === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = before.e;
      if (before.s !== undefined) process.env.FINANCE_UNSUBSCRIBE_SECRET = before.s;
    }
  });
});
