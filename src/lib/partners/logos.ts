// The logo strip under the homepage hero. Two lists, kept apart on purpose:
//
// AI_CLIENTS are agent tools CoinPay works with — through `coinpay mcp` (a
// stdio MCP server) or the skill file at /skill.md. They are compatibility,
// not partnerships, and the strip labels them that way. Marks are from
// simple-icons (CC0) and render white.
//
// FLEET_SITES are live Profullstack sites that call the CoinPay API (API key
// or the SDK) — checked against each repo, not just a link to coinpayportal.com.
// Icons are each site's own, copied into public/partners/sites. `logo: null`
// renders a monogram: those sites publish no fetchable icon file.

export interface LogoItem {
  name: string;
  logo: string | null;
  url?: string;
  title?: string;
}

export const AI_CLIENTS: LogoItem[] = [
  { name: 'Claude', logo: '/partners/ai/claude.svg', title: 'claude mcp add coinpay -- coinpay mcp' },
  { name: 'ChatGPT', logo: '/partners/ai/openai.svg', title: 'Reads coinpayportal.com/skill.md' },
  { name: 'Gemini', logo: '/partners/ai/googlegemini.svg', title: 'Gemini CLI via coinpay mcp' },
  { name: 'GitHub Copilot', logo: '/partners/ai/copilot.svg', title: 'VS Code agent mode via coinpay mcp' },
  { name: 'Windsurf', logo: '/partners/ai/windsurf.svg', title: 'Windsurf via coinpay mcp' },
];

const site = (name: string, host: string, ext: 'png' | 'svg' | null): LogoItem => ({
  name,
  logo: ext ? `/partners/sites/${host}.${ext}` : null,
  url: `https://${host}`,
});

export const FLEET_SITES: LogoItem[] = [
  site('ugig', 'ugig.net', 'png'),
  site('SMSHub', 'smshub.dev', 'png'),
  site('crawlproof', 'crawlproof.com', 'png'),
  site('PairUX', 'pairux.com', 'png'),
  site('ThreatCrush', 'threatcrush.com', 'png'),
  site('bittorrented', 'bittorrented.com', 'png'),
  site('nichedb', 'nichedb.dev', 'png'),
  site('logicsrc', 'logicsrc.com', 'svg'),
  site('sh1pt', 'sh1pt.com', 'svg'),
  site('OutreachGraph', 'outreachgraph.com', 'png'),
  site('ad.network', 'ad.network', null),
  site('nixamp', 'nixamp.com', 'png'),
  site('c0upons', 'c0upons.com', 'png'),
  site('d0rz', 'd0rz.com', 'png'),
  site('bl0ggers', 'bl0ggers.com', 'png'),
  site('nightcell7', 'nightcell7.com', 'png'),
  site('HQTUI', 'hqtui.com', 'png'),
  site('genrewatch', 'genrewatch.com', 'png'),
  site('tipoffwatch', 'tipoffwatch.com', 'png'),
  site('watchnews', 'watchnews.now', 'png'),
  site('ch4nnels', 'ch4nnels.com', 'svg'),
  site('typeheard', 'typeheard.com', 'svg'),
  site('tleehealth', 'tleehealth.com', 'svg'),
  site('AIorNot', 'aiornot.vote', 'svg'),
  site('b1dz', 'b1dz.com', 'png'),
  site('qaaas', 'qaaas.dev', 'svg'),
  site('wx93', 'wx93.me', 'svg'),
  site('recipepdfs', 'recipepdfs.com', null),
  site('bg0ne', 'bg0ne.com', null),
  site('Profullstack', 'profullstack.com', 'png'),
];
