import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveMerchantBearer } from '@/lib/auth/bearer';
import { importWalletsToBusiness } from '@/lib/wallets/merchant-service';
import type { Cryptocurrency } from '@/lib/wallets/service';
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
 * POST /api/businesses/[id]/wallets/import
 * Import global wallets to a business
 *
 * Body:
 * - cryptocurrencies: string[] (optional) - specific cryptocurrencies to import
 * - all: boolean (optional) - import all global wallets
 *
 * If neither is provided, imports all active global wallets
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: businessId } = await params;
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

    const body = await request.json();
    const cryptocurrencies = body.all
      ? undefined
      : (body.cryptocurrencies as Cryptocurrency[] | undefined);

    const authz = await authorizeBusinessOwner(supabase, auth.merchantId!, businessId, 'wallet.manage');
    if (!authz.ok) {
      return NextResponse.json({ success: false, error: authz.error }, { status: authz.status });
    }

    const result = await importWalletsToBusiness(
      supabase,
      authz.ownerId,
      businessId,
      cryptocurrencies
    );

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        imported: result.imported,
        skipped: result.skipped,
        message: `Imported ${result.imported} wallet(s), skipped ${result.skipped} existing wallet(s)`,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Import wallets error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
