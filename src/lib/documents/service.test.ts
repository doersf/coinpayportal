import { describe, expect, it } from 'vitest';
import { contentTypeFor, signedFilename, cleanFilename, isSkippedPath, normalizeFolder, SEAL_OVERHEAD } from './types';
import { hashToken, newSignToken, SIGN_TOKEN_PATTERN, shareSchema, signActionSchema, statusFor, uploadMetaSchema, versionMetaSchema } from './service';

const signer = (status: string, revoked = false) => ({ role: 'signer' as const, status: status as 'pending', revoked_at: revoked ? '2026-10-19T00:00:00Z' : null });
const viewer = { role: 'viewer' as const, status: 'pending' as const, revoked_at: null };

describe('documents service', () => {
  it('derives the document status from who has it', () => {
    expect(statusFor('draft', [])).toBe('draft');
    expect(statusFor('draft', [viewer])).toBe('shared');
    expect(statusFor('shared', [viewer, signer('pending')])).toBe('out_for_signature');
    expect(statusFor('out_for_signature', [signer('signed'), signer('viewed')])).toBe('out_for_signature');
    expect(statusFor('out_for_signature', [signer('signed'), signer('pending', true)])).toBe('completed');
    expect(statusFor('out_for_signature', [signer('pending', true)])).toBe('draft');
    for (const terminal of ['completed', 'declined', 'voided'] as const) expect(statusFor(terminal, [signer('pending')])).toBe(terminal);
  });

  it('stores only a hash of each link token', () => {
    const token = newSignToken();
    expect(token).toMatch(SIGN_TOKEN_PATTERN);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  it('types files by extension and names the signed copy', () => {
    expect(contentTypeFor('Contract.PDF')).toBe('application/pdf');
    expect(contentTypeFor('terms.docx')).toMatch(/wordprocessingml/);
    // Anything else is an opaque, download-only file: the server only ever has ciphertext.
    expect(contentTypeFor('payload.exe')).toBe('application/octet-stream');
    expect(contentTypeFor('page.html')).toBe('application/octet-stream');
    expect(contentTypeFor('Makefile')).toBe('application/octet-stream');
    expect(signedFilename('agreement.docx')).toBe('agreement-signed.pdf');
    expect(cleanFilename('../../etc/"pass"wd')).toBe('passwd');
    expect(SEAL_OVERHEAD).toBe(29);
  });

  it('normalizes folder paths and refuses traversal', () => {
    expect(normalizeFolder('contracts/2026/acme')).toBe('contracts/2026/acme');
    expect(normalizeFolder('/contracts//2026/ ./acme/')).toBe('contracts/2026/acme');
    expect(normalizeFolder('contracts\\\\2026')).toBe('contracts/2026');
    expect(normalizeFolder('')).toBeNull();
    expect(normalizeFolder('/')).toBeNull();
    expect(normalizeFolder(null)).toBeNull();
    expect(() => normalizeFolder('a/../../etc')).toThrow(/\.\./);
    expect(() => normalizeFolder(Array(21).fill('d').join('/'))).toThrow(/levels/);
  });

  it('skips hidden files and dependency trees in folder uploads', () => {
    expect(isSkippedPath('site/.git/config')).toBe(true);
    expect(isSkippedPath('.DS_Store')).toBe(true);
    expect(isSkippedPath('app/node_modules/x/index.js')).toBe(true);
    expect(isSkippedPath('contracts/2026/nda.pdf')).toBe(false);
  });

  it('refuses a signature without consent or a document fingerprint', () => {
    const base = { action: 'sign', signature_name: 'Ada Lovelace', document_sha256: 'b'.repeat(64), consent: true };
    expect(signActionSchema.safeParse(base).success).toBe(true);
    expect(signActionSchema.safeParse({ ...base, consent: false }).success).toBe(false);
    expect(signActionSchema.safeParse({ ...base, document_sha256: undefined }).success).toBe(false);
    expect(signActionSchema.safeParse({ ...base, signature_image: 'data:image/svg+xml;base64,AAAA' }).success).toBe(false);
    expect(signActionSchema.safeParse({ action: 'decline', reason: '' }).success).toBe(false);
  });

  it('accepts only a wrapped key, never a raw one, on upload', () => {
    const meta = {
      id: '6f1c2d3e-0000-4000-8000-000000000002',
      business_id: '6f1c2d3e-0000-4000-8000-000000000001',
      title: 'Agreement',
      filename: 'agreement.pdf',
      content_type: 'application/pdf',
      bytes: 1000,
      sha256: 'c'.repeat(64),
      wrapped_key: 'A'.repeat(82),
      vault_version: 1,
    };
    expect(uploadMetaSchema.safeParse(meta).success).toBe(true);
    expect(uploadMetaSchema.safeParse({ ...meta, content_type: 'text/html' }).success).toBe(false);
    expect(uploadMetaSchema.safeParse({ ...meta, document_key: 'A'.repeat(43) }).success).toBe(false);
  });

  it('invites editors and validates new versions', () => {
    const editor = shareSchema.safeParse({ recipients: [{ name: 'E', email: 'e@example.com', role: 'editor' }] });
    expect(editor.success && editor.data.recipients[0].role).toBe('editor');
    expect(shareSchema.safeParse({ recipients: [{ name: 'E', email: 'e@example.com', role: 'owner' }] }).success).toBe(false);
    // Editors count like viewers for status: they never block completion.
    expect(statusFor('draft', [{ role: 'editor', status: 'pending', revoked_at: null }])).toBe('shared');
    expect(statusFor('out_for_signature', [signer('signed'), { role: 'editor', status: 'viewed', revoked_at: null }])).toBe('completed');
    const v = { version: 2, filename: 'v2.pdf', content_type: 'application/pdf', bytes: 10, sha256: 'd'.repeat(64), note: 'tightened clause 4' };
    expect(versionMetaSchema.safeParse(v).success).toBe(true);
    expect(versionMetaSchema.safeParse({ ...v, version: 1 }).success).toBe(false);
  });

  it('dedupes nothing silently: the email key option is the only key the server accepts', () => {
    const ok = shareSchema.safeParse({ recipients: [{ name: 'A', email: 'A@Example.com' }], email_document_key: 'A'.repeat(43) });
    expect(ok.success && ok.data.recipients[0]).toMatchObject({ email: 'a@example.com', role: 'signer' });
    expect(shareSchema.safeParse({ recipients: [] }).success).toBe(false);
    expect(shareSchema.safeParse({ recipients: [{ name: 'A', email: 'a@example.com' }], email_document_key: 'short' }).success).toBe(false);
  });
});
