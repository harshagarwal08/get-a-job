import path from 'node:path';
import { getJSON as httpGetJSON, mapLimit } from './http.js';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON } from '../lib/store.js';

export const ATS_LIST = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'recruitee'];
const LEGAL = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'gmbh', 'pvt', 'private', 'plc', 'sa', 'bv', 'ag']);
const SUFFIXES = new Set(['company', 'technologies', 'technology', 'tech', 'labs', 'lab', 'hq', 'ai', 'io', 'software', 'systems', 'group', 'the']);
const MAX_REQUESTS = 24;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const words = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
  .split(/[^A-Za-z0-9]+/).filter(Boolean);

/**
 * Slug candidates for a company name, most likely first.
 * "Acme Robotics AI" → acmeroboticsai, acmerobotics, acme-robotics-ai, acmeroboticshq, ...
 * @param {string} name
 * @param {string[]} [extra] known slugs to try first (--slug, YC slug, website label)
 * @returns {{lower: string[], cased: string[]}} lowercase slugs, plus case-preserving ones (SmartRecruiters is case-sensitive)
 */
function nameParts(name) {
  const w = words(name).map((x) => x.toLowerCase());
  while (w.length > 1 && LEGAL.has(w.at(-1))) w.pop();
  const core = [...w];
  while (core.length > 1 && SUFFIXES.has(core.at(-1))) core.pop();
  while (core.length > 1 && SUFFIXES.has(core[0])) core.shift();
  return { w, core };
}

export function slugCandidates(name, extra = []) {
  const { w, core } = nameParts(name);
  const c = core.join('');
  const lower = [
    ...extra.map((s) => String(s).toLowerCase()),
    w.join(''), c, w.join('-'), core.join('-'), `${c}hq`, `${c}ai`, `${c}-ai`, `${c}labs`, `get${c}`, `${c}app`,
  ];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const brandCased = words(name).slice(0, w.length);
  const cased = [...extra, brandCased.join(''), brandCased.map(cap).join(''), core.map(cap).join('')];
  const uniq = (a) => [...new Set(a.filter((s) => s && SLUG_RE.test(s)))];
  return { lower: uniq(lower), cased: uniq(cased) };
}

// [url, count(payload), boardName(payload)] per ATS.
const PROBES = {
  greenhouse: (s) => [`https://boards-api.greenhouse.io/v1/boards/${s}/jobs`, (d) => d.jobs?.length, (d) => d.jobs?.[0]?.company_name],
  lever: (s) => [`https://api.lever.co/v0/postings/${s}?mode=json`, (d) => (Array.isArray(d) ? d.length : undefined), () => null],
  ashby: (s) => [`https://api.ashbyhq.com/posting-api/job-board/${s}`, (d) => d.jobs?.length, () => null],
  workable: (s) => [`https://apply.workable.com/api/v1/widget/accounts/${s}`, (d) => d.jobs?.length, (d) => d.name],
  // SmartRecruiters returns 200 + 0 postings for unknown companies, so only count > 0 is "found".
  smartrecruiters: (s) => [`https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=1`, (d) => (d.totalFound > 0 ? d.totalFound : undefined), (d) => d.content?.[0]?.company?.name],
  recruitee: (s) => [`https://${s}.recruitee.com/api/offers/`, (d) => d.offers?.length, (d) => d.offers?.[0]?.company_name],
};

const PER_ATS_INFLIGHT = 3;
const WORKABLE_GAP_MS = 1000;
const DETECT_TTL = 7 * 86400 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-run probing state: per-ATS concurrency slots, the Workable request gap, and the
 * set of ATSs that answered 429 (skipped for the rest of the run).
 */
export function createSession({ workableGapMs = WORKABLE_GAP_MS } = {}) {
  return { slots: Object.fromEntries(ATS_LIST.map((a) => [a, { n: 0, queue: [] }])), skip: new Set(), workableAt: 0, workableGapMs };
}
const defaultSession = createSession();

async function withSlot(session, ats, fn) {
  const s = session.slots[ats];
  const limit = ats === 'workable' ? 1 : PER_ATS_INFLIGHT;
  if (s.n >= limit) await new Promise((r) => s.queue.push(r)); // slot handed over by the releaser
  else s.n++;
  try {
    if (ats === 'workable') {
      const wait = session.workableAt + session.workableGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      session.workableAt = Date.now();
    }
    return await fn();
  } finally {
    const next = s.queue.shift();
    if (next) next(); else s.n--;
  }
}

/**
 * Probe one ATS board. `jobs` is null if the board doesn't exist; "exists with 0 jobs"
 * gives 0 where the API distinguishes it (all but SmartRecruiters).
 * @returns {Promise<{jobs: number|null, boardName: string|null, rateLimited: boolean, skipped?: boolean}>}
 */
export async function probe(ats, slug, { getJSON = httpGetJSON, session = defaultSession } = {}) {
  const [url, count, nameOf] = PROBES[ats](encodeURIComponent(slug));
  if (session.skip.has(ats)) return { jobs: null, boardName: null, rateLimited: true, skipped: true };
  return withSlot(session, ats, async () => {
    if (session.skip.has(ats)) return { jobs: null, boardName: null, rateLimited: true, skipped: true };
    try {
      const d = await getJSON(url, { timeout: 6000, retries: 0 });
      const n = count(d);
      return Number.isInteger(n) ? { jobs: n, boardName: nameOf(d) ?? null, rateLimited: false } : { jobs: null, boardName: null, rateLimited: false };
    } catch (err) {
      if (err.status === 429) session.skip.add(ats);
      return { jobs: null, boardName: null, rateLimited: err.status === 429 }; // 404, timeout, DNS: not found
    }
  });
}

const squash = (s) => words(s).join('').toLowerCase();

/** Does an ATS board's display name plausibly belong to `name`? */
export function nameMatches(name, boardName) {
  const a = squash(name);
  const b = squash(boardName);
  if (!a || !b) return false;
  return a === b || nameParts(name).core.join('') === nameParts(boardName).core.join('');
}

/**
 * Confidence that a board belongs to `name`. A board whose display name merely equals the
 * slug we guessed proves nothing (any "linear" account is called "Linear"), so it's "unknown".
 */
export function confidenceFor(name, slug, boardName) {
  if (!boardName) return 'unknown';
  if (!nameMatches(name, boardName)) return 'low';
  return squash(boardName) === squash(slug) ? 'unknown' : 'high';
}

const CONF = { high: 0, unknown: 1, low: 2 };
/** Sort: boards with jobs first, then confidence (high > unknown > low), then job count. */
export const rankFound = (a, b) => ((b.jobs > 0) - (a.jobs > 0)) || (CONF[a.confidence] - CONF[b.confidence]) || (b.jobs - a.jobs);

function cacheFile() { return path.join(paths.dataDir, 'cache', 'detect.json'); }

/**
 * Try slug variants on every ATS (≤ 24 requests) and report every hit. Probes run in
 * rounds (best slug guess first, all ATSs in parallel) and stop at the first
 * high-confidence board with open jobs. Results are cached 7 days in data/cache/detect.json.
 * @param {string} name
 * @param {{slugs?: string[], getJSON?: Function, concurrency?: number, session?: object, cache?: boolean, now?: number}} [opts]
 * @returns {Promise<{name: string, found: {ats: string, slug: string, jobs: number, boardName: string|null, confidence: 'high'|'unknown'|'low'}[], tried: number, rateLimited?: string[], cached?: boolean}>}
 */
export async function detectCompany(name, { slugs = [], getJSON, concurrency = 12, session = defaultSession, cache = !getJSON, now = Date.now() } = {}) {
  const cacheKey = [squash(name), ...slugs.map((x) => String(x).toLowerCase())].join('|');
  if (cache) {
    let store = null;
    try { store = readJSON(cacheFile(), null); } catch { /* corrupt: ignore */ }
    const hit = store?.[cacheKey];
    if (hit && now - Date.parse(hit.at) >= 0 && now - Date.parse(hit.at) < DETECT_TTL) return { ...hit.result, cached: true };
  }
  const { lower, cased } = slugCandidates(name, slugs);
  const perAts = Math.floor(MAX_REQUESTS / ATS_LIST.length);
  const lists = Object.fromEntries(ATS_LIST.map((a) => [a, (a === 'smartrecruiters' ? cased : lower).slice(0, perAts)]));
  const results = [];
  let tried = 0;
  for (let i = 0; i < perAts; i++) {
    const round = ATS_LIST.filter((a) => lists[a][i] && !session.skip.has(a)).map((a) => [a, lists[a][i]]);
    if (!round.length) continue;
    const rs = await mapLimit(round, concurrency, async ([ats, slug]) => ({ ats, slug, ...(await probe(ats, slug, { getJSON, session })) }));
    tried += rs.filter((r) => !r.skipped).length;
    results.push(...rs);
    if (rs.some((r) => r.jobs > 0 && confidenceFor(name, r.slug, r.boardName) === 'high')) break;
  }
  const seen = new Set();
  const found = results.filter((r) => r.jobs !== null).filter((r) => {
    const k = `${r.ats}|${r.slug.toLowerCase()}`;
    return seen.has(k) ? false : seen.add(k);
  }).map(({ ats, slug, jobs, boardName }) => ({ ats, slug, jobs, boardName, confidence: confidenceFor(name, slug, boardName) }))
    .sort(rankFound);
  const rateLimited = [...new Set(results.filter((r) => r.rateLimited).map((r) => r.ats))];
  const result = { name, found, tried, ...(rateLimited.length ? { rateLimited } : {}) };
  if (cache && !rateLimited.length) {
    try {
      let store = {};
      try { store = readJSON(cacheFile(), {}) ?? {}; } catch { store = {}; }
      for (const [k, v] of Object.entries(store)) if (!(now - Date.parse(v.at) < DETECT_TTL)) delete store[k];
      store[cacheKey] = { at: new Date(now).toISOString(), result };
      writeJSON(cacheFile(), store);
    } catch { /* cache is best-effort */ }
  }
  return result;
}
