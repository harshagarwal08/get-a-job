// Careers-page crawler (`ats: "careers"`). See docs/CONTRACTS.md "Careers-page crawler".
// Pipeline per listing page: (1) JSON-LD JobPosting, (2) embedded supported-ATS board,
// (3) same-site job-detail links -> detail pages (JSON-LD or main text); one listing-link hop;
// (4) if nothing static works, render with headless Chrome and repeat 1-3.
import { makeJob, makeSalary, salaryUnit } from '../job.js';
import { matchTrack } from '../filter.js';
import { createFetcher, DeadlineError } from '../careers/fetcher.js';
import { createRenderer } from '../careers/render.js';
import {
  extractJsonLd, ldToFields, detectEmbeddedAts, findLinks, mainContentText, pageTitle, resolveHref, sameSite, registrableDomain,
} from '../careers/extract.js';

export const DETAIL_CAP = 25;
export const RENDER_DETAIL_CAP = 10;
const LISTING_RENDER_CAP = 2;
const THIN_TEXT = 300;
const SUPPORTED_ATS = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee', 'workday', 'keka', 'zohorecruit', 'successfactors'];

const isHtml = (r) => /html|xml/i.test(r.contentType) || /^\s*</.test(r.text);

function salaryOf(s) {
  if (!s) return null;
  return makeSalary(s.min, s.max, s.currency, salaryUnit(s.unit));
}

function expired(f, now) {
  const t = f.validThrough ? Date.parse(f.validThrough) : NaN;
  return Number.isFinite(t) && t < now;
}

/**
 * Normalise crawler records (JSON-LD JobPosting objects or `{title, url, location?, description?, ...}`).
 * @param {object[]} records
 * @param {{name: string}} company
 * @param {{pageUrl?: string}} [o]
 */
export function normalize(records, company, { pageUrl } = {}) {
  return (records ?? []).map((r) => {
    const f = r && r['@type'] ? ldToFields(r, pageUrl) : r;
    return makeJob({
      title: f.title,
      company: company.name,
      location: f.location ?? '',
      locations: f.locations ?? [],
      countryHints: f.countryHints ?? [],
      workModeField: f.workModeField ?? null,
      url: f.url ?? pageUrl,
      applyUrl: f.url ?? pageUrl,
      source: 'careers',
      sourceId: f.sourceId ?? f.url ?? null,
      department: f.department ?? null,
      salary: salaryOf(f.salary),
      postedAt: f.postedAt ?? null,
      description: f.description ?? '',
    });
  }).filter((j) => j.title);
}

/** Analyse one listing page's HTML (no network). */
export function analyzeListing(html, pageUrl) {
  const { postings, listUrls } = extractJsonLd(html);
  const ats = detectEmbeddedAts(html);
  const { jobs: links, listings } = findLinks(html, pageUrl);
  for (const u of listUrls) {
    const url = resolveHref(u, pageUrl);
    if (url && sameSite(url, pageUrl) && !links.some((l) => l.url === url)) links.push({ url, title: '', location: '' });
  }
  return { postings, embeddedAts: ats[0] ? { ats: ats[0].ats, slug: ats[0].slug, ...(ats[0].url ? { url: ats[0].url } : {}) } : null, atsCandidates: ats, links, listings };
}

function wantFilter(opts) {
  if (typeof opts.wantDetail === 'function') return (l) => !!opts.wantDetail({ title: l.title, location: l.location, url: l.url });
  if (Array.isArray(opts.tracks) && opts.tracks.length) return (l) => !!matchTrack(l.title, opts.tracks);
  return null;
}

/**
 * Crawl a careers listing URL.
 * @param {string} startUrl
 * @param {object} [opts]
 * @param {object[]} [opts.tracks] track objects; detail pages are fetched only for matching titles
 * @param {(j: object) => boolean} [opts.wantDetail] alternative to tracks
 * @param {number} [opts.detailCap] max static detail fetches (default 25)
 * @param {number} [opts.renderDetailCap] max rendered detail pages (default 10)
 * @param {boolean} [opts.render] allow headless Chrome (default true)
 * @param {object} [opts.deps] {fetchImpl, lookup, sleep, now, launch, timeoutMs, gapMs} test hooks
 * @returns {Promise<{records: object[], method: string, rendered: boolean, embeddedAts: {ats: string, slug: string}|null, pageUrl: string, notes: string[], stats: object}>}
 */
export async function crawl(startUrl, opts = {}) {
  const deps = opts.deps ?? {};
  const fetcher = createFetcher(deps);
  const renderer = createRenderer({ fetcher, launch: deps.launch, lookup: deps.lookup, dial: deps.dial });
  const detailCap = opts.detailCap ?? DETAIL_CAP;
  const renderDetailCap = opts.renderDetailCap ?? RENDER_DETAIL_CAP;
  const allowRender = opts.render !== false;
  const now = (deps.now ?? Date.now)();
  const notes = [];
  const want = wantFilter(opts);
  let detailFetches = 0;
  let detailRenders = 0;

  const done = (method, extra) => ({ method, rendered: false, embeddedAts: null, records: [], notes, ...extra,
    stats: { requests: fetcher.stats.requests, renders: renderer.stats.renders, detailFetches, detailRenders } });

  async function detail(link, listingRendered) {
    let html = null;
    let finalUrl = link.url;
    try {
      detailFetches++;
      const r = await fetcher.get(link.url);
      if (isHtml(r)) { html = r.text; finalUrl = r.url; }
    } catch (e) {
      if (e instanceof DeadlineError || e.code === 'ROBOTS') throw e;
      notes.push(`detail ${link.url}: ${e.message}`);
    }
    let rec = html ? fromDetail(html, finalUrl, link) : null;
    const thin = !rec || (!rec.fromLd && rec.description.length < THIN_TEXT);
    if (thin && allowRender && (listingRendered || html) && detailRenders < renderDetailCap) {
      try {
        detailRenders++;
        const r = await renderer.render(link.url);
        const rr = fromDetail(r.html, r.url, link);
        if (rr && (!rec || rr.fromLd || rr.description.length > rec.description.length)) rec = rr;
      } catch (e) {
        if (e.code === 'ROBOTS') throw e;
        notes.push(`render ${link.url}: ${e.message.split('\n')[0]}`);
      }
    }
    return rec ?? { title: link.title, location: link.location, url: link.url, description: '' };
  }

  function fromDetail(html, url, link) {
    const ld = extractJsonLd(html).postings[0];
    if (ld) {
      const f = ldToFields(ld, url);
      if (!f.title) f.title = link.title;
      if (!f.location) f.location = link.location;
      if (!f.url || !sameSite(f.url, url)) f.url = url;
      return { ...f, fromLd: true };
    }
    const text = mainContentText(html);
    return { title: link.title || pageTitle(html), location: link.location, url, description: text, fromLd: false };
  }

  async function fromLinks(links, rendered) {
    const filtered = want ? links.filter(want) : links;
    const chosen = filtered.slice(0, detailCap);
    const out = [];
    const plain = (l) => ({ title: l.title, location: l.location, url: l.url, description: '' });
    for (const l of chosen) {
      try { out.push(await detail(l, rendered)); } catch (e) {
        if (e instanceof DeadlineError) { notes.push('time budget reached; remaining detail pages listed without descriptions'); break; }
        if (e.code === 'ROBOTS') { notes.push(`robots.txt disallows ${l.url}`); out.push(plain(l)); continue; }
        throw e;
      }
    }
    // every link not detailed (not chosen, over the cap, or skipped by the time budget) stays as a plain link record
    const got = new Set(out.map((r) => r.url));
    for (const l of links) if (!got.has(l.url)) out.push(plain(l));
    // keep link records that were fetched but came back without a title out of the list
    return out.filter((r) => r.title);
  }

  /** Steps 1-3 on one HTML document. Returns a result or {listings}. */
  async function tryPage(html, pageUrl, rendered) {
    const a = analyzeListing(html, pageUrl);
    const live = a.postings.filter((p) => !expired(ldToFields(p, pageUrl), now));
    if (live.length) {
      // listing JSON-LD without descriptions: enrich via detail pages when they have their own URL
      const records = live.map((p) => {
        const f = ldToFields(p, pageUrl);
        if (!f.url || !sameSite(f.url, startUrl)) f.url = pageUrl; // never trust off-site urls from listing JSON-LD
        return f;
      });
      return done('jsonld', { rendered, pageUrl, records, atsCandidates: a.atsCandidates });
    }
    if (a.embeddedAts) return done('embedded-ats', { rendered, pageUrl, embeddedAts: a.embeddedAts, atsCandidates: a.atsCandidates });
    if (a.links.length) {
      const records = await fromLinks(a.links, rendered);
      if (records.length) return done('links', { rendered, pageUrl, records });
    }
    return { listings: a.listings.filter((u) => u !== pageUrl) };
  }

  try {
    const start = new URL(startUrl);
    if (start.protocol !== 'https:' && start.protocol !== 'http:') throw new Error('careers url must be http(s)');
    let staticFailed = null;
    let renderFailed = null;
    const tried = new Set();
    let listings = [];

    // static: listing page, then one listing-link hop
    let queue = [startUrl];
    for (let hop = 0; hop < 2 && queue.length; hop++) {
      const url = queue.shift();
      tried.add(url);
      try {
        const r = await fetcher.get(url);
        if (!isHtml(r)) { notes.push(`${url}: not HTML (${r.contentType})`); continue; }
        const res = await tryPage(r.text, r.url, false);
        if (res.method) return res;
        listings = [...listings, ...res.listings.filter((u) => !tried.has(u))];
        queue = res.listings.filter((u) => !tried.has(u)).slice(0, 1);
      } catch (e) {
        if (e.code === 'ROBOTS' && hop === 0) throw e;
        if (e instanceof DeadlineError) throw e;
        if (hop === 0) staticFailed = e;
        notes.push(`${url}: ${e.message}`);
        if (hop === 0 && /refusing|resolve/i.test(e.message)) throw e;
      }
    }

    // headless render
    if (allowRender) {
      const renderQueue = [...new Set([listings.find((u) => tried.has(u)) ?? null, startUrl].filter(Boolean))];
      const renderQueue0 = renderQueue[0];
      const rendered = new Set();
      for (let i = 0; i < LISTING_RENDER_CAP && renderQueue.length; i++) {
        const url = renderQueue.shift();
        if (rendered.has(url)) continue;
        rendered.add(url);
        let r;
        try { r = await renderer.render(url); } catch (e) {
          if ((e.code === 'ROBOTS' && url === startUrl) || e instanceof DeadlineError) throw e;
          notes.push(`render ${url}: ${e.message.split('\n')[0]}`);
          if (url === renderQueue0) renderFailed = e;
          break;
        }
        const res = await tryPage(r.html, r.url, true);
        if (res.method) return res;
        for (const u of res.listings) if (!rendered.has(u) && !renderQueue.includes(u)) renderQueue.push(u);
      }
    }
    // Failures must not look like an empty success (that would expire every job of the company).
    if (staticFailed) return done('none', { pageUrl: startUrl, failed: true, error: `could not fetch ${startUrl}: ${staticFailed.message}` });
    if (!allowRender) return done('none', { pageUrl: startUrl, failed: true, error: 'no jobs in the static HTML and headless rendering is disabled' });
    if (renderFailed) return done('none', { pageUrl: startUrl, failed: true, error: `headless rendering failed: ${renderFailed.message.split('\n')[0]}` });
    return done('none', { pageUrl: startUrl });
  } catch (e) {
    if (e instanceof DeadlineError) { notes.push(e.message); return done('none', { pageUrl: startUrl, failed: true, error: e.message }); }
    if (e.code === 'ROBOTS') return done('none', { pageUrl: startUrl, failed: true, error: e.message });
    throw e;
  } finally {
    await renderer.close();
  }
}

async function atsSource(ats, deps) {
  if (deps?.sources?.[ats]) return deps.sources[ats];
  if (!SUPPORTED_ATS.includes(ats)) throw new Error(`unsupported ats ${ats}`);
  return import(`./${ats}.js`);
}

function careersUrl(company) {
  const url = company?.url;
  if (!url) throw new Error(`${company?.name ?? 'company'}: careers entries need a "url"`);
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error(`${company.name}: careers url must be https`);
  return u.href;
}

/**
 * Fetch jobs for a `{name, slug, url}` careers entry.
 *
 * Returns NormalizedJob[] with `source: "careers"` for every job. The array carries a
 * non-enumerable `meta` property:
 *   jobs.meta = { method, rendered, delegatedTo: {ats, slug} | null, notes }
 * When the page embeds a supported ATS board, jobs come from that ATS's public API but are
 * re-tagged `source: "careers"` (so expiry stays keyed to this entry) with `via: "<ats>"`,
 * `delegatedTo` is set, and `opts.onEmbeddedAts({company, ats, slug})` is called so the
 * caller can suggest switching the entry to that ATS.
 *
 * Throws (never returns an empty "success") when the start URL could not be fetched
 * (network/5xx/robots/private host), when rendering was needed but failed or is disabled,
 * when the time budget ran out before any job was found, or when the crawl found no jobs
 * at all. (A delegated ATS board may legitimately return [].)
 * @param {{name: string, slug: string, url: string}} company
 * @param {object} [opts] see crawl(); plus `onEmbeddedAts(info)`
 */
export async function fetchJobs(company, opts = {}) {
  const r = await crawl(careersUrl(company), opts);
  const meta = { method: r.method, rendered: r.rendered, delegatedTo: null, notes: r.notes };
  let jobs;
  if (r.method === 'embedded-ats' && r.embeddedAts) {
    const delegatedTo = { ats: r.embeddedAts.ats, slug: r.embeddedAts.slug, ...(r.embeddedAts.url ? { url: r.embeddedAts.url } : {}) };
    meta.delegatedTo = delegatedTo;
    opts.onEmbeddedAts?.({ company: company.name, ...delegatedTo });
    const src = await atsSource(delegatedTo.ats, opts.deps);
    const raw = await src.fetchJobs({ ...company, ats: delegatedTo.ats, slug: delegatedTo.slug, url: delegatedTo.url ?? company.url }, opts);
    jobs = retag(raw, delegatedTo.ats);
  } else {
    if (r.failed || (r.error && !r.records.length)) throw new Error(`${company.name}: ${r.error}`);
    // A verified careers page that suddenly yields nothing is far more often a crawl/render
    // problem than a hiring freeze: fail instead of letting every job expire.
    if (r.method === 'none' || !r.records.length) throw new Error(`${company.name}: no jobs found on ${company.url} (treated as a failed crawl; jobs are not expired)`);
    jobs = dedupe(normalize(r.records, company, { pageUrl: r.pageUrl }));
  }
  Object.defineProperty(jobs, 'meta', { value: meta, enumerable: false });
  return jobs;
}

/** Delegated ATS jobs keep their data but report source "careers" (via = the ATS). */
function retag(jobs, ats) {
  return (jobs ?? []).map((j) => ({ ...j, source: 'careers', via: ats }));
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => (seen.has(j.key) ? false : seen.add(j.key)));
}

/**
 * Verify a careers URL. `jobs` is a count (like company:check); `results` holds the jobs.
 * @param {string} url
 * @param {object} [opts] crawl() opts; detailCap defaults to 5 here
 * @returns {Promise<{ok: boolean, url: string, jobs: number, sample: string[], method: string, rendered: boolean, embeddedAts?: {ats: string, slug: string, jobs: number|null, ok: boolean}, results: object[], notes: string[], error?: string}>}
 */
export async function checkCareers(url, opts = {}) {
  const name = opts.name ?? companyFromHost(url);
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('careers url must be https');
    const r = await crawl(u.href, { detailCap: 5, renderDetailCap: 3, ...opts });
    const base = { url: u.href, method: r.rendered ? `headless+${r.method}` : r.method, rendered: r.rendered, notes: r.notes, stats: r.stats };
    if (r.method === 'embedded-ats' && r.embeddedAts) {
      let jobs = [];
      let error;
      try {
        const src = await atsSource(r.embeddedAts.ats, opts.deps);
        jobs = retag(await src.fetchJobs({ name, slug: r.embeddedAts.slug, ...(r.embeddedAts.url ? { url: r.embeddedAts.url } : {}) }, { http: { retries: 1 } }), r.embeddedAts.ats);
      } catch (e) { error = e.message; }
      const ok = jobs.length > 0;
      return { ...base, ok, jobs: jobs.length, sample: [...new Set(jobs.map((j) => j.title))].slice(0, 5), results: jobs,
        embeddedAts: { ...r.embeddedAts, jobs: jobs.length, ok },
        ...(ok ? {} : { error: error ?? `page embeds ${r.embeddedAts.ats}/${r.embeddedAts.slug} but that board returned 0 jobs` }) };
    }
    const results = dedupe(normalize(r.records, { name }, { pageUrl: r.pageUrl }));
    const ok = results.length > 0;
    return { ...base, ok, jobs: results.length, sample: [...new Set(results.map((j) => j.title))].slice(0, 5), results,
      ...(ok ? {} : { error: r.error ?? 'no job postings found (no JSON-LD, embedded ATS board, or job links)' }) };
  } catch (e) {
    return { ok: false, url, jobs: 0, sample: [], method: 'none', rendered: false, results: [], notes: [], error: e.message };
  }
}

function companyFromHost(url) {
  try {
    const d = registrableDomain(new URL(url).hostname).split('.')[0];
    return d.charAt(0).toUpperCase() + d.slice(1);
  } catch { return 'Unknown'; }
}

/**
 * Fetch one careers-site job page (JSON-LD JobPosting, else main-content text).
 * @param {string} url
 * @param {{companyName?: string, deps?: object, render?: boolean}} [opts]
 */
export async function fetchOne(url, opts = {}) {
  const fetcher = createFetcher({ ...(opts.deps ?? {}), timeoutMs: 30_000 });
  const r = await fetcher.get(url);
  let html = r.text;
  let finalUrl = r.url;
  let ld = extractJsonLd(html).postings[0];
  if (!ld && mainContentText(html).length < THIN_TEXT && opts.render !== false) {
    const renderer = createRenderer({ fetcher, launch: opts.deps?.launch, lookup: opts.deps?.lookup });
    try { const rr = await renderer.render(url); html = rr.html; finalUrl = rr.url; ld = extractJsonLd(html).postings[0]; } catch { /* keep static */ } finally { await renderer.close(); }
  }
  const f = ld ? ldToFields(ld, finalUrl) : { title: pageTitle(html), location: '', url: finalUrl, description: mainContentText(html) };
  if (!f.url || !sameSite(f.url, finalUrl)) f.url = finalUrl;
  const name = opts.companyName ?? f.hiringOrganization ?? companyFromHost(finalUrl);
  const [job] = normalize([f], { name }, { pageUrl: finalUrl });
  if (!job) throw new Error(`no job title found at ${url}`);
  return job;
}
