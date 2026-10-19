import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { buildSignedPdf, winAnsi, type CertificateInput } from './certificate';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function onePagePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  page.drawText('Contract', { x: 50, y: 700, font: await pdf.embedFont(StandardFonts.Helvetica) });
  return pdf.save();
}

function input(original: Uint8Array, contentType: string, filename: string): CertificateInput {
  return {
    document: { id: '6f1c2d3e-0000-4000-8000-000000000002', title: 'Service agreement', filename, content_type: contentType, sha256: 'a'.repeat(64), created_at: '2026-10-19T10:00:00Z' },
    businessName: 'Acme Ltd',
    original,
    signers: [
      {
        name: 'Zoë Ångström',
        email: 'zoe@example.com',
        signature_name: 'Zoë Ångström',
        signature_image: `data:image/png;base64,${PNG_1x1}`,
        consented_at: '2026-10-19T11:00:00Z',
        signed_at: '2026-10-19T11:00:01Z',
        signature_ip: '203.0.113.7',
        signature_user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
      },
      {
        name: '王小明',
        email: 'wang@example.com',
        signature_name: '王小明',
        signature_image: null,
        consented_at: '2026-10-19T12:00:00Z',
        signed_at: '2026-10-19T12:00:01Z',
        signature_ip: null,
        signature_user_agent: null,
      },
    ],
    events: [
      { created_at: '2026-10-19T10:00:00Z', event: 'uploaded', actor_label: 'owner@example.com', ip: '198.51.100.1' },
      { created_at: '2026-10-19T10:30:00Z', event: 'version_added:2', actor_label: 'editor@example.com', ip: null },
      { created_at: '2026-10-19T12:00:02Z', event: 'completed', actor_label: null, ip: null },
    ],
    completedAt: '2026-10-19T12:00:02Z',
  };
}

describe('signed copy', () => {
  it('keeps a PDF original and appends the certificate', async () => {
    const out = await buildSignedPdf(input(await onePagePdf(), 'application/pdf', 'agreement.pdf'));
    const pdf = await PDFDocument.load(out);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(pdf.getTitle()).toBe('Service agreement (signed)');
    expect(pdf.getSubject()).toContain('a'.repeat(64));
  });

  it('turns an image into a page', async () => {
    const png = Uint8Array.from(Buffer.from(PNG_1x1, 'base64'));
    const pdf = await PDFDocument.load(await buildSignedPdf(input(png, 'image/png', 'scan.png')));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('embeds anything else, or an unreadable PDF, as an attachment', async () => {
    for (const [bytes, type, name] of [
      [new TextEncoder().encode('PK not really a docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'terms.docx'],
      [new TextEncoder().encode('%PDF-1.7 garbage'), 'application/pdf', 'broken.pdf'],
    ] as const) {
      const pdf = await PDFDocument.load(await buildSignedPdf(input(bytes, type, name)));
      const names = pdf.catalog.lookup(PDFName.of('Names'));
      expect(names).toBeDefined();
      expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps text the standard fonts cannot draw from breaking the PDF', () => {
    expect(winAnsi('Zoë Ångström')).toBe('Zoë Ångström');
    expect(winAnsi('Łukasz')).toBe('?ukasz');
    expect(winAnsi('Đặng')).toBe('?ang');
    expect(winAnsi('王小明')).toBe('???');
  });
});
