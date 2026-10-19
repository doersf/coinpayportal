import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { resolveMerchant } from '@/lib/auth/merchant';
import { authorizeBusiness, listAccessibleBusinessIds } from '@/lib/auth/authz';

/**
 * GET /api/clients
 * List all clients for the authenticated merchant
 */
export async function GET(request: NextRequest) {
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    // A dashboard session, a business API key, or a merchant-scope OAuth token
    // (pay.agent sends invoices to clients it makes here).
    const auth = await resolveMerchant(supabase, request, { allowOAuth: true });
    if ('error' in auth) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const { searchParams } = new URL(request.url);
    const businessId = searchParams.get('business_id');

    // Team-aware: clients of every business the caller can access (owner + team),
    // not just ones they personally created.
    // An API key sees only its own business.
    const accessibleIds = auth.apiKeyBusinessId
      ? [auth.apiKeyBusinessId]
      : await listAccessibleBusinessIds(supabase, auth.merchantId);
    if (accessibleIds.length === 0) {
      return NextResponse.json({ success: true, clients: [] });
    }
    if (businessId && !accessibleIds.includes(businessId)) {
      return NextResponse.json({ success: false, error: 'Business not found' }, { status: 404 });
    }

    let query = supabase
      .from('clients')
      .select('*')
      .in('business_id', businessId ? [businessId] : accessibleIds)
      .order('created_at', { ascending: false });

    const { data: clients, error } = await query;

    if (error) {
      return NextResponse.json({ success: false, error: 'Failed to fetch clients' }, { status: 500 });
    }

    return NextResponse.json({ success: true, clients: clients || [] });
  } catch (error) {
    console.error('List clients error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/clients
 * Create a new client
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    // A dashboard session, a business API key, or a merchant-scope OAuth token
    // (pay.agent sends invoices to clients it makes here).
    const auth = await resolveMerchant(supabase, request, { allowOAuth: true });
    if ('error' in auth) {
      return NextResponse.json({ success: false, error: auth.error }, { status: auth.status });
    }

    const body = await request.json();
    const { business_id, name, email, phone, address, website, company_name } = body;

    if (!business_id || !email) {
      return NextResponse.json({ success: false, error: 'business_id and email are required' }, { status: 400 });
    }

    // Team-aware: creating a customer is a writer+ capability (writer/admin/owner).
    if (auth.apiKeyBusinessId) {
      if (auth.apiKeyBusinessId !== business_id) {
        return NextResponse.json({ success: false, error: 'Business not found' }, { status: 404 });
      }
    } else {
      const authz = await authorizeBusiness(supabase, { merchantId: auth.merchantId, via: auth.via }, business_id, 'customer.write');
      if (!authz.ok) {
        return NextResponse.json({ success: false, error: authz.error }, { status: authz.status });
      }
    }

    // Attribute the client to the business owner so owner-scoped views still see
    // clients a team member created.
    const { data: business } = await supabase
      .from('businesses')
      .select('merchant_id')
      .eq('id', business_id)
      .single();
    const clientOwnerId = business?.merchant_id ?? auth.merchantId;

    const { data: client, error } = await supabase
      .from('clients')
      .insert({
        user_id: clientOwnerId,
        business_id,
        name,
        email,
        phone,
        address,
        website,
        company_name,
      })
      .select()
      .single();

    if (error) {
      console.error('Create client DB error:', error.message);
      return NextResponse.json({ success: false, error: 'Failed to create client' }, { status: 400 });
    }

    return NextResponse.json({ success: true, client }, { status: 201 });
  } catch (error) {
    console.error('Create client error:', error);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
