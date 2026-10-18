import { getJSON } from './http.js';
import { cached } from './cache.js';

export const YC_URL = 'https://yc-oss.github.io/api/companies/hiring.json';
const TTL = 24 * 3600 * 1000;

const EU_NAMES = ['Europe', 'Germany', 'France', 'Spain', 'Sweden', 'Denmark', 'Poland', 'Ireland', 'Netherlands', 'Portugal', 'Italy',
  'Finland', 'Estonia', 'Austria', 'Belgium', 'Czechia', 'Czech Republic', 'Romania', 'Greece', 'Lithuania', 'Latvia', 'Bulgaria', 'Hungary', 'Croatia'];
const APAC_NAMES = ['India', 'South Asia', 'Southeast Asia', 'East Asia', 'Singapore', 'Oceania', 'Australia', 'New Zealand', 'Indonesia',
  'Vietnam', 'Hong Kong', 'Malaysia', 'Philippines', 'Thailand', 'Japan', 'South Korea', 'Taiwan', 'Pakistan', 'Bangladesh', 'Sri Lanka'];

/**
 * Map yc-oss region names to our region enum (india|us|eu|uk|apac|remote-global).
 * yc-oss tags are hierarchical, so parents alone are not enough:
 * - "remote-global" only from "Fully Remote" (the "Remote" parent also covers "Partly Remote");
 * - "us" only from "United States of America" ("America / Canada" alone may be Canada-only);
 * - "india" only from "India" ("South Asia" alone → apac).
 * @param {string[]} ycRegions
 * @returns {string[]}
 */
export function mapRegions(ycRegions = []) {
  const has = new Set(ycRegions);
  const out = [];
  if (has.has('India')) out.push('india');
  if (has.has('United States of America')) out.push('us');
  if (EU_NAMES.some((n) => has.has(n))) out.push('eu');
  if (has.has('United Kingdom')) out.push('uk');
  if (APAC_NAMES.some((n) => has.has(n))) out.push('apac');
  if (has.has('Fully Remote')) out.push('remote-global');
  return out;
}

/** "Winter 2024" → "W24", "Summer 2023" → "S23", "Fall 2024" → "F24", "Spring 2025" → "X25". */
export function batchCode(batch) {
  const m = /^(winter|summer|fall|spring)\s+(\d{4})$/i.exec(String(batch ?? '').trim());
  if (!m) return String(batch ?? '');
  return `${{ winter: 'W', summer: 'S', fall: 'F', spring: 'X' }[m[1].toLowerCase()]}${m[2].slice(2)}`;
}

const batchYear = (batch) => Number(/(\d{4})/.exec(String(batch ?? ''))?.[1]) || null;

/**
 * Stage heuristic (yc-oss has no funding stage): "seed" if the batch is within the last
 * 2 years and the team has ≤ 25 people; otherwise "unknown".
 */
export function stageFor(c, now = new Date()) {
  const y = batchYear(c.batch);
  return y && y >= now.getUTCFullYear() - 2 && (c.team_size ?? Infinity) <= 25 ? 'seed' : 'unknown';
}

const TAG_MAP = {
  'artificial intelligence': 'ai', 'generative ai': 'ai', 'ai': 'ai', 'machine learning': 'ai', 'b2b': 'b2b', fintech: 'fintech',
  'developer tools': 'devtools', 'engineering, product and design': 'devtools', healthcare: 'health', 'consumer': 'consumer',
  'education': 'edtech', 'infrastructure': 'infra', 'security': 'security', 'industrials': 'industrials', 'government': 'gov',
  'real estate and construction': 'proptech', 'payments': 'payments', 'banking and exchange': 'fintech', 'analytics': 'data',
  'data engineering': 'data', 'productivity': 'productivity', 'sales': 'sales', 'marketing': 'marketing', 'legal': 'legal',
  'recruiting and talent': 'hr', 'human resources': 'hr', 'supply chain and logistics': 'logistics', 'insurance': 'insurance',
};

/** Short lowercase tags from yc industries/tags (max 4, plus "yc"). */
export function tagsFor(c) {
  const out = [];
  for (const raw of [...(c.industries ?? []), ...(c.tags ?? [])]) {
    const k = String(raw).toLowerCase().trim();
    const t = TAG_MAP[k] ?? (k.split(/\s+/).length <= 2 && k.length <= 16 ? k.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : null);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 4) break;
  }
  return ['yc', ...out];
}

/** First hostname label of a website, e.g. "https://www.linear.app" → "linear". */
export function websiteLabel(url) {
  try { return new URL(/^https?:/i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').split('.')[0] || null; } catch { return null; }
}

/**
 * Filter the yc-oss list: hiring + Active, then optional region tags (comma list = any),
 * industry substring and batch ("W24" or "Winter 2024").
 */
export function filterYc(list, { region, industry, batch } = {}) {
  const regions = String(region ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ind = String(industry ?? '').toLowerCase();
  const b = String(batch ?? '').toLowerCase();
  return list.filter((c) => c.isHiring && c.status === 'Active')
    .filter((c) => !regions.length || regions.some((r) => mapRegions(c.regions).includes(r)))
    .filter((c) => !ind || [...(c.industries ?? []), c.industry, c.subindustry, ...(c.tags ?? [])].some((x) => String(x ?? '').toLowerCase().includes(ind)))
    .filter((c) => !b || batchCode(c.batch).toLowerCase() === b || String(c.batch ?? '').toLowerCase() === b);
}

const slim = (c) => ({
  name: c.name, slug: c.slug, website: c.website, batch: c.batch, regions: c.regions, industries: c.industries,
  industry: c.industry, subindustry: c.subindustry, tags: c.tags, isHiring: c.isHiring, status: c.status,
  team_size: c.team_size, one_liner: c.one_liner, launched_at: c.launched_at,
});

/** The yc-oss hiring dataset, cached for 24h in data/cache/. Newest batches first. */
export async function loadYc(opts = {}) {
  const { data } = await cached('yc-hiring', TTL, async () => (await getJSON(YC_URL, { timeout: 30000, ...opts.http })).map(slim));
  return [...data].sort((a, b) => (b.launched_at ?? 0) - (a.launched_at ?? 0));
}
