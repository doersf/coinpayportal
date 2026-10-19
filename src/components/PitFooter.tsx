// The pit.world global footer, fetched server-side and cached for an hour.
// Any failure (timeout, non-200, network) renders nothing so the page never breaks.
const PIT_FOOTER_URL = 'https://pit.world/snippets/footer.html?site=coinpayportal.com';

async function loadPitFooter(): Promise<string | null> {
  try {
    const res = await fetch(PIT_FOOTER_URL, {
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return html.includes('data-pit-footer') ? html : null;
  } catch {
    return null;
  }
}

export default async function PitFooter() {
  const html = await loadPitFooter();
  if (!html) return null;
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
