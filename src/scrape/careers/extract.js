// Pure HTML parsing for the careers-page crawler: JSON-LD postings, embedded ATS boards,
// job-detail links and main-content text. No network here.
import { decodeEntities, htmlToText, htmlTitle } from '../text.js';
import { detectCountries } from '../geo.js';

// ---------- URLs / domains ----------

const MULTI_PART_TLDS = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.nz', 'com.sg', 'com.br', 'com.mx', 'co.jp', 'co.kr', 'com.cn', 'com.hk', 'com.tw', 'co.za', 'com.tr', 'co.id', 'com.my',
  'com.ph', 'com.vn', 'co.il', 'com.ar', 'com.co', 'com.pk', 'com.bd', 'com.eg', 'com.ng', 'co.ke', 'com.sa', 'ae.org',
]);

/**
 * Approximate registrable domain (eTLD+1) without a public-suffix list.
 * @param {string} host
 */
export function registrableDomain(host) {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  const parts = h.split('.');
  if (parts.length <= 2 || /^[\d.]+$/.test(h)) return h;
  const last2 = parts.slice(-2).join('.');
  return MULTI_PART_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

/** True when two URLs share a registrable domain. */
export function sameSite(a, b) {
  try { return registrableDomain(new URL(a).hostname) === registrableDomain(new URL(b).hostname); } catch { return false; }
}

/** Resolve an href against a base, dropping the fragment. Returns null for non-http(s). */
export function resolveHref(href, base) {
  const raw = decodeEntities(String(href ?? '').trim());
  if (!raw || /^(javascript|mailto|tel|data|blob):/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

/** Document base URL honouring `<base href>`. */
export function baseUrlOf(html, pageUrl) {
  const m = /<base\s[^>]*href\s*=\s*["']?([^"'\s>]+)/i.exec(html);
  return (m && resolveHref(m[1], pageUrl)) || pageUrl;
}

const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
};

// ---------- JSON-LD ----------

const isType = (o, t) => o && typeof o === 'object' && [o['@type']].flat().some((x) => String(x).toLowerCase() === t.toLowerCase());

function parseLd(raw) {
  const s = raw.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/^<!--|-->$/g, '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through */ }
  try { return JSON.parse(s.replace(/[\u0000-\u001f]+/g, ' ')); } catch { return null; }
}

/**
 * Collect every JobPosting in the page's JSON-LD (top level, arrays, @graph, ItemList,
 * nested), plus bare ItemList URLs that point at postings.
 * @param {string} html
 * @returns {{postings: object[], listUrls: string[]}}
 */
export function extractJsonLd(html) {
  const postings = [];
  const listUrls = [];
  const seen = new Set();
  const walk = (node, depth, inList) => {
    if (!node || depth > 8 || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1, inList); return; }
    if (seen.has(node)) return;
    seen.add(node);
    if (isType(node, 'JobPosting')) { postings.push(node); return; }
    if (inList && isType(node, 'ListItem') && !node.item && typeof node.url === 'string') listUrls.push(node.url);
    if (inList && isType(node, 'ListItem') && typeof node.item === 'string') listUrls.push(node.item);
    const list = isType(node, 'ItemList');
    for (const [k, v] of Object.entries(node)) {
      if (k === '@context') continue;
      if (v && typeof v === 'object') walk(v, depth + 1, inList || list);
    }
  };
  for (const m of String(html ?? '').matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    walk(parseLd(m[1]), 0, false);
  }
  return { postings, listUrls };
}

const str = (v) => (v && typeof v === 'object' ? v.name ?? v['@value'] ?? null : v ?? null);

function placeText(l) {
  if (!l) return '';
  if (typeof l === 'string') return l;
  const a = l.address ?? l;
  if (typeof a === 'string') return a;
  return [a.addressLocality, a.addressRegion, str(a.addressCountry)].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i).join(', ') || String(l.name ?? '');
}

/**
 * Map a JSON-LD JobPosting to makeJob() fields (minus company/source).
 * @param {object} p
 * @param {string} [pageUrl] the page it was found on (fallback url)
 */
export function ldToFields(p, pageUrl) {
  const locs = [p.jobLocation].flat().filter(Boolean).map(placeText).map((s) => s.trim()).filter(Boolean);
  const remote = [p.jobLocationType].flat().some((t) => /telecommute|remote/i.test(String(t ?? '')));
  const reqs = [p.applicantLocationRequirements].flat().filter(Boolean).map((r) => (typeof r === 'string' ? r : str(r) ?? placeText(r))).filter(Boolean);
  if (remote) locs.unshift(reqs.length ? `Remote (${reqs.join(', ')})` : 'Remote');
  const bs = p.baseSalary;
  const val = bs && typeof bs === 'object' ? bs.value ?? {} : {};
  const num = (x) => (x == null || x === '' ? null : Number(String(x).replace(/[, ]/g, '')));
  const salary = bs && typeof bs === 'object' ? {
    min: num(typeof val === 'object' ? val.minValue ?? val.value : val),
    max: num(typeof val === 'object' ? val.maxValue ?? val.value : val),
    currency: bs.currency ?? val.currency ?? null,
    unit: (typeof val === 'object' && val.unitText) || bs.unitText || 'YEAR',
  } : null;
  const id = typeof p.identifier === 'object' ? p.identifier?.value : p.identifier;
  const url = typeof p.url === 'string' ? p.url : null;
  return {
    title: decodeEntities(String(str(p.title) ?? str(p.name) ?? '')).trim(),
    hiringOrganization: str(p.hiringOrganization),
    location: locs[0] ?? '',
    locations: locs.slice(1),
    countryHints: reqs,
    workModeField: remote && !locs.slice(1).length ? 'remote' : null,
    url: url ? resolveHref(url, pageUrl ?? url) : pageUrl ?? null,
    sourceId: id ?? null,
    department: null,
    salary,
    postedAt: p.datePosted ?? null,
    validThrough: p.validThrough ?? null,
    description: p.description ? htmlToText(String(p.description)) : '',
  };
}

// ---------- embedded ATS ----------

const SLUG_STOP = new Set(['embed', 'api', 'v0', 'v1', 'v2', 'j', 'jobs', 'job', 'static', 'assets', 'js', 'css', 'widget', 'www', 'apply', 'careers', 'posting-api', 'job-board', 'boards', 'accounts', 'companies', 'o', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'cdn', 'images', 'img']);
const SLUG_RE = '([A-Za-z0-9][A-Za-z0-9._-]{0,99})';
const ATS_PATTERNS = [
  ['greenhouse', new RegExp(`boards-api(?:\\.eu)?\\.greenhouse\\.io/v1/boards/${SLUG_RE}`, 'gi')],
  ['greenhouse', new RegExp(`(?:job-)?boards(?:\\.eu)?\\.greenhouse\\.io/(?:embed/job_board(?:/js)?\\?(?:[^"'\\s<>]*?&(?:amp;)?)?for=)?${SLUG_RE}`, 'gi')],
  ['greenhouse', new RegExp(`greenhouse\\.io/embed/job_board(?:/js)?\\?(?:[^"'\\s<>]*?&(?:amp;)?)?for=${SLUG_RE}`, 'gi')],
  ['lever', new RegExp(`jobs(?:\\.eu)?\\.lever\\.co/${SLUG_RE}`, 'gi')],
  ['lever', new RegExp(`api(?:\\.eu)?\\.lever\\.co/v0/postings/${SLUG_RE}`, 'gi')],
  ['ashby', new RegExp(`jobs\\.ashbyhq\\.com/${SLUG_RE}`, 'gi')],
  ['ashby', new RegExp(`api\\.ashbyhq\\.com/posting-api/job-board/${SLUG_RE}`, 'gi')],
  ['workable', new RegExp(`apply\\.workable\\.com/(?:api/v[13]/(?:widget/)?accounts/)?${SLUG_RE}`, 'gi')],
  ['workable', /\b([a-z0-9][a-z0-9-]{0,62})\.workable\.com/gi],
  ['smartrecruiters', new RegExp(`(?:jobs|careers)\\.smartrecruiters\\.com/${SLUG_RE}`, 'gi')],
  ['smartrecruiters', new RegExp(`api\\.smartrecruiters\\.com/v1/companies/${SLUG_RE}`, 'gi')],
  ['recruitee', /\b([a-z0-9][a-z0-9-]{0,62})\.recruitee\.com/gi],
];
const SUBDOMAIN_STOP = new Set(['apply', 'www', 'jobs', 'api', 'careers', 'app', 'help', 'resources', 'blog', 'cdn', 'static']);

/**
 * Find supported ATS boards referenced anywhere in the page (links, iframes, scripts, inline JSON).
 * @param {string} html
 * @returns {{ats: string, slug: string, hits: number}[]} most-referenced first
 */
export function detectEmbeddedAts(html) {
  const s = String(html ?? '').replace(/\\\//g, '/');
  const counts = new Map();
  for (const [ats, re] of ATS_PATTERNS) {
    for (const m of s.matchAll(re)) {
      let slug = m[1].replace(/[._-]+$/, '');
      const sub = ats === 'recruitee' || (ats === 'workable' && /\.workable\.com/i.test(m[0]) && !/apply\.workable/i.test(m[0]));
      if (sub && SUBDOMAIN_STOP.has(slug.toLowerCase())) continue;
      if (!slug || SLUG_STOP.has(slug.toLowerCase())) continue;
      if (ats === 'lever' || ats === 'ashby' || ats === 'smartrecruiters') slug = slug.replace(/\.$/, '');
      const key = `${ats}\u0000${ats === 'smartrecruiters' ? slug : slug.toLowerCase()}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].map(([k, hits]) => { const [ats, slug] = k.split('\u0000'); return { ats, slug, hits }; })
    .sort((a, b) => b.hits - a.hits);
}

// ---------- links ----------

const KEY_SEGMENTS = new Set(['job', 'jobs', 'careers', 'career', 'positions', 'position', 'openings', 'opening', 'opportunities',
  'opportunity', 'role', 'roles', 'vacancies', 'vacancy', 'job-openings', 'open-positions', 'open-roles', 'job-details', 'jobdetails', 'job-detail', 'jobdetail', 'requisitions', 'posting', 'postings']);
const STRICT_KEYS = new Set(['careers', 'career']);
const STOP_SEGMENTS = new Set(['search', 'all', 'list', 'teams', 'team', 'locations', 'location', 'departments', 'department', 'category',
  'categories', 'benefits', 'culture', 'life', 'students', 'student', 'university', 'graduates', 'early-careers', 'faq', 'faqs', 'about',
  'apply', 'alerts', 'job-alerts', 'saved', 'login', 'signin', 'register', 'perks', 'values', 'events', 'blog', 'people', 'diversity',
  'inclusion', 'how-we-hire', 'hiring-process', 'interview-process', 'internships', 'privacy', 'terms', 'jobs', 'job', 'careers', 'career',
  'openings', 'positions', 'opportunities', 'roles', 'index', 'home', 'filter', 'results', 'feed', 'rss', 'sitemap', 'en', 'en-us', 'en-in',
  'en-gb', 'page', 'open-positions', 'open-roles', 'job-openings', 'current-openings', 'join-us', 'join', 'why-join', 'offices', 'our-team',
  'our-culture', 'our-values', 'working-here', 'work-with-us', 'teams-and-roles', 'recruiting-fraud', 'fraud', 'scam', 'contact']);
const STOP_PREFIX = /^(life-|working-|how-|why-|our-|meet-|team-|teams-|benefits-|culture-|join-|about-|faq|privacy|terms|search|category-|department-|location-)/;
const LISTING_TOKENS = /(^|-)(jobs|openings|positions|roles|vacancies|opportunities|job-search|search-jobs|jobsearch)$/i;
const LISTING_TEXT = /\b(view|see|browse|explore|search|find|all|open|current)\b.*\b(jobs|roles|openings|positions|opportunities|vacancies)\b|^(current openings|job openings|all jobs|search jobs|job search|jobs)$/i;
const EMPLOYMENT = /^(full[- ]?time|part[- ]?time|contract(or)?|internship|intern|permanent|temporary|freelance|remote|hybrid|on-?site|new|hot|featured|urgent)$/i;
const NON_JOB_TITLE = /\b(early careers?|life at|our (team|teams|culture|values|story)|benefits|perks|how we hire|internships? (and|&) |students?|graduates? program|university|diversity|inclusion|why join|contact us|get in touch)\b|careers?$|^(explore|discover|learn|meet|find|see|read|join)\b/i;
const HAS_ID = /\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}-/i;

/** Score how much a URL/text looks like a job *listing* page (0 = not one). */
export function listingScore(url, text) {
  let u;
  try { u = new URL(url); } catch { return 0; }
  const segs = u.pathname.split('/').filter(Boolean).map((x) => x.toLowerCase());
  const last = segs[segs.length - 1] ?? '';
  let score = 0;
  if (LISTING_TOKENS.test(last)) score += 2;
  if (/^(jobs|careers)\./i.test(u.hostname) && segs.length <= 1) score += 1;
  if (LISTING_TEXT.test(String(text ?? '').trim())) score += 2;
  if (/(early|campus|student|intern|university|graduate|life|culture|benefit|value|how-we|about|blog|team$)/i.test(last)) score -= 3;
  return Math.max(0, score);
}
const GENERIC_TEXT = /^(here\.?|click here|this link|apply( now| here)?|learn more|read more|know more|view( job| details| role| position| opening)?|details|more( info)?|see (details|more|role)|careers?|jobs?|open (roles|positions)|join us|next|prev(ious)?|back|share|\d+|→|›|»)$/i;
const ROLE_WORDS = /\b(engineer|developer|manager|designer|analyst|lead|scientist|intern|internship|specialist|executive|associate|head|director|architect|consultant|officer|sde|sre|devops|product|marketing|sales|account|counsel|recruiter|writer|editor|researcher|administrator|operations|coordinator|representative|technician|accountant|partner|principal|staff|vp|president|trainee|fellow|strategist|advocate|support|success|agent|programmer|tester|qa)\b/i;

/** Is this path (+query) a job-detail page? */
export function isJobDetailUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.searchParams.has('gh_jid') || u.searchParams.has('jobId') || u.searchParams.has('job_id') || u.searchParams.has('jid')) return true;
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); } });
  for (let i = 0; i < segs.length - 1; i++) {
    if (!KEY_SEGMENTS.has(segs[i])) continue;
    const next = segs.slice(i + 1);
    // the most specific remaining segment (skip trailing "apply")
    const tail = next.filter((s) => s !== 'apply');
    const s = tail[tail.length - 1];
    if (!s || s.length < 3 || STOP_SEGMENTS.has(s) || STOP_PREFIX.test(s)) continue;
    if (tail.some((x) => STOP_SEGMENTS.has(x) && !KEY_SEGMENTS.has(x))) continue;
    if (/\.(pdf|png|jpe?g|svg|css|js|xml|json)$/.test(s)) continue;
    if (STRICT_KEYS.has(segs[i]) && !/\d/.test(s) && (s.match(/-/g) ?? []).length < 1) continue;
    return true;
  }
  // jobs.example.com/<slug-with-id>
  const host = u.hostname.toLowerCase();
  if (/^(jobs|careers|career)\./.test(host) && segs.length) {
    const s = segs[segs.length - 1];
    if (!STOP_SEGMENTS.has(s) && !STOP_PREFIX.test(s) && /\d{3,}/.test(s) && /[a-z]/.test(s)) return true;
  }
  return false;
}

function anchorSegments(inner) {
  const s = inner
    .replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(br|\/?(div|p|span|h[1-6]|li|ul|ol|small|strong|em|b|i|section|article|header|footer|td|tr|dd|dt|label|time))\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(s).split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x && !/^[|•·,\-–—/]+$/.test(x));
}

const looksLocation = (s) => s.length <= 80 && !(ROLE_WORDS.test(s) && s.split(' ').length >= 2) && (detectCountries(s).length > 0 || /^(remote|hybrid|on-?site|anywhere|worldwide)\b/i.test(s) || /\b(remote|hybrid)\b/i.test(s) && s.split(' ').length <= 5);

function titleFromSlug(url) {
  try {
    const segs = new URL(url).pathname.split('/').filter(Boolean);
    const s = decodeURIComponent(segs.filter((x) => x !== 'apply').pop() ?? '');
    const words = s.replace(/[_-]+/g, ' ').replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{4,}\b|\b\d{3,}\b/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!/[a-z]{3}/i.test(words) || words.split(' ').length < 2) return '';
    return words.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  } catch { return ''; }
}

/**
 * Title + location from an anchor's inner HTML (cards often wrap title, team and location).
 * @param {string} inner
 * @param {string} attrs anchor attributes (aria-label/title fallback)
 */
export function parseAnchor(inner, attrs = '') {
  const segs = anchorSegments(inner);
  const location = segs.find(looksLocation) ?? '';
  const candidates = segs.filter((s) => s !== location && !GENERIC_TEXT.test(s) && !EMPLOYMENT.test(s) && !looksLocation(s) && s.length >= 3 && s.length <= 140);
  let title = candidates.find((s) => ROLE_WORDS.test(s) && s.split(' ').length >= 2) ?? candidates.find((s) => ROLE_WORDS.test(s)) ?? candidates[0] ?? '';
  if (!title) title = (attr(attrs, 'aria-label') || attr(attrs, 'title') || '').trim();
  return { title, location, text: segs.join(' · ') };
}

/** Location-looking text right after an anchor (table rows / cards with the link on the title only). */
function trailingLocation(src, from) {
  const tail = src.slice(from, from + 600);
  const stop = tail.search(/<a\b|<\/(tr|li|article)\s*>/i);
  return anchorSegments(stop >= 0 ? tail.slice(0, stop) : tail).slice(0, 4).find(looksLocation) ?? '';
}

/**
 * Scan anchors: job-detail links on the same registrable domain, plus listing-page links.
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{jobs: {url: string, title: string, location: string}[], listings: string[]}}
 */
export function findLinks(html, pageUrl) {
  const base = baseUrlOf(html, pageUrl);
  const self = resolveHref(pageUrl, pageUrl);
  const jobs = new Map();
  const listings = new Map();
  const src = String(html ?? '');
  for (const m of src.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = attr(m[1], 'href');
    const url = href && resolveHref(href, base);
    if (!url || url === self || !sameSite(url, pageUrl)) continue;
    if (isJobDetailUrl(url)) {
      const a = parseAnchor(m[2], m[1]);
      if (!a.location) a.location = trailingLocation(src, m.index + m[0].length);
      const title = a.title || titleFromSlug(url);
      const prev = jobs.get(url);
      if (!prev) jobs.set(url, { url, title, location: a.location });
      else {
        if ((!prev.title || GENERIC_TEXT.test(prev.title)) && title) prev.title = title;
        if (!prev.location && a.location) prev.location = a.location;
      }
      continue;
    }
    const text = anchorSegments(m[2]).join(' ');
    const score = listingScore(url, text);
    if (score > 0) { const prev = listings.get(url) ?? 0; listings.set(url, Math.max(prev, score)); }
  }
  return {
    // a link counts as a posting when its title names a role or its URL carries an id
    jobs: [...jobs.values()].filter((j) => !NON_JOB_TITLE.test(j.title)).filter((j) => (j.title && ROLE_WORDS.test(j.title) && j.title.trim().split(/\s+/).length >= 2) || HAS_ID.test(new URL(j.url).pathname + new URL(j.url).search)),
    listings: [...listings].sort((a, b) => b[1] - a[1]).map(([u]) => u),
  };
}

// ---------- main content ----------

/**
 * Readable text of a job-detail page: <main>/<article>/[role=main] (else <body>) with
 * nav/header/footer/aside/form/script/style removed.
 * @param {string} html
 */
export function mainContentText(html) {
  let s = String(html ?? '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, '');
  const body = /<body\b[^>]*>([\s\S]*)<\/body\s*>/i.exec(s)?.[1] ?? s;
  const main = /<main\b[^>]*>([\s\S]*)<\/main\s*>/i.exec(body)?.[1]
    ?? /<[a-z]+\b[^>]*role=["']main["'][^>]*>([\s\S]*)/i.exec(body)?.[1]
    ?? /<article\b[^>]*>([\s\S]*)<\/article\s*>/i.exec(body)?.[1]
    ?? body;
  let out = main;
  for (let i = 0; i < 3; i++) out = out.replace(/<(nav|header|footer|aside|form)\b[^>]*>(?:(?!<\1\b)[\s\S])*?<\/\1\s*>/gi, '');
  return htmlToText(out);
}

/** Best page title: first <h1>, else og:title/<title> minus a " | Company" suffix. */
export function pageTitle(html) {
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(String(html ?? ''))?.[1];
  const t = h1 ? decodeEntities(h1.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
  if (t && t.length <= 140) return t;
  const ht = htmlTitle(String(html ?? '')) ?? '';
  return ht.split(/\s+[|–—-]\s+/)[0].trim();
}
