// Workday public career sites: {tenant}.wd{N}.myworkdayjobs.com/{site}.
// Uses the same JSON endpoints the public site calls (no login):
//   POST /wday/cxs/{tenant}/{site}/jobs  {"appliedFacets":{},"limit":20,"offset":0,"searchText":"..."}
//   GET  /wday/cxs/{tenant}/{site}{externalPath}
// Polite: robots.txt checked per host; one request in flight per Workday pod (wdN) across all
// companies with ≥0.5 s gaps; searchText per track title (≤4 terms × ≤3 pages) instead of paging
// the whole site. Results are partial (search), so workday jobs never miss-expire; they expire by age.
import { request, getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob } from '../job.js';
import { robotsAllows } from '../robots.js';

const PAGE = 20;
const MAX_TERMS = 4;
const MAX_PAGES = 3;
const DETAIL_CAP = 20;
const GAP_MS = 500;
const HOST_RE = /^([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,3})\.myworkdayjobs\.com$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

/**
 * Parse a Workday career-site URL ("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/...").
 * @param {string} url
 * @returns {{origin: string, tenant: string, pod: string, site: string, siteUrl: string, rest: string}|null}
 */
export function parseWorkdayUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const m = HOST_RE.exec(u.hostname.toLowerCase());
  if (u.protocol !== 'https:' || !m) return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts[0] && LOCALE_RE.test(parts[0]) && parts.length > 1) parts.shift();
  const site = parts.shift();
  if (!site || !/^[A-Za-z0-9_-]{1,100}$/.test(site) || site === 'wday') return null;
  return { origin: u.origin, tenant: m[1], pod: m[2], site, siteUrl: `${u.origin}/${site}`, rest: parts.length ? `/${parts.join('/')}` : '' };
}

/**
 * "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → ISO date.
 * @param {string} text
 * @param {number} [now]
 */
export function postedOnToISO(text, now = Date.now()) {
  const s = String(text ?? '').toLowerCase();
  const day = 86400000;
  const startOfDay = (t) => new Date(new Date(t).toISOString().slice(0, 10)).getTime();
  if (/\btoday\b|just posted/.test(s)) return new Date(startOfDay(now)).toISOString();
  if (/\byesterday\b/.test(s)) return new Date(startOfDay(now - day)).toISOString();
  const m = /(\d+)\+?\s*days?\s+ago/.exec(s);
  return m ? new Date(startOfDay(now - Number(m[1]) * day)).toISOString() : null;
}

const multiLoc = (t) => /^\d+\s+locations?$/i.test(String(t ?? '').trim());
/** "/job/India-Bengaluru/Title_JR1" → "India Bengaluru" (used when the list only says "2 Locations"). */
export const locationFromPath = (externalPath) => (/^\/job\/([^/]+)\//.exec(String(externalPath ?? ''))?.[1] ?? '').replace(/-+/g, ' ').trim();

/**
 * Normalise a /jobs listing page. Descriptions come from the detail endpoint (fetchOne).
 * @param {{jobPostings?: object[]}} payload
 * @param {{name: string, url: string}} company
 * @param {{now?: number}} [opts]
 */
export function normalize(payload, company, { now = Date.now() } = {}) {
  const w = parseWorkdayUrl(company.url);
  return (payload?.jobPostings ?? []).filter((p) => p?.title && p.externalPath).map((p) => {
    const job = makeJob({
      title: p.title,
      company: company.name,
      location: multiLoc(p.locationsText) || !p.locationsText ? locationFromPath(p.externalPath) : p.locationsText,
      url: w ? `${w.siteUrl}${p.externalPath}` : null,
      source: 'workday',
      sourceId: p.externalPath, // stable across list and detail (req ids can repeat across sites)
      postedAt: postedOnToISO(p.postedOn, now),
      description: '',
    });
    return { ...job, externalPath: p.externalPath, reqId: p.bulletFields?.[0] ?? null, ...(multiLoc(p.locationsText) ? { locationsText: p.locationsText } : {}) };
  });
}

/**
 * Normalise a job detail response (`{jobPostingInfo, hiringOrganization}`).
 * @param {object} detail
 * @param {{name: string, url: string}} company
 * @param {{now?: number, externalPath?: string}} [opts]
 */
export function normalizeDetail(detail, company, { now = Date.now(), externalPath } = {}) {
  const j = detail?.jobPostingInfo ?? {};
  const w = parseWorkdayUrl(company.url);
  const extra = (j.additionalLocations ?? []).filter((l) => typeof l === 'string');
  const cc = j.jobRequisitionLocation?.country?.alpha2Code ?? j.country?.alpha2Code;
  const job = makeJob({
    title: j.title,
    company: company.name,
    location: j.location ?? j.jobRequisitionLocation?.descriptor ?? '',
    locations: extra,
    countryHints: [cc, j.country?.descriptor].filter(Boolean),
    workModeField: /remote/i.test(j.remoteType ?? '') ? 'remote' : null,
    url: j.externalUrl ?? (w && externalPath ? `${w.siteUrl}${externalPath}` : null),
    applyUrl: j.externalUrl ? `${j.externalUrl.replace(/\/$/, '')}/apply` : null,
    source: 'workday',
    sourceId: externalPath ?? j.jobReqId ?? j.id,
    postedAt: j.startDate ?? postedOnToISO(j.postedOn, now),
    description: htmlToText(j.jobDescription ?? ''),
  });
  return job;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (w) => `${w.origin}/wday/cxs/${w.tenant}/${w.site}`;

// One request in flight per Workday pod (wd1, wd5, …) across all companies, with ≥gap between them:
// many tenants share a pod's infrastructure, so parallel companies must not multiply the load.
const pods = new Map(); // pod → {tail: Promise, last: number}
/** Run `fn` in the pod's queue (exported for tests). */
export function onPod(pod, gapMs, fn) {
  const q = pods.get(pod) ?? { tail: Promise.resolve(), last: 0 };
  pods.set(pod, q);
  const run = q.tail.then(async () => {
    const wait = q.last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    try { return await fn(); } finally { q.last = Date.now(); }
  });
  q.tail = run.catch(() => {});
  return run;
}

async function listPage(w, searchText, offset, opts) {
  return onPod(w.pod, opts.gapMs ?? GAP_MS, async () => (await request(`${api(w)}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText }),
    timeout: 20000, retries: 1, noRedirect: true, ...opts.http,
  })).json());
}

/**
 * Fetch jobs for a `{name, url}` Workday entry. `opts.searchTerms` (track titles) limit the
 * volume; `opts.wantDetail(job)` picks which postings get a detail request (max 20).
 * @param {{name: string, url: string, slug?: string}} company
 * @param {{searchTerms?: string[], wantDetail?: Function, http?: object, gapMs?: number, robots?: Function, now?: number}} [opts]
 */
export async function fetchJobs(company, opts = {}) {
  const w = parseWorkdayUrl(company.url);
  if (!w) throw new Error(`${company.name}: workday entries need "url": "https://<tenant>.wd<N>.myworkdayjobs.com/<site>"`);
  const gap = opts.gapMs ?? GAP_MS;
  const allowed = await (opts.robots ?? robotsAllows)(`${api(w)}/jobs`);
  if (!allowed) throw new Error(`${company.name}: robots.txt on ${w.origin} disallows the Workday jobs API`);
  const terms = [...new Set((opts.searchTerms?.length ? opts.searchTerms : ['']).map((t) => String(t).trim()))].slice(0, MAX_TERMS);
  const byPath = new Map();
  for (const term of terms) {
    for (let page = 0; page < MAX_PAGES; page++) {
      const d = await listPage(w, term, page * PAGE, opts);
      for (const j of normalize(d, company, opts)) if (!byPath.has(j.externalPath)) byPath.set(j.externalPath, j);
      if ((d.jobPostings ?? []).length < PAGE) break;
    }
  }
  const jobs = [...byPath.values()];
  // Details only for jobs the caller asked for (title matches); none when no wantDetail is given.
  const want = jobs.map((j, i) => [j, i]).filter(([j]) => opts.wantDetail?.(j) === true).slice(0, DETAIL_CAP);
  for (const [j, i] of want) {
    try {
      const d = await onPod(w.pod, gap, () => getJSON(`${api(w)}${j.externalPath}`, { timeout: 20000, retries: 1, noRedirect: true, ...opts.http }));
      const full = normalizeDetail(d, company, { ...opts, externalPath: j.externalPath });
      // The key stays the list-level one (title + company + list location) so a detail fetch never re-keys a job.
      jobs[i] = { ...full, key: j.key, sourceId: j.externalPath, ...(full.title ? {} : { title: j.title }) };
    } catch { /* keep the list record */ }
  }
  return jobs.map(({ externalPath, locationsText, reqId, ...j }) => j);
}

/** Fetch one posting by its public URL (".../<site>/job/<location>/<title>_<reqId>"). */
export async function fetchOne(url, opts = {}) {
  const w = parseWorkdayUrl(url);
  if (!w || !w.rest.startsWith('/job/')) throw new Error(`not a Workday job URL: ${url}`);
  const d = await onPod(w.pod, opts.gapMs ?? GAP_MS, () => getJSON(`${api(w)}${w.rest}`, { timeout: 20000, retries: 1, noRedirect: true, ...opts.http }));
  return normalizeDetail(d, { name: opts.companyName ?? d.hiringOrganization?.name ?? w.tenant, url: w.siteUrl }, { externalPath: w.rest });
}

/**
 * Verify a Workday site URL: one listing request. 404 = unknown site, 422 = unknown tenant.
 * @param {string} url
 * @returns {Promise<{ok: boolean, jobs: number, sample: string[], error?: string}>}
 */
export async function check(url, opts = {}) {
  const w = parseWorkdayUrl(url);
  if (!w) return { ok: false, jobs: 0, sample: [], error: 'not a Workday career-site URL (https://<tenant>.wd<N>.myworkdayjobs.com/<site>)' };
  try {
    if (!(await (opts.robots ?? robotsAllows)(`${api(w)}/jobs`))) return { ok: false, jobs: 0, sample: [], error: 'robots.txt disallows the jobs API' };
    const d = await listPage(w, '', 0, opts);
    const total = Number.isInteger(d.total) ? d.total : (d.jobPostings ?? []).length;
    return { ok: total > 0, jobs: total, sample: (d.jobPostings ?? []).map((p) => p.title).slice(0, 5), ...(total > 0 ? {} : { error: 'site has 0 open jobs' }) };
  } catch (err) {
    const why = err.status === 404 ? `no Workday site "${w.site}" for tenant ${w.tenant}` : err.status === 422 ? `no Workday tenant "${w.tenant}" on ${w.pod}` : err.message;
    return { ok: false, jobs: 0, sample: [], error: why };
  }
}
