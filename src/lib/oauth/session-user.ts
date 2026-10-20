/**
 * The CoinPay user signed in to this browser, for the OAuth authorize flow:
 * a Bearer JWT, or the `session` / `token` cookie set at login.
 */
import { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/auth/jwt';

export async function getSessionUser(request: NextRequest): Promise<{ id: string; email?: string } | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;

  const authHeader = request.headers.get('authorization');
  const candidates = [
    authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined,
    request.cookies.get('session')?.value || request.cookies.get('token')?.value,
  ];

  for (const token of candidates) {
    if (!token) continue;
    try {
      const decoded = verifyToken(token, secret);
      if (decoded?.userId) return { id: decoded.userId, email: decoded.email };
    } catch {
      // Try the next one
    }
  }
  return null;
}
