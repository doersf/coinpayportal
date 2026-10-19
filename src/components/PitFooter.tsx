// The pit.world global footer, fetched server-side and cached for an hour.
// Any failure (timeout, non-200, network) renders nothing so the page never breaks.
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=coinpayportal.com';
// The snippet is markup + scoped CSS only. This is a payments site, so refuse
// anything that could execute: script/iframe/object tags, inline handlers, js: URLs.
const UNSAFE = /<\s*(script|iframe|object|embed|link|meta|base|form)\b|\son[a-z]+\s*=|javascript:/i;

async function loadPitFooter(): Promise<string | null> {
  try {
    const res = await fetch(PIT_FOOTER_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.includes('data-pit-footer') && !UNSAFE.test(html) ? html : null;
  } catch {
    return null;
  }
}

export default async function PitFooter() {
  const html = await loadPitFooter();
  if (!html) return null;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
