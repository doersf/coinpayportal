import { describe, it, expect } from 'vitest';
import {
  resolveCheckoutWindow,
  paymentWindowMinutes,
  CHECKOUT_MAX_EXPIRATION_MINUTES,
  PAYMENT_EXPIRATION_MINUTES,
} from './service';

describe('resolveCheckoutWindow', () => {
  it('defaults to the 15-minute window when absent', () => {
    expect(resolveCheckoutWindow(undefined)).toEqual({ ok: true, minutes: PAYMENT_EXPIRATION_MINUTES });
    expect(resolveCheckoutWindow(null)).toEqual({ ok: true, minutes: 15 });
    expect(resolveCheckoutWindow('')).toEqual({ ok: true, minutes: 15 });
  });

  it('accepts a window inside the bounds', () => {
    expect(resolveCheckoutWindow(60)).toEqual({ ok: true, minutes: 60 });
    expect(resolveCheckoutWindow('90')).toEqual({ ok: true, minutes: 90 });
  });

  it('clamps rather than refuses an out-of-range number', () => {
    expect(resolveCheckoutWindow(1)).toEqual({ ok: true, minutes: 15 });
    expect(resolveCheckoutWindow(-30)).toEqual({ ok: true, minutes: 15 });
    expect(resolveCheckoutWindow(60 * 24)).toEqual({ ok: true, minutes: CHECKOUT_MAX_EXPIRATION_MINUTES });
  });

  it('refuses anything that is not a finite number', () => {
    for (const bad of ['soon', {}, [], true, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveCheckoutWindow(bad).ok).toBe(false);
    }
  });
});

describe('paymentWindowMinutes', () => {
  it('measures the window from the row timestamps', () => {
    expect(paymentWindowMinutes('2026-10-17T10:00:00Z', '2026-10-17T11:00:00Z')).toBe(60);
  });

  it('falls back to the default when a timestamp is missing or reversed', () => {
    expect(paymentWindowMinutes(null, '2026-10-17T11:00:00Z')).toBe(15);
    expect(paymentWindowMinutes('2026-10-17T11:00:00Z', '2026-10-17T10:00:00Z')).toBe(15);
  });
});
