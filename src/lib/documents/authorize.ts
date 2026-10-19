import type { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { authorizeCatalog, serviceClient } from '@/lib/invoices/catalog';
import type { Capability } from '@/lib/auth/permissions';
import { fail, type DocumentRow } from './service';
import { loadDocument } from './workflow';

type Authorized = { ok: true; supabase: SupabaseClient; doc: DocumentRow; merchantId: string };

/** Load a document and check the caller holds `capability` on its business. */
export async function authorizeDocument(
  request: NextRequest,
  id: string,
  capability: Capability
): Promise<Authorized | { ok: false; response: NextResponse }> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, response: fail('Not found', 404) };
  const doc = await loadDocument(serviceClient(), id);
  if (!doc) return { ok: false, response: fail('Not found', 404) };
  const auth = await authorizeCatalog(request, doc.business_id, capability);
  if (!auth.ok) {
    // Do not reveal that the document exists in a business the caller cannot see.
    if (auth.response.status === 403 && capability === 'business.read') return { ok: false, response: fail('Not found', 404) };
    return { ok: false, response: auth.response };
  }
  return { ok: true, supabase: auth.supabase, doc, merchantId: auth.merchantId };
}
