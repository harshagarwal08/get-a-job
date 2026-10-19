// SAP SuccessFactors Recruiting Marketing ("RMK") career sites on custom domains
// (e.g. careers.tatamotors.com, jobs.standardchartered.com, careers.hcltech.com).
// Listing = the site's server-rendered search page:
//   GET https://<host>/search/?q=<keywords>&locale=en_US&startrow=<0,25,50>
// (rows `tr.data-row` → `a.jobTitle-link`, `span.jobLocation`, `span.jobDate`).
// The RSS feeds (/feeds/* → /services/rss/*) are robots-disallowed, so they are not used.
// Custom domains can't be allowlisted, so every request goes through safeFetch
// (public-IP guard, robots.txt per URL and per redirect hop, 5 MB cap).
import { safeGet } from '../safeFetch.js';
import { robotsAllows } from '../robots.js';
import { decodeEntities, htmlToText } from '../text.js';
import { makeJob } from '../job.js';

const MAX_TERMS = 4;
const MAX_PAGES = 2;
const PAGE = 25;
const DETAIL_CAP = 10;
const GAP_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalise an RMK site URL to its https origin. */
export function siteOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (cc) => { try { return REGION_NAMES.of(cc) ?? cc; } catch { return cc; } };
const text = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Normalise one RMK search results page.
 * @param {string} html
 * @param {{name: string, url: string}} company
 */
export function normalize(html, company) {
  const origin = siteOrigin(company.url);
  const rows = String(html ?? '').split(/<tr[^>]*class="[^"]*\bdata-row\b[^"]*"[^>]*>/i).slice(1).map((r) => r.split(/<\/tr>/i)[0]);
  const jobs = [];
  for (const r of rows) {
    const a = /<a[^>]*href="([^"]+)"[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*>([\s\S]*?)<\/a>|<a[^>]*class="[^"]*jobTitle-link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(r);
    if (!a) continue;
    const href = decodeEntities(a[1] ?? a[3]);
    const title = text(a[2] ?? a[4]);
    let url;
    try { url = new URL(href, origin).href; } catch { continue; }
    if (!title || new URL(url).origin !== origin) continue;
    const rawLoc = text(/<span[^>]*class="[^"]*\bjobLocation\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(r)?.[1]);
    const date = text(/<span[^>]*class="[^"]*\bjobDate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(r)?.[1]);
    // RMK ends locations with an ISO country code ("Pune, IN"); spell it out so "IN" isn't read as Indiana.
    const cc = /(?:^|,\s*)([A-Z]{2})$/.exec(rawLoc)?.[1];
    const location = cc ? rawLoc.replace(/[A-Z]{2}$/, countryName(cc)) : rawLoc;
    jobs.push(makeJob({
      title, company: company.name, location, countryHints: cc ? [cc] : [],
      url, applyUrl: url, source: 'successfactors', sourceId: /\/(\d{6,})\/?$/.exec(new URL(url).pathname)?.[1] ?? url,
      postedAt: date && !Number.isNaN(Date.parse(`${date} UTC`)) ? new Date(`${date} UTC`).toISOString() : null,
      description: '',
    }));
  }
  return jobs;
}

/** Total result count from "Results 1 – 25 of 100" (null if absent). */
export function totalResults(html) {
  const m = /Results\s*<b>[^<]*<\/b>\s*of\s*<b>\s*([\d,]+)/i.exec(String(html ?? ''));
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Description from an RMK job page (`itemprop="description"` / `.jobdescription`). */
export function descriptionFrom(html) {
  const m = /<(?:span|div)[^>]*(?:itemprop="description"|class="[^"]*\bjobdescription\b[^"]*")[^>]*>([\s\S]*?)<\/(?:span|div)>\s*<\/(?:span|div)>/i.exec(html)
    ?? /<(?:span|div)[^>]*(?:itemprop="description"|class="[^"]*\bjobdescription\b[^"]*")[^>]*>([\s\S]*)/i.exec(html);
  return m ? htmlToText(m[1]).slice(0, 50000) : '';
}

const get = (url, opts) => safeGet(url, { robots: opts.robots ?? robotsAllows, timeout: 30000, ...(opts.safe ?? {}) });

async function searchPage(origin, term, startrow, opts) {
  const qs = new URLSearchParams({ q: term, locale: 'en_US', ...(startrow ? { startrow: String(startrow) } : {}) });
  const res = await get(`${origin}/search/?${qs}`, opts);
  if (!/data-row|jobTitle-link|searchResults/i.test(res.text)) throw new Error(`${origin} doesn't look like a SuccessFactors career site (no search results table)`);
  return res.text;
}

/**
 * Fetch jobs for `{name, url}`: one search per track title (≤4 terms × ≤2 pages of 25),
 * details for `opts.wantDetail` matches (≤10), ≥1 s between requests.
 * @param {{name: string, url: string}} company
 * @param {{searchTerms?: string[], wantDetail?: Function, gapMs?: number, robots?: Function, safe?: object}} [opts]
 */
export async function fetchJobs(company, opts = {}) {
  const origin = siteOrigin(company.url);
  if (!origin) throw new Error(`${company.name}: successfactors entries need an https "url" (the careers site)`);
  const gap = opts.gapMs ?? GAP_MS;
  const terms = [...new Set((opts.searchTerms?.length ? opts.searchTerms : ['']).map((t) => String(t).trim()))].slice(0, MAX_TERMS);
  const byUrl = new Map();
  let n = 0;
  for (const term of terms) {
    for (let p = 0; p < MAX_PAGES; p++) {
      if (n++) await sleep(gap);
      const html = await searchPage(origin, term, p * PAGE, opts);
      const page = normalize(html, company);
      for (const j of page) if (!byUrl.has(j.url)) byUrl.set(j.url, j);
      const total = totalResults(html);
      if (page.length < PAGE || (total !== null && (p + 1) * PAGE >= total)) break;
    }
  }
  const jobs = [...byUrl.values()];
  const want = jobs.map((j, i) => [j, i]).filter(([j]) => opts.wantDetail?.(j)).slice(0, DETAIL_CAP);
  for (const [j, i] of want) {
    await sleep(gap);
    try { jobs[i] = { ...j, description: descriptionFrom((await get(j.url, opts)).text) }; } catch { /* keep listing data */ }
  }
  return jobs;
}

/** Verify an RMK site: its search page must render a results table with ≥1 job. */
export async function check(url, opts = {}) {
  const origin = siteOrigin(url);
  if (!origin) return { ok: false, jobs: 0, sample: [], error: 'successfactors needs an https careers-site URL' };
  try {
    const html = await searchPage(origin, opts.term ?? 'engineer', 0, opts);
    const jobs = normalize(html, { name: new URL(origin).hostname, url: origin });
    const total = totalResults(html) ?? jobs.length;
    return { ok: jobs.length > 0, jobs: total, sample: jobs.map((j) => j.title).slice(0, 5), ...(jobs.length ? {} : { error: 'search returned 0 jobs' }) };
  } catch (err) {
    return { ok: false, jobs: 0, sample: [], error: err.message };
  }
}

/** One RMK job page → job (title from the page, description from the job body). */
export async function fetchOne(url, opts = {}) {
  const res = await get(url, opts);
  const title = text(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(res.text)?.[1]) || text(/<title>([\s\S]*?)<\/title>/i.exec(res.text)?.[1]);
  return makeJob({ title, company: opts.companyName ?? new URL(url).hostname, url, applyUrl: url, source: 'successfactors', sourceId: url, description: descriptionFrom(res.text) });
}
