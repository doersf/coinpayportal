import { describe, expect, it } from 'vitest';
import { contentTypeFor, signedFilename, cleanFilename, SEAL_OVERHEAD } from './types';
import { hashToken, newSignToken, SIGN_TOKEN_PATTERN, shareSchema, signActionSchema, statusFor, uploadMetaSchema } from './service';

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
    expect(contentTypeFor('payload.exe')).toBeNull();
    expect(contentTypeFor('page.html')).toBeNull();
    expect(signedFilename('agreement.docx')).toBe('agreement-signed.pdf');
    expect(cleanFilename('../../etc/"pass"wd')).toBe('passwd');
    expect(SEAL_OVERHEAD).toBe(29);
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

  it('dedupes nothing silently: the email key option is the only key the server accepts', () => {
    const ok = shareSchema.safeParse({ recipients: [{ name: 'A', email: 'A@Example.com' }], email_document_key: 'A'.repeat(43) });
    expect(ok.success && ok.data.recipients[0]).toMatchObject({ email: 'a@example.com', role: 'signer' });
    expect(shareSchema.safeParse({ recipients: [] }).success).toBe(false);
    expect(shareSchema.safeParse({ recipients: [{ name: 'A', email: 'a@example.com' }], email_document_key: 'short' }).success).toBe(false);
  });
});
