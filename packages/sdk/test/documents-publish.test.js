import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPublish, publishDirectory, walkDirectory } from '../src/documents-publish.js';
import { newKey, normalizeFolder, sha256Hex } from '../src/documents.js';

const BUSINESS = '6f1c2d3e-0000-4000-8000-000000000001';

async function tree() {
  const dir = await mkdtemp(join(tmpdir(), 'coinpay-publish-'));
  const root = join(dir, 'acme-deal');
  await mkdir(join(root, 'contracts', '2026'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'hello');
  await writeFile(join(root, 'contracts', '2026', 'nda.pdf'), '%PDF-1.7 nda');
  await writeFile(join(root, 'contracts', 'msa.docx'), 'PK msa');
  await writeFile(join(root, 'contracts', 'empty.txt'), '');
  await writeFile(join(root, '.git', 'config'), 'secret');
  await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'x');
  return { dir, root };
}

describe('publishing a directory', () => {
  it('walks it, leaving out hidden files and node_modules unless asked', async () => {
    const { dir, root } = await tree();
    try {
      const { files, skipped } = await walkDirectory(root);
      expect(files.map((f) => f.rel).sort()).toEqual(['README.md', 'contracts/2026/nda.pdf', 'contracts/empty.txt', 'contracts/msa.docx'].sort());
      expect(skipped).toBe(2);
      const all = await walkDirectory(root, { includeHidden: true });
      expect(all.files.map((f) => f.rel)).toContain('.git/config');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('plans: new, changed, unchanged, signed-and-locked, empty, too large', () => {
    const local = [
      { rel: 'a.pdf', filename: 'a.pdf', folder: 'deal', size: 10, sha256: '1'.repeat(64) },
      { rel: 'b.pdf', filename: 'b.pdf', folder: 'deal', size: 10, sha256: '2'.repeat(64) },
      { rel: 'c.pdf', filename: 'c.pdf', folder: 'deal', size: 10, sha256: '3'.repeat(64) },
      { rel: 'd.pdf', filename: 'd.pdf', folder: 'deal', size: 10, sha256: '4'.repeat(64) },
      { rel: 'e.txt', filename: 'e.txt', folder: null, size: 0 },
      { rel: 'f.bin', filename: 'f.bin', folder: null, size: 20 * 1024 * 1024 },
    ];
    const remote = [
      { id: 'b-new', folder: 'deal', filename: 'b.pdf', sha256: '0'.repeat(64), status: 'draft', signed: 0 },
      { id: 'b-old', folder: 'deal', filename: 'b.pdf', sha256: '2'.repeat(64), status: 'draft', signed: 0 },
      { id: 'c', folder: 'deal', filename: 'c.pdf', sha256: '3'.repeat(64), status: 'shared', signed: 0 },
      { id: 'd', folder: 'deal', filename: 'd.pdf', sha256: '0'.repeat(64), status: 'out_for_signature', signed: 1 },
      // Same name in another folder is a different document.
      { id: 'a-elsewhere', folder: 'other', filename: 'a.pdf', sha256: '0'.repeat(64), status: 'draft', signed: 0 },
    ];
    const plan = Object.fromEntries(planPublish(local, remote).map((p) => [p.rel, p]));
    expect(plan['a.pdf'].action).toBe('upload');
    // The newest document at a path wins.
    expect(plan['b.pdf']).toMatchObject({ action: 'version', documentId: 'b-new' });
    expect(plan['c.pdf']).toMatchObject({ action: 'unchanged', documentId: 'c' });
    expect(plan['d.pdf']).toMatchObject({ action: 'locked', documentId: 'd' });
    expect(plan['e.txt'].action).toBe('empty');
    expect(plan['f.bin'].action).toBe('too_large');
  });

  it('files everything under the directory name, or where told, and uploads only what changed', async () => {
    const { dir, root } = await tree();
    try {
      const msaSha = await sha256Hex(new TextEncoder().encode('PK msa'));
      const uploads = [];
      const client = {
        request: vi.fn(async (endpoint) => {
          if (endpoint.startsWith('/documents?')) return { documents: [{ id: 'm', folder: 'acme-deal/contracts', filename: 'msa.docx', sha256: msaSha, status: 'draft', signed: 0 }] };
          throw new Error('unexpected ' + endpoint);
        }),
        requestForm: vi.fn(async (endpoint, form) => {
          const meta = JSON.parse(form.get('meta'));
          uploads.push(meta);
          return { document: { id: meta.id } };
        }),
      };
      const vault = { vaultKey: newKey(), version: 1 };
      const result = await publishDirectory(client, { businessId: BUSINESS, vault, dir: root });
      expect(result.folder).toBe('acme-deal');
      expect(uploads.map((u) => `${u.folder}/${u.filename}`).sort()).toEqual(['acme-deal/README.md', 'acme-deal/contracts/2026/nda.pdf']);
      expect(uploads.find((u) => u.filename === 'README.md').content_type).toBe('text/plain');

      const dry = await publishDirectory(client, { businessId: BUSINESS, dir: root, folder: '/', dryRun: true });
      expect(dry.folder).toBeNull();
      expect(dry.plan.find((p) => p.filename === 'nda.pdf').folder).toBe('contracts/2026');
      expect(client.requestForm).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a destination that climbs out', () => {
    expect(() => normalizeFolder('../etc')).toThrow();
  });
});
