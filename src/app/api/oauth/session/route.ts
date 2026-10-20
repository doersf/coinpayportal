/**
 * GET /api/oauth/session — who the consent screen is about to authorize as,
 * so it can say "Signed in as …" and offer a different account.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/oauth/session-user';

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  const headers = { 'cache-control': 'no-store' };
  if (!user) return NextResponse.json({ signed_in: false }, { headers });
  return NextResponse.json({ signed_in: true, email: user.email ?? null }, { headers });
}
