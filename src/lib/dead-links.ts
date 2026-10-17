// External links confirmed dead (404 in the 2026-10-17 dead-link sweep). Post
// bodies are data, so rather than hand-edit rows the dead anchors are unwrapped
// at render time: the link goes, the text stays.
//
// c0upons.com blog URLs are deliberately absent: they are getting redirects.

const DEAD_URLS = new Set<string>([
  'https://jonandersen.substack.com/p/hidden-inflammation-is-killing-your-3a6',
  'https://jonandersen.substack.com/p/peptide-injection-without-fear-bbf',
]);

function normalize(href: string): string {
  return href.replace(/#.*$/, '').replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
}

export function isDeadExternalUrl(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  } catch {
    return false;
  }
  return DEAD_URLS.has(normalize(href));
}

const ANCHOR = /<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

/** Unwrap every anchor that points at a known-dead URL, keeping its text. */
export function stripDeadLinks(html: string): string {
  return html.replace(ANCHOR, (whole, href: string, inner: string) =>
    isDeadExternalUrl(href.replace(/&amp;/g, '&')) ? inner : whole,
  );
}
