import { describe, expect, it, vi } from 'vitest';
import {
  AAD,
  linkWithKey,
  newKey,
  open,
  seal,
  shareDocument,
  unlockDocumentsVault,
  uploadDocument,
  wrapVault,
} from '../src/documents.js';

const BUSINESS = '6f1c2d3e-0000-4000-8000-000000000001';

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    request: vi.fn(async (endpoint, options = {}) => {
      calls.push({ endpoint, options });
      const hit = routes.find(([prefix]) => endpoint.startsWith(prefix));
      if (!hit) throw new Error('unexpected ' + endpoint);
      return typeof hit[1] === 'function' ? hit[1](endpoint, options) : hit[1];
    }),
    requestForm: vi.fn(async (endpoint, form) => {
      calls.push({ endpoint, form });
      return { document: { id: JSON.parse(form.get('meta')).id } };
    }),
  };
}

describe('documents (end-to-end encrypted)', () => {
  it('unlocks with any passphrase version and uploads only ciphertext', async () => {
    const vaultKey = newKey();
    const v1 = { version: 1, ...(await wrapVault(BUSINESS, vaultKey, 'first passphrase')) };
    const v2 = { version: 2, ...(await wrapVault(BUSINESS, vaultKey, 'second passphrase')) };
    const client = fakeClient([['/documents/vault', { vaults: [v2, v1] }]]);
    const vault = await unlockDocumentsVault(client, { businessId: BUSINESS, passphrase: 'first passphrase' });
    expect(vault).toEqual({ vaultKey, version: 1 });
    await expect(unlockDocumentsVault(client, { businessId: BUSINESS, passphrase: 'nope' })).rejects.toThrow('Wrong passphrase');

    const secret = new TextEncoder().encode('Confidential: the price is 42');
    await uploadDocument(client, { businessId: BUSINESS, vault, bytes: secret, filename: '/tmp/deal.txt' });
    const form = client.calls.at(-1).form;
    const meta = JSON.parse(form.get('meta'));
    expect(meta).toMatchObject({ business_id: BUSINESS, filename: 'deal.txt', content_type: 'text/plain', bytes: secret.length, vault_version: 1 });
    expect(JSON.stringify(meta)).not.toContain(Buffer.from(vaultKey).toString('base64url'));
    const sealed = new Uint8Array(await form.get('file').arrayBuffer());
    expect(Buffer.from(sealed).toString()).not.toContain('Confidential');
    const dk = await open(vaultKey, Buffer.from(meta.wrapped_key, 'base64url'), AAD.documentKey(BUSINESS));
    expect(new TextDecoder().decode(await open(dk, sealed, AAD.original(meta.id)))).toBe('Confidential: the price is 42');
  }, 30_000);

  it('returns full links with the key but sends the key only when asked', async () => {
    const vaultKey = newKey();
    const dk = newKey();
    const wrapped = Buffer.from(await seal(vaultKey, dk, AAD.documentKey(BUSINESS))).toString('base64url');
    const client = fakeClient([
      ['/documents/doc-1/recipients', { status: 'out_for_signature', recipients: [{ id: 'r1', role: 'signer', email: 'a@x.com', url: 'https://c/sign/T' }] }],
      ['/documents/doc-1', { document: { id: 'doc-1', business_id: BUSINESS, wrapped_key: wrapped } }],
    ]);
    const vault = { vaultKey, version: 1 };
    const result = await shareDocument(client, 'doc-1', { recipients: [{ name: 'A', email: 'a@x.com' }], vault });
    expect(result.recipients[0].link).toBe(linkWithKey('https://c/sign/T', dk));
    expect(JSON.parse(client.calls.at(-1).options.body)).not.toHaveProperty('email_document_key');

    await shareDocument(client, 'doc-1', { recipients: [{ name: 'A', email: 'a@x.com' }], vault, emailKey: true });
    expect(JSON.parse(client.calls.at(-1).options.body).email_document_key).toBe(Buffer.from(dk).toString('base64url'));
  });
});
