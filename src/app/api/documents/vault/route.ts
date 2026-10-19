import { NextRequest } from 'next/server';
import { authorizeCatalog } from '@/lib/invoices/catalog';
import { fail, json, readJson, vaultSchema, zodError } from '@/lib/documents/service';

export const dynamic = 'force-dynamic';

const VAULT_COLUMNS = 'version, kdf_salt, kdf_iterations, wrapped_key, created_at';

/**
 * GET /api/documents/vault?business_id= — every wrapping of the business's
 * documents vault key, newest first. All of it is ciphertext: unwrapping
 * needs the passphrase, which never leaves the browser.
 */
export async function GET(request: NextRequest) {
  const auth = await authorizeCatalog(request, new URL(request.url).searchParams.get('business_id'), 'business.read');
  if (!auth.ok) return auth.response;
  const { data, error } = await auth.supabase
    .from('document_vaults')
    .select(VAULT_COLUMNS)
    .eq('business_id', auth.businessId)
    .order('version', { ascending: false });
  if (error) return fail('Failed to load the documents vault', 500);
  return json({ success: true, vaults: data ?? [] });
}

/**
 * POST /api/documents/vault { business_id, kdf_salt, kdf_iterations, wrapped_key }
 * Set up the vault, or add a wrapping under a new passphrase. Versions are
 * never replaced, so nothing done here can make an existing document unreadable.
 */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  if (!body) return fail('Expected a JSON object', 400);
  const parsed = vaultSchema.safeParse(body);
  if (!parsed.success) return fail(zodError(parsed.error), 400);
  const auth = await authorizeCatalog(request, parsed.data.business_id, 'settings.manage');
  if (!auth.ok) return auth.response;
  const { data: latest } = await auth.supabase
    .from('document_vaults')
    .select('version')
    .eq('business_id', auth.businessId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const { business_id: _b, ...fields } = parsed.data;
  const { data, error } = await auth.supabase
    .from('document_vaults')
    .insert({ ...fields, business_id: auth.businessId, version: (latest?.version ?? 0) + 1, created_by: auth.merchantId })
    .select(VAULT_COLUMNS)
    .single();
  if (error?.code === '23505') return fail('Someone else changed the vault at the same moment; try again', 409);
  if (error || !data) return fail('Failed to save the documents vault', 500);
  return json({ success: true, vault: data }, 201);
}
