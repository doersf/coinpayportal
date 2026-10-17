import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveMerchantBearer } from '@/lib/auth/bearer';
import {
  createWallet,
  listWallets,
  type CreateWalletInput,
} from '@/lib/wallets/service';
import { authorizeBusinessOwner } from '@/lib/auth/authz';

/**
 * Verify auth and get the merchant ID: a dashboard session, or an OAuth access
 * token whose grant carries the `merchant` scope (acting as its `sub`). The
 * ownership/role check below applies to both alike.
 */
async function verifyAuth(request: NextRequest) {
  const auth = resolveMerchantBearer(request.headers.get('authorization'));
  if (!auth.ok) {
    return { error: auth.error, status: auth.status };
  }
  return { merchantId: auth.merchantId };
}

/**
 * Helper to create Supabase client
 */
function createSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseKey);
}

/**
 * GET /api/businesses/[id]/wallets
 * List all wallets for a business
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await verifyAuth(request);
    if (auth.error) {
      return NextResponse.json(
        { success: false, error: auth.error },
        { status: auth.status }
      );
    }

    const supabase = createSupabaseClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const authz = await authorizeBusinessOwner(supabase, auth.merchantId!, id, 'business.read');
    if (!authz.ok) {
      return NextResponse.json({ success: false, error: authz.error }, { status: authz.status });
    }

    const result = await listWallets(supabase, id, authz.ownerId);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: true, wallets: result.wallets },
      { status: 200 }
    );
  } catch (error) {
    console.error('List wallets error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/businesses/[id]/wallets
 * Create a new wallet for a business
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const auth = await verifyAuth(request);
    if (auth.error) {
      return NextResponse.json(
        { success: false, error: auth.error },
        { status: auth.status }
      );
    }

    const body = await request.json();
    const input: CreateWalletInput = {
      cryptocurrency: body.cryptocurrency,
      wallet_address: body.wallet_address,
      is_active: body.is_active,
    };

    const supabase = createSupabaseClient();
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const authz = await authorizeBusinessOwner(supabase, auth.merchantId!, id, 'wallet.manage');
    if (!authz.ok) {
      return NextResponse.json({ success: false, error: authz.error }, { status: authz.status });
    }

    const result = await createWallet(supabase, id, authz.ownerId, input);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { success: true, wallet: result.wallet },
      { status: 201 }
    );
  } catch (error) {
    console.error('Create wallet error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}