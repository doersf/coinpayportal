import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from 'pdf-lib';

/**
 * Runs in the participant's browser: documents are end-to-end encrypted, so
 * the server never has the original to build this from.
 *
 * The signed copy of a document: the original (stamped with its document id
 * on every page) followed by a certificate of completion that records who
 * signed, when, from where, and the sha256 of the original they saw.
 *
 * A PDF original keeps its own pages. An image becomes a page. Anything else,
 * or a PDF pdf-lib cannot open (encrypted, malformed), is carried as an
 * embedded attachment so the signed copy still contains exactly what was signed.
 */

export interface CertificateSigner {
  name: string;
  email: string;
  signature_name: string;
  signature_image: string | null;
  consented_at: string;
  signed_at: string;
  signature_ip: string | null;
  signature_user_agent: string | null;
}

export interface CertificateEvent {
  created_at: string;
  event: string;
  actor_label: string | null;
  ip: string | null;
}

export interface CertificateInput {
  document: {
    id: string;
    title: string;
    filename: string;
    content_type: string;
    sha256: string;
    created_at: string;
  };
  businessName: string;
  original: Uint8Array;
  signers: CertificateSigner[];
  events: CertificateEvent[];
  completedAt: string;
}

const PAGE: [number, number] = [612, 792];
const MARGIN = 54;
const INK = rgb(0.12, 0.13, 0.16);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.85, 0.86, 0.9);

/**
 * The standard PDF fonts only cover WinAnsi. Strip accents where that keeps a
 * readable letter and replace the rest, so a name in another script cannot
 * make the whole document fail to render. The database keeps the exact text.
 */
export function winAnsi(text: string): string {
  return Array.from(text.normalize('NFC'))
    .map((ch) => {
      const code = ch.codePointAt(0)!;
      if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return ch;
      if (ch === '\n' || ch === '\t') return ' ';
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      return /^[\x20-\x7e]+$/.test(base) ? base : '?';
    })
    .join('');
}

function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utc(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    private pdf: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private footer: string
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage(PAGE);
    this.y = PAGE[1] - MARGIN;
    this.page.drawText(winAnsi(this.footer), { x: MARGIN, y: 24, size: 7, font: this.regular, color: MUTED });
  }

  ensure(height: number) {
    if (this.y - height < MARGIN) this.newPage();
  }

  /** Wraps to the page width and returns nothing; the cursor moves down. */
  text(raw: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const x = MARGIN + (opts.indent ?? 0);
    const width = PAGE[0] - MARGIN - x;
    const lineHeight = size * 1.35;
    for (const line of wrap(winAnsi(raw), font, size, width)) {
      this.ensure(lineHeight);
      this.y -= lineHeight;
      this.page.drawText(line, { x, y: this.y, size, font, color: opts.color ?? INK });
    }
  }

  gap(h = 8) {
    this.y -= h;
  }

  rule() {
    this.ensure(10);
    this.y -= 6;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE[0] - MARGIN, y: this.y }, thickness: 0.5, color: RULE });
    this.y -= 6;
  }
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    // A single word longer than the line (a hash, a user agent) is hard-broken.
    let rest = word;
    while (font.widthOfTextAtSize(rest, size) > width) {
      let cut = rest.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

const EVENT_LABEL: Record<string, string> = {
  uploaded: 'Uploaded',
  shared: 'Sent',
  resent: 'Link re-sent',
  revoked: 'Access revoked',
  viewed: 'Opened',
  downloaded: 'Downloaded',
  consented: 'Agreed to sign electronically',
  signed: 'Signed',
  declined: 'Declined',
  completed: 'Completed',
  voided: 'Voided',
  renamed: 'Renamed',
};

async function loadOriginal(input: CertificateInput): Promise<{ pdf: PDFDocument; attached: boolean }> {
  const { original, document } = input;
  if (document.content_type === 'application/pdf') {
    try {
      const pdf = await PDFDocument.load(original, { updateMetadata: false });
      // load() accepts some garbage without complaint and fails on first use.
      if (pdf.getPageCount() > 0) return { pdf, attached: false };
    } catch {
      // Encrypted or malformed: fall through and carry it as an attachment.
    }
  }
  const pdf = await PDFDocument.create();
  if (document.content_type === 'image/png' || document.content_type === 'image/jpeg') {
    try {
      const image = document.content_type === 'image/png' ? await pdf.embedPng(original) : await pdf.embedJpg(original);
      const page = pdf.addPage(PAGE);
      const scale = Math.min((PAGE[0] - 2 * MARGIN) / image.width, (PAGE[1] - 2 * MARGIN) / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: (PAGE[0] - w) / 2, y: (PAGE[1] - h) / 2, width: w, height: h });
      return { pdf, attached: false };
    } catch {
      // An image pdf-lib cannot decode is attached instead.
    }
  }
  await pdf.attach(original, document.filename, {
    mimeType: document.content_type,
    description: `The original document (sha256 ${document.sha256})`,
    creationDate: new Date(document.created_at),
    modificationDate: new Date(document.created_at),
  });
  return { pdf, attached: true };
}

export async function buildSignedPdf(input: CertificateInput): Promise<Uint8Array> {
  const { document, signers, events } = input;
  const { pdf, attached } = await loadOriginal(input);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  const stamp = `CoinPay e-signature · Document ${document.id}`;
  for (const page of pdf.getPages()) {
    page.drawText(winAnsi(stamp), { x: 12, y: 8, size: 6, font: regular, color: MUTED, opacity: 0.8 });
  }

  const w = new Writer(pdf, regular, bold, `${stamp} · Certificate of completion`);
  w.text('Certificate of completion', { size: 20, bold: true });
  w.gap(4);
  w.text(`${document.title}`, { size: 13 });
  w.gap(10);
  w.text(`Sent by: ${input.businessName}`);
  w.text(`Document id: ${document.id}`);
  w.text(`Original file: ${document.filename} (${document.content_type})`);
  w.text(`Original sha256: ${document.sha256}`);
  w.text(`Completed: ${utc(input.completedAt)}`);
  if (attached) {
    w.gap(4);
    w.text('The original file is embedded in this PDF as an attachment; open the attachments panel to view it.', { color: MUTED, size: 9 });
  }
  w.rule();

  w.text(`Signers (${signers.length})`, { size: 13, bold: true });
  for (const s of signers) {
    w.gap(6);
    w.ensure(130);
    w.text(`${s.name} <${s.email}>`, { bold: true });
    if (s.signature_image) {
      try {
        const png = await pdf.embedPng(base64Bytes(s.signature_image.split(',')[1]));
        const scale = Math.min(200 / png.width, 60 / png.height, 1);
        w.ensure(png.height * scale + 8);
        w.y -= png.height * scale + 4;
        w.page.drawImage(png, { x: MARGIN, y: w.y, width: png.width * scale, height: png.height * scale });
      } catch {
        // A bad image never blocks the certificate; the typed name is the signature.
      }
    }
    w.ensure(30);
    w.y -= 24;
    w.page.drawText(winAnsi(s.signature_name), { x: MARGIN, y: w.y, size: 20, font: script, color: INK });
    w.page.drawLine({ start: { x: MARGIN, y: w.y - 4 }, end: { x: MARGIN + 240, y: w.y - 4 }, thickness: 0.5, color: MUTED });
    w.gap(6);
    w.text(`Signed ${utc(s.signed_at)} from ${s.signature_ip ?? 'unknown address'}`, { size: 9, color: MUTED });
    w.text(`Agreed to sign electronically ${utc(s.consented_at)}`, { size: 9, color: MUTED });
    if (s.signature_user_agent) w.text(`Device: ${s.signature_user_agent}`, { size: 8, color: MUTED });
  }
  w.rule();

  w.text('Audit trail', { size: 13, bold: true });
  w.gap(2);
  for (const e of events) {
    const who = e.actor_label ? ` · ${e.actor_label}` : '';
    const where = e.ip ? ` · ${e.ip}` : '';
    const [kind, version] = e.event.split(':');
    const label = kind === 'version_added' && version ? `Version ${version} uploaded` : EVENT_LABEL[kind] ?? kind;
    w.text(`${utc(e.created_at)}  ${label}${who}${where}`, { size: 8.5 });
  }
  w.gap(10);
  w.text(
    'Each signer agreed to use an electronic signature and was identified by a private link sent to the email address above. ' +
      'The sha256 of the original lets anyone confirm the file signed is the file shown here.',
    { size: 8, color: MUTED }
  );

  pdf.setTitle(winAnsi(`${document.title} (signed)`));
  pdf.setProducer('CoinPay');
  pdf.setCreator('CoinPay e-signature');
  pdf.setSubject(`Document ${document.id}; original sha256 ${document.sha256}`);
  return pdf.save();
}
