import fs from 'node:fs';
import path from 'node:path';
import { parse, out, fail } from '../lib/args.js';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON, nowISO, withLock } from '../lib/store.js';
import { mapLimit } from './http.js';
import { classify, eligibility, matchJobTrack } from './filter.js';
import { consolidate, mergeJobs, SEARCH_SOURCES } from './merge.js';
import { recognizeUrl, hostClass } from './urls.js';
import { fetchGeneric } from './generic.js';
import * as greenhouse from './sources/greenhouse.js';
import * as lever from './sources/lever.js';
import * as ashby from './sources/ashby.js';
import * as workable from './sources/workable.js';
import * as linkedin from './sources/linkedin.js';
import * as smartrecruiters from './sources/smartrecruiters.js';
import * as recruitee from './sources/recruitee.js';
import * as hn from './boards/hn.js';
import * as arbeitnow from './boards/arbeitnow.js';
import * as remotive from './boards/remotive.js';
import * as remoteok from './boards/remoteok.js';
import { detectCompany, ATS_LIST, probe } from './detect.js';
import * as googlejobs from './providers/googlejobs.js';
import * as apify from './providers/apify.js';
import * as jobspy from './providers/jobspy.js';
import { isOn } from './providers/common.js';
import { fundedStatus } from '../funded/funded.js';
import { importJobs, importPathAllowed } from './importer.js';
import { recordCareersCheck, recentCareersCheck } from './careersChecks.js';
import { URL_ATS, URL_ATS_LIST, validateAtsUrl, classifyAtsUrl } from './urlAts.js';
import { detectEmbeddedAts } from './careers/extract.js';
import { validateCompany, loadCompaniesFile, saveCompaniesFile, addCompanies, filterCompanies, COMPANY_ATS } from './companies.js';
import { loadYc, filterYc, mapRegions, batchCode, stageFor, tagsFor, websiteLabel } from './yc.js';

const SOURCES = { greenhouse, lever, ashby, workable, smartrecruiters, recruitee, linkedin, ...URL_ATS };
// [source, preferences key, module, paid]
const PROVIDERS = [['google-jobs', 'googleJobs', googlejobs, true], ['apify', 'apify', apify, true], ['jobspy', 'jobspy', jobspy, false]];

// The careers-page crawler (src/scrape/sources/careers.js) is built separately; load it lazily.
let careersModule;
/** Load the careers crawler module, or null if it isn't installed. */
export async function loadCareers() {
  if (careersModule !== undefined) return careersModule;
  try {
    careersModule = await import('./sources/careers.js');
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' || !String(err.message).includes('careers.js')) throw err;
    careersModule = null;
  }
  return careersModule;
}
/** Test hook: replace the careers module (pass undefined to reset). */
export function setCareersModule(mod) { careersModule = mod; }
async function sourceFor(ats) {
  if (ats !== 'careers') return SOURCES[ats];
  const mod = await loadCareers();
  if (!mod) throw new Error('the careers-page crawler (src/scrape/sources/careers.js) is not installed');
  return mod;
}
const BOARDS = { hn, arbeitnow, remotive, remoteok };
const STATUSES = ['new', 'skipped', 'ranked', 'tracked', 'expired'];
const FITS = ['high', 'medium', 'low'];
const VERDICTS = ['Strong', 'Good', 'Moderate', 'Weak', 'Poor'];
const EMOJI = { green: '🟢', orange: '🟠', unknown: '⚪' };
const ELIG = { green: 0, unknown: 1, orange: 2 };
const LINKEDIN_DETAIL_CAP = 25;
const ATS = ATS_LIST;
const rel = (file) => path.relative(paths.root, file) || '.';

const warn = (m) => process.stderr.write(`warning: ${m}\n`);
const loadStore = () => readJSON(paths.jobs, () => ({ version: 1, updatedAt: null, jobs: {} }));

function loadPrefs() {
  const prefs = readJSON(paths.preferences);
  if (!prefs) fail('profile/preferences.json not found. Run /onboard first (or copy examples/preferences.example.json to profile/preferences.json).');
  return prefs;
}

function loadCompanies() {
  const { cfg, fromExample } = loadCompaniesFile();
  if (!fs.existsSync(paths.companies)) {
    if (!fromExample) fail('config/companies.json not found (and no companies.example.json to fall back to).');
    warn('config/companies.json not found; using config/companies.example.json. Copy it to config/companies.json and edit it.');
  }
  return cfg.companies ?? [];
}

function intOpt(v, name, min = 0) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v === '' || !Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}`);
  return n;
}

function age(iso) {
  if (!iso) return '?';
  const d = Math.floor((Date.now() - new Date(iso)) / 86400000);
  return d <= 0 ? 'today' : `${d}d`;
}

const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad = (s, n) => cut(s, n).padEnd(n);

/** Sort: rank score desc, then green first, then newest. */
export function sortJobs(list) {
  const ts = (j) => new Date(j.postedAt ?? j.firstSeen ?? 0).getTime() || 0;
  return [...list].sort((a, b) => ((b.rank?.score ?? -1) - (a.rank?.score ?? -1))
    || ((ELIG[a.eligibility] ?? 1) - (ELIG[b.eligibility] ?? 1))
    || (ts(b) - ts(a)));
}

/** Strip descriptions and internal fields for listings. */
const listView = ({ description, missCount, sourceIds, ...rest }) => rest;

// ---------- scrape ----------

/** Track titles interleaved across tracks (t1[0], t2[0], t1[1], ...), used as server-side search terms. */
export function searchTermsFor(prefs, trackId) {
  const tracks = (prefs.tracks ?? []).filter((t) => !trackId || t.id === trackId);
  const out = [];
  const max = Math.max(0, ...tracks.map((t) => (t.titles ?? []).length));
  for (let i = 0; i < max; i++) for (const t of tracks) if (t.titles?.[i] && !out.includes(t.titles[i])) out.push(t.titles[i]);
  return out;
}

async function scrapeCompany(c, prefs, opts, acc) {
  const src = await sourceFor(c.ats);
  if (!src || c.ats === 'linkedin') throw new Error(`unknown ats "${c.ats}"`);
  const onEmbeddedAts = ({ ats, slug, url }) => acc.warnings.push(`${c.name}: careers page embeds ${ats}/${slug}; switch the entry with companies:add --name "${c.name}" --ats ${ats} --slug ${slug}${url ? ` --url ${url}` : ''} --merge`);
  // A throwing fetchJobs (careers crawl failure included) is a failed company: no expiry bookkeeping.
  const raw = await src.fetchJobs(c, { wantDetail: (j) => !!matchJobTrack(j, prefs.tracks ?? []), onEmbeddedAts, searchTerms: searchTermsFor(prefs, opts.trackId) });
  const jobs = consolidate(raw, prefs);
  // Expiry is keyed on each job's actual source (the entry's own ATS is always marked as scraped).
  const bySrc = new Map([[c.ats, new Set()]]);
  for (const j of jobs) { if (!bySrc.has(j.source)) bySrc.set(j.source, new Set()); bySrc.get(j.source).add(j.key); }
  // Search-based results (workday/successfactors, or a careers page delegating to one) are partial:
  // they only refresh lastSeen and never count as misses; those jobs expire by age.
  const partial = SEARCH_SOURCES.has(c.ats) || SEARCH_SOURCES.has(raw.meta?.delegatedTo?.ats);
  for (const [source, seenKeys] of bySrc) acc.scraped.push({ company: c.name, source, seenKeys, ...(partial ? { missExpiry: false } : {}) });
  acc.bySource[c.ats] ??= { companies: 0, jobs: 0 };
  acc.bySource[c.ats].companies++;
  acc.bySource[c.ats].jobs += raw.length;
  classifyInto(jobs, prefs, opts, acc);
}

function classifyInto(jobs, prefs, opts, acc) {
  for (const j of jobs) {
    const r = classify(j, prefs, opts);
    if (!r.keep) {
      acc.filtered[r.reason] = (acc.filtered[r.reason] ?? 0) + 1;
      if (r.reason === 'title' || r.reason === 'workMode') acc.noLongerMatching.add(j.key);
      continue;
    }
    const { matchText, firstLine, ...rest } = j;
    acc.kept.push({ ...rest, track: r.track });
  }
}

/** Query-based job boards (preferences.sources.<board> === true). One failing board never aborts. */
async function scrapeBoards(prefs, opts, acc) {
  for (const [name, board] of Object.entries(BOARDS)) {
    if (!isOn(prefs.sources?.[name])) continue;
    try {
      const res = await board.fetchJobs();
      const jobs = consolidate(res.jobs, prefs);
      const seenKeys = new Set(jobs.map((j) => j.key));
      acc.scraped.push(name === 'hn'
        ? { company: null, source: 'hn', seenKeys, expireIf: (job) => !!job.hnThread && job.hnThread !== res.threadId }
        : { company: null, source: name, seenKeys, missExpiry: false });
      acc.bySource[name] = { board: true, jobs: res.jobs.length };
      // HN threads are monthly; every comment in the current thread counts regardless of age.
      classifyInto(jobs, prefs, name === 'hn' ? { ...opts, ignoreAge: true } : opts, acc);
    } catch (err) {
      acc.errors.push({ company: `${name} board`, source: name, error: err.message });
    }
  }
}

/** Opt-in paid/aggregator providers (googleJobs, apify, jobspy). Missing keys skip with a warning. */
async function scrapeProviders(prefs, opts, acc) {
  const skippedPaid = [];
  for (const [source, prefKey, mod, paid] of PROVIDERS) {
    if (!isOn(prefs.sources?.[prefKey])) continue;
    if (paid && !opts.allowPaid) { skippedPaid.push(prefKey); continue; }
    try {
      const res = await mod.fetchJobs(prefs, { trackId: opts.trackId });
      acc.usage.push(res.usage);
      if (res.warning) acc.warnings.push(res.warning);
      if (!res.jobs.length && res.warning) continue;
      const jobs = consolidate(res.jobs, prefs);
      acc.scraped.push({ company: null, source, seenKeys: new Set(jobs.map((j) => j.key)), missExpiry: false });
      acc.bySource[source] = { provider: true, jobs: res.jobs.length };
      classifyInto(jobs, prefs, opts, acc);
    } catch (err) {
      acc.errors.push({ company: `${source} provider`, source, error: err.message });
    }
  }
  if (skippedPaid.length) acc.warnings.push(`paid providers skipped (pass --paid): ${skippedPaid.join(', ')}`);
}

async function scrapeLinkedIn(prefs, opts, acc) {
  const tracks = (prefs.tracks ?? []).filter((t) => !opts.trackId || t.id === opts.trackId);
  const days = opts.days ?? prefs.sources?.maxAgeDays ?? 14;
  const seen = new Set();
  const matched = [];
  acc.bySource.linkedin = { searches: 0, jobs: 0 };
  for (const t of tracks) {
    const keywords = t.titles?.[0] ?? t.name;
    try {
      const raw = await linkedin.fetchJobs({ keywords, location: prefs.location?.based ?? '' }, { days: days || 1, limit: 50 });
      acc.bySource.linkedin.searches++;
      acc.bySource.linkedin.jobs += raw.length;
      for (const j of consolidate(raw, prefs)) {
        if (seen.has(j.key)) continue;
        seen.add(j.key);
        const r = classify(j, prefs, opts);
        if (!r.keep) { acc.filtered[r.reason] = (acc.filtered[r.reason] ?? 0) + 1; continue; }
        matched.push({ ...j, track: r.track });
      }
    } catch (err) {
      acc.errors.push({ company: `LinkedIn search "${keywords}"`, source: 'linkedin', error: err.message });
    }
  }
  for (const [i, j] of matched.entries()) {
    if (i < LINKEDIN_DETAIL_CAP) {
      try {
        const full = await linkedin.fetchOne(j.sourceId);
        j.description = full.description;
        Object.assign(j, eligibility(j, prefs));
        await new Promise((r) => setTimeout(r, 1000));
      } catch { /* keep the card without a description */ }
    }
    acc.kept.push(j);
  }
}

function scrapeHuman(s) {
  const boards = Object.entries(s.sources).filter(([, v]) => v.board).map(([k]) => k);
  const lines = [`Scraped ${s.companies} compan${s.companies === 1 ? 'y' : 'ies'}${boards.length ? ` and ${boards.length} board${boards.length === 1 ? '' : 's'} (${boards.join(', ')})` : ''} at ${s.at}`];
  for (const [src, v] of Object.entries(s.sources)) {
    const what = v.provider ? 'provider     ' : v.board ? 'board        ' : v.searches !== undefined ? `${String(v.searches).padStart(3)} searches ` : `${String(v.companies).padStart(3)} companies`;
    lines.push(`  ${src.padEnd(15)} ${what}  ${String(v.jobs).padStart(5)} postings  ${String(v.matched ?? 0).padStart(4)} matched`);
  }
  const f = Object.entries(s.filtered).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  lines.push(`Matched ${s.matched}: new ${s.new}, updated ${s.updated}, expired ${s.expired}, skipped ${s.skipped}${s.crossSource ? `, ${s.crossSource} already known from another source` : ''}. Filtered out: ${f}.`);
  if (s.usage?.length) lines.push(`Usage: ${s.usage.join('; ')}`);
  for (const w of s.warnings ?? []) lines.push(`  ! ${w}`);
  if (s.limited) lines.push(`(--limit kept the newest ${s.matched} of ${s.limited} matches)`);
  if (s.errors.length) {
    lines.push(`Errors (${s.errors.length}):`);
    for (const e of s.errors) lines.push(`  ✗ ${e.company} (${e.source}): ${e.error}`);
  }
  if (s.topNew.length) {
    lines.push('Top new green jobs:');
    for (const j of s.topNew) lines.push(`  🟢 ${cut(j.title, 50)} | ${j.company} | ${cut(j.location, 30)}  [${j.key}]`);
  } else if (s.new) lines.push('No new green jobs this run.');
  const fd = s.funded;
  if (fd?.enabled) {
    const last = fd.lastSearchAt ? `last searched ${fd.daysSince} day(s) ago` : 'never searched';
    lines.push(`Funded startups: ${last}${fd.due ? ' - due, run /funded' : ''}; ${fd.newLeads} lead(s) not contacted yet (gaj funded).`);
  }
  lines.push(`Saved to ${rel(paths.jobs)}. Next: gaj jobs --eligibility green`);
  return lines.join('\n');
}

async function scrape(argv) {
  const a = parse(argv, { track: { type: 'string' }, days: { type: 'string' }, limit: { type: 'string' }, company: { type: 'string' }, concurrency: { type: 'string' }, paid: { type: 'boolean' } });
  const prefs = loadPrefs();
  const opts = { trackId: a.track, days: intOpt(a.days, 'days'), allowPaid: !!a.paid || process.env.GAJ_ALLOW_PAID === '1' };
  const limit = intOpt(a.limit, 'limit', 1);
  if (opts.trackId && !(prefs.tracks ?? []).some((t) => t.id === opts.trackId)) fail(`unknown track "${opts.trackId}". Tracks: ${(prefs.tracks ?? []).map((t) => t.id).join(', ')}`);

  let companies = prefs.sources?.ats === false ? [] : loadCompanies();
  if (!isOn(prefs.sources?.careersPages ?? true)) companies = companies.filter((c) => c.ats !== 'careers');
  if (a.company) {
    const wanted = a.company.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    companies = companies.filter((c) => wanted.some((w) => c.name.toLowerCase().includes(w) || c.slug?.toLowerCase() === w));
    if (!companies.length) fail(`no company in your list matches "${a.company}"`);
  }

  const acc = { kept: [], scraped: [], bySource: {}, filtered: {}, errors: [], noLongerMatching: new Set(), usage: [], warnings: [] };
  await mapLimit(companies, Math.min(8, intOpt(a.concurrency, 'concurrency') || 4), async (c) => {
    try { await scrapeCompany(c, prefs, opts, acc); } catch (err) { acc.errors.push({ company: c.name, source: c.ats, error: err.message }); }
  });
  if (!a.company) await scrapeBoards(prefs, opts, acc);
  if (!a.company) await scrapeProviders(prefs, opts, acc);
  if (isOn(prefs.sources?.linkedin) && !a.company) await scrapeLinkedIn(prefs, opts, acc);

  let kept = acc.kept.sort((x, y) => String(y.postedAt ?? '').localeCompare(String(x.postedAt ?? '')));
  const total = kept.length;
  if (limit !== undefined && kept.length > limit) kept = kept.slice(0, limit);
  for (const j of kept) if (acc.bySource[j.source]) acc.bySource[j.source].matched = (acc.bySource[j.source].matched ?? 0) + 1;

  const now = nowISO();
  const maxAge = prefs.sources?.maxAgeDays;
  // Read-modify-write under the jobs.json lock (scheduled scrape, tracker and CLI can overlap).
  const { store, stats } = await withLock(paths.jobs, async () => {
    const r = mergeJobs(loadStore(), kept, {
      now, scraped: acc.scraped, noLongerMatching: acc.noLongerMatching,
      boardExpireDays: maxAge ? maxAge * 2 : 30,
    });
    writeJSON(paths.jobs, r.store);
    return r;
  });

  const topNew = sortJobs(stats.newKeys.map((k) => store.jobs[k]).filter((j) => j.eligibility === 'green')).slice(0, 10)
    .map((j) => ({ key: j.key, title: j.title, company: j.company, location: j.location, track: j.track }));
  const summary = {
    at: now, companies: companies.length, sources: acc.bySource, matched: kept.length,
    limited: kept.length < total ? total : undefined,
    new: stats.new, updated: stats.updated, expired: stats.expired, skipped: stats.skipped, crossSource: stats.crossSource, filtered: acc.filtered,
    errors: acc.errors, usage: acc.usage, warnings: acc.warnings, topNew,
    funded: a.company ? undefined : fundedStatus(prefs),
  };
  out(summary, a.json, scrapeHuman);
}

// ---------- jobs / job / jobs:set ----------

function jobsTable(list) {
  if (!list.length) return 'No jobs match. Run "gaj scrape" or loosen the filters.';
  const head = `E   ${pad('FIT', 6)} ${pad('SCORE', 5)}  ${pad('TITLE', 40)}  ${pad('COMPANY', 16)}  ${pad('LOCATION', 28)}  ${pad('AGE', 5)}  KEY`;
  const rows = list.map((j) => `${EMOJI[j.eligibility] ?? '⚪'}  ${pad(j.quickFit ?? '-', 6)} ${pad(j.rank?.score ?? '-', 5)}  ${pad(j.title, 40)}  ${pad(j.company, 16)}  ${pad(j.location, 28)}  ${pad(age(j.postedAt ?? j.firstSeen), 5)}  ${j.key}`);
  return [head, ...rows].join('\n');
}

async function jobs(argv) {
  const a = parse(argv, { status: { type: 'string' }, eligibility: { type: 'string' }, track: { type: 'string' }, limit: { type: 'string' } });
  if (a.status && !STATUSES.includes(a.status)) fail(`--status must be one of ${STATUSES.join(', ')}`);
  if (a.eligibility && !(a.eligibility in EMOJI)) fail('--eligibility must be green, orange or unknown');
  const limit = intOpt(a.limit, 'limit', 1);
  let list = Object.values(loadStore().jobs ?? {});
  list = list.filter((j) => (a.status ? j.status === a.status : j.status !== 'expired'));
  if (a.eligibility) list = list.filter((j) => j.eligibility === a.eligibility);
  if (a.track) list = list.filter((j) => j.track === a.track);
  list = sortJobs(list);
  if (limit !== undefined) list = list.slice(0, limit);
  out(list.map(listView), a.json, jobsTable);
}

function findJob(store, key) {
  if (!key) fail('missing job key');
  if (store.jobs[key]) return store.jobs[key];
  const aliased = Object.values(store.jobs).find((j) => j.aliases?.includes(key));
  if (aliased) return aliased;
  const hits = Object.keys(store.jobs).filter((k) => k.startsWith(key));
  if (hits.length === 1) return store.jobs[hits[0]];
  fail(hits.length ? `"${key}" matches ${hits.length} jobs; be more specific` : `no job with key "${key}"`);
}

function jobHuman(j) {
  const sal = j.salary ? `${j.salary.currency ?? ''} ${j.salary.min}-${j.salary.max} / ${j.salary.unit}`.trim() : 'not listed';
  return [
    `${j.title} | ${j.company}`,
    `key:         ${j.key}`,
    `location:    ${j.location || '?'} (${j.workMode}) ${j.countries?.length ? `[${j.countries.join(', ')}]` : ''}`,
    `eligibility: ${EMOJI[j.eligibility] ?? '⚪'} ${j.eligibility}: ${j.eligibilityReason}`,
    `track:       ${j.track ?? '-'}   status: ${j.status}   quickFit: ${j.quickFit ?? '-'}   rank: ${j.rank ? `${j.rank.score} (${j.rank.verdict})` : '-'}`,
    `salary:      ${sal}`,
    `posted:      ${j.postedAt ?? '?'}   first seen: ${j.firstSeen}   source: ${j.source}`,
    `url:         ${j.url}`,
    j.applyUrl && j.applyUrl !== j.url ? `apply:       ${j.applyUrl}` : null,
    '',
    j.description || '(no description)',
  ].filter((l) => l !== null).join('\n');
}

async function job(argv) {
  const a = parse(argv);
  const { missCount, sourceIds, ...j } = findJob(loadStore(), a._[0]);
  out(j, a.json, jobHuman);
}

const GATES = {
  eligibility: ['pass', 'flag', 'fail'],
  compensation: ['pass', 'flag', 'fail', 'unknown'],
  notice: ['pass', 'flag', 'unknown'],
};
const DIMENSIONS = ['technical', 'experience', 'culture', 'career'];

/** Verdict band for a 0-100 score (Strong ≥75, Good 60–74, Moderate 45–59, Weak 30–44, Poor <30). */
export function verdictFor(score) {
  return score >= 75 ? 'Strong' : score >= 60 ? 'Good' : score >= 45 ? 'Moderate' : score >= 30 ? 'Weak' : 'Poor';
}

const pct = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
const strArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Strictly validate a rank object (see CONTRACTS). Returns an error message or null.
 * @param {object} r
 * @returns {string|null}
 */
export function validateRank(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return 'rank file must contain a JSON object';
  if (!pct(r.score)) return 'rank.score must be a number from 0 to 100';
  if (!VERDICTS.includes(r.verdict)) return `rank.verdict must be one of ${VERDICTS.join(', ')}`;
  const band = verdictFor(r.score);
  if (r.verdict !== band) return `rank.verdict "${r.verdict}" doesn't match score ${r.score} (expected "${band}": Strong >=75, Good 60-74, Moderate 45-59, Weak 30-44, Poor <30)`;
  if (!r.dimensions || typeof r.dimensions !== 'object') return `rank.dimensions must be an object with ${DIMENSIONS.join(', ')}`;
  for (const d of DIMENSIONS) if (!pct(r.dimensions[d])) return `rank.dimensions.${d} must be a number from 0 to 100`;
  if (!r.gates || typeof r.gates !== 'object') return `rank.gates must be an object with ${Object.keys(GATES).join(', ')}`;
  for (const [g, allowed] of Object.entries(GATES)) if (!allowed.includes(r.gates[g])) return `rank.gates.${g} must be one of ${allowed.join(', ')}`;
  for (const f of ['strengths', 'gaps']) if (r[f] !== undefined && !strArray(r[f])) return `rank.${f} must be an array of strings`;
  if (r.note !== undefined && typeof r.note !== 'string') return 'rank.note must be a string';
  if (r.rankedAt !== undefined && Number.isNaN(Date.parse(r.rankedAt))) return 'rank.rankedAt must be an ISO date';
  return null;
}

function readJSONFile(file, what) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`cannot read ${what} ${file}: ${e.message}`); }
}

function quickFitBatch(store, file, asJson) {
  const map = readJSONFile(file, 'quick-fit file');
  if (!map || typeof map !== 'object' || Array.isArray(map)) fail('quick-fit file must be a JSON object {"<key>": "high|medium|low"}');
  const updates = [];
  for (const [key, fit] of Object.entries(map)) {
    if (fit !== null && !FITS.includes(fit)) fail(`quick fit for "${key}" must be high, medium, low or null (got ${JSON.stringify(fit)})`);
    const j = store.jobs[key] ?? Object.values(store.jobs).find((x) => x.aliases?.includes(key));
    if (!j) fail(`no job with key "${key}" (nothing was written)`);
    updates.push([j.key, fit]);
  }
  for (const [key, fit] of updates) store.jobs[key] = { ...store.jobs[key], quickFit: fit };
  store.updatedAt = nowISO();
  writeJSON(paths.jobs, store);
  out({ updated: updates.length, keys: updates.map(([k]) => k) }, asJson, () => `Set quick fit on ${updates.length} job${updates.length === 1 ? '' : 's'}.`);
}

async function jobsSet(argv) {
  const a = parse(argv, { status: { type: 'string' }, 'quick-fit': { type: 'string' }, 'rank-file': { type: 'string' }, 'quick-fit-file': { type: 'string' } });
  return withLock(paths.jobs, () => jobsSetLocked(a));
}

function jobsSetLocked(a) {
  const store = loadStore(); // re-read inside the lock
  if (a['quick-fit-file']) {
    if (a._.length || a.status || a['quick-fit'] || a['rank-file']) fail('--quick-fit-file is a batch mode; pass it alone');
    return quickFitBatch(store, a['quick-fit-file'], a.json);
  }
  const j = findJob(store, a._[0]);
  const patch = {};
  if (a.status) {
    if (!STATUSES.includes(a.status)) fail(`--status must be one of ${STATUSES.join(', ')}`);
    patch.status = a.status;
  }
  if (a['quick-fit'] !== undefined) {
    const f = a['quick-fit'];
    if (f !== 'null' && !FITS.includes(f)) fail('--quick-fit must be high, medium, low or null');
    patch.quickFit = f === 'null' ? null : f;
  }
  if (a['rank-file']) {
    const rank = readJSONFile(a['rank-file'], 'rank file');
    const err = validateRank(rank);
    if (err) fail(err);
    patch.rank = { ...rank, rankedAt: rank.rankedAt ?? nowISO() };
    if (!a.status && (j.status === 'new' || !j.status)) patch.status = 'ranked';
  }
  if (!Object.keys(patch).length) fail('nothing to set: pass --status, --quick-fit or --rank-file');
  store.jobs[j.key] = { ...j, ...patch };
  store.updatedAt = nowISO();
  writeJSON(paths.jobs, store);
  out({ key: j.key, ...patch }, a.json, () => `Updated ${j.key}: ${Object.keys(patch).join(', ')}`);
}

// ---------- fetch ----------

function companyNameForSlug(slug) {
  const cfg = readJSON(paths.companies) ?? readJSON(paths.companiesExample) ?? {};
  return (cfg.companies ?? []).find((c) => c.slug?.toLowerCase() === slug?.toLowerCase())?.name ?? slug;
}

/**
 * Fetch one posting URL via its ATS API when recognised, else as HTML → text.
 * @param {string} url
 */
export async function fetchPosting(url, { allowLinkedIn = false, ...opts } = {}) {
  const host = new URL(url).host;
  const rec = recognizeUrl(url);
  if (hostClass(url) === 'linkedin' && !allowLinkedIn) {
    const err = new Error('LinkedIn fetching is opt-in (sources.linkedin). Paste the job description instead.');
    err.code = 'LINKEDIN_OPT_IN';
    throw err;
  }
  if (rec) {
    try {
      const src = SOURCES[rec.source];
      const j = rec.source === 'linkedin'
        ? await src.fetchOne(rec.id)
        : URL_ATS[rec.source]
          ? await src.fetchOne(url, { companyName: companyNameForSlug(rec.slug) })
          : await src.fetchOne(rec.slug, rec.id, { companyName: companyNameForSlug(rec.slug) });
      return { url, host, hostClass: hostClass(url), title: j.title, company: j.company, location: j.location, workMode: j.workMode, salary: j.salary, text: j.description };
    } catch (err) {
      if (rec.source === 'linkedin') throw err;
      process.stderr.write(`warning: ${rec.source} API lookup failed (${err.message}); falling back to the page itself\n`);
    }
  }
  const { finalUrl, truncated, ...p } = await fetchGeneric(url, opts);
  if (truncated) process.stderr.write('warning: page was larger than 5 MB; text is truncated\n');
  if (hostClass(finalUrl) === 'linkedin' && !allowLinkedIn) throw new Error('that URL redirects to LinkedIn; LinkedIn fetching is opt-in (sources.linkedin). Paste the job description instead.');
  return { url, host, hostClass: hostClass(url), ...p };
}

async function fetchCmd(argv) {
  const a = parse(argv);
  const url = a._[0];
  if (!url || !/^https?:\/\//i.test(url)) fail('usage: gaj fetch <http(s) url>');
  let res;
  const allowLinkedIn = isOn(readJSON(paths.preferences)?.sources?.linkedin);
  try { res = await fetchPosting(url, { allowLinkedIn }); } catch (err) { fail(err.message); }
  if (!res.text?.trim()) fail(`fetched ${url} but found no readable text (the page may need JavaScript). Paste the job description instead.`);
  out(res, a.json, (r) => [
    `${r.title ?? '(no title)'}${r.company ? ` | ${r.company}` : ''}${r.location ? ` | ${r.location}` : ''}`,
    `${r.url} [${r.hostClass === 'unknown' ? '⚠ Unverified host' : r.hostClass}]`,
    '',
    r.text,
  ].join('\n'));
}

// ---------- jobs:enrich ----------

// Hosts whose terms forbid automated access (or that block bots): their postings stay paste-only.
export const NO_FETCH_HOSTS = /(^|\.)(naukri\.com|glassdoor\.[a-z.]+|wellfound\.com|angel\.co|instahyre\.com|cutshort\.io|indeed\.[a-z.]+|weekday\.works|ycombinator\.com)$/i;
export const THIN_JD = 400;

/** Open jobs whose description is missing or a stub, best quick fit first. */
export function enrichTargets(store, { fits, minChars = THIN_JD, limit = 25, allowLinkedIn = false } = {}) {
  const order = { high: 0, medium: 1, low: 2 };
  const skipped = { host: 0, noUrl: 0, linkedin: 0 };
  const out = [];
  const jobs = Object.values(store.jobs ?? {})
    .filter((j) => ['new', 'ranked', 'tracked'].includes(j.status) && (j.description ?? '').length < minChars)
    .filter((j) => !fits?.length || fits.includes(j.quickFit))
    .sort((a, b) => (order[a.quickFit] ?? 3) - (order[b.quickFit] ?? 3) || String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? '')));
  for (const j of jobs) {
    const url = [j.applyUrl, j.url].find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (!url) { skipped.noUrl++; continue; }
    const host = new URL(url).hostname;
    if (NO_FETCH_HOSTS.test(host)) { skipped.host++; continue; }
    if (hostClass(url) === 'linkedin' && !allowLinkedIn) { skipped.linkedin++; continue; }
    out.push({ key: j.key, url });
    if (out.length >= limit) break;
  }
  return { targets: out, skipped };
}

async function jobsEnrich(argv) {
  const a = parse(argv, { limit: { type: 'string' }, fit: { type: 'string' }, 'min-chars': { type: 'string' }, delay: { type: 'string' } }, { allowPositionals: false });
  if (a.help) return console.log(commands['jobs:enrich'].usage);
  const limit = intOpt(a.limit, 'limit', 1) ?? 25;
  const minChars = intOpt(a['min-chars'], 'min-chars', 1) ?? THIN_JD;
  const delay = intOpt(a.delay, 'delay', 0) ?? 1500;
  const fits = a.fit ? a.fit.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const allowLinkedIn = isOn(readJSON(paths.preferences)?.sources?.linkedin);
  const { targets, skipped } = enrichTargets(loadStore(), { fits, minChars, limit, allowLinkedIn });
  const res = { tried: targets.length, filled: 0, failed: [], skipped };
  const got = [];
  for (const [i, t] of targets.entries()) {
    if (i) await new Promise((r) => setTimeout(r, delay)); // polite pause between hosts
    try {
      const p = await fetchPosting(t.url, { allowLinkedIn });
      const text = String(p.text ?? '').trim();
      if (text.length < THIN_JD) throw new Error('page had little readable text');
      got.push({ key: t.key, text: text.slice(0, 50000) });
    } catch (err) { res.failed.push({ key: t.key, error: err.message.split('\n')[0].slice(0, 160) }); }
  }
  // One locked write at the end; re-read so a concurrent scrape/tracker edit survives.
  if (got.length) {
    await withLock(paths.jobs, () => {
      const store = loadStore();
      const at = nowISO();
      for (const g of got) {
        const j = store.jobs[g.key];
        if (!j || (j.description ?? '').length >= g.text.length) continue;
        Object.assign(j, { description: g.text, descriptionVia: 'fetched', descriptionAt: at });
        res.filled++;
      }
      writeJSON(paths.jobs, store);
    });
  }
  out(res, a.json, (r) => [
    `Fetched descriptions for ${r.filled} of ${r.tried} job(s).`,
    r.skipped.host ? `  ${r.skipped.host} skipped: the site's terms forbid fetching (Naukri, Glassdoor, Indeed, Wellfound...). Paste those in the tracker (Add JD).` : null,
    r.skipped.linkedin ? `  ${r.skipped.linkedin} LinkedIn job(s) skipped: LinkedIn fetching is off (sources.linkedin).` : null,
    r.skipped.noUrl ? `  ${r.skipped.noUrl} without a posting URL.` : null,
    ...r.failed.map((f) => `  ✗ ${f.key}: ${f.error}`),
  ].filter(Boolean).join('\n'));
}

// ---------- careers:check ----------

async function careersCheck(argv) {
  const a = parse(argv);
  const url = a._[0];
  if (!url || !/^https:\/\//i.test(url)) fail(`usage: ${commands['careers:check'].usage}`);
  const mod = await loadCareers();
  if (!mod) fail('the careers-page crawler (src/scrape/sources/careers.js) is not installed');
  const r = await mod.checkCareers(url);
  if (r.ok) recordCareersCheck(r.url ?? url, { jobs: r.jobs, method: r.method });
  const { results, notes, stats, ...view } = r;
  out(view, a.json, () => [
    r.ok ? `✓ ${r.url}: ${r.jobs} job${r.jobs === 1 ? '' : 's'} via ${r.method}` : `✗ ${r.url ?? url}: ${r.error}`,
    r.sample?.length ? `  e.g. ${r.sample.join(' · ')}` : null,
    r.embeddedAts ? `  The page embeds ${r.embeddedAts.ats}/${r.embeddedAts.slug}; prefer: gaj companies:add --name <Name> --ats ${r.embeddedAts.ats} --slug ${r.embeddedAts.slug}` : null,
    r.ok ? '  Recorded for 7 days: company:check careers / companies:add --ats careers can use this URL now.' : null,
  ].filter(Boolean).join('\n'));
  if (!r.ok) process.exitCode = 1;
}

// ---------- jobs:import ----------

async function jobsImport(argv) {
  const a = parse(argv, { source: { type: 'string' }, via: { type: 'string' } });
  const file = a._[0];
  if (!file) fail(`usage: ${commands['jobs:import'].usage}`);
  const prefs = loadPrefs();
  const allowed = importPathAllowed(file);
  if (!allowed.ok) fail(allowed.error);
  let text;
  try { text = fs.readFileSync(allowed.path, 'utf8'); } catch (e) { fail(`cannot read ${path.basename(file)}: ${e.code ?? 'read error'}`); }
  let data;
  // Never echo file contents: JSON.parse messages quote the offending text.
  try { data = JSON.parse(text); } catch { fail(`${path.basename(file)} is not valid JSON`); }
  let res;
  try { res = importJobs(data, { source: a.source ?? 'manual', via: a.via ?? null }); } catch (e) { fail(e.message); }
  const now = nowISO();
  const kept = [];
  let tooOld = 0;
  let noTrack = 0;
  for (const j of res.jobs) {
    // Imported jobs were picked by the user: only the age filter applies (and only with postedAt).
    const r = classify(j, prefs, {});
    if (r.reason === 'age') { tooOld++; continue; }
    const track = r.track ?? matchJobTrack(j, prefs.tracks ?? []);
    if (!track) noTrack++;
    kept.push({ ...j, track: track ?? null, ...eligibility(j, prefs) });
  }
  const maxAge = prefs.sources?.maxAgeDays;
  const { stats } = await withLock(paths.jobs, async () => {
    const r = mergeJobs(loadStore(), kept, { now, boardExpireDays: maxAge ? maxAge * 2 : 30 });
    writeJSON(paths.jobs, r.store);
    return r;
  });
  const summary = {
    file: path.basename(file), source: a.source ?? 'manual', read: Array.isArray(data) ? data.length : (data?.jobs?.length ?? 0),
    imported: kept.length, new: stats.new, updated: stats.updated, alreadyKnown: stats.crossSource,
    invalid: res.errors, duplicates: res.duplicates, tooOld, noTrack,
  };
  out(summary, a.json, (x) => [
    `Imported ${x.imported} of ${x.read} from ${x.file} (${x.source}): new ${x.new}, updated ${x.updated}${x.alreadyKnown ? `, ${x.alreadyKnown} already known from another source` : ''}.`,
    x.duplicates ? `  ${x.duplicates} duplicate${x.duplicates === 1 ? '' : 's'} in the file skipped` : null,
    x.tooOld ? `  ${x.tooOld} older than your max age skipped` : null,
    x.noTrack ? `  ${x.noTrack} kept without a matching track` : null,
    ...x.invalid.map((e) => `  ✗ entry ${e.index}: ${e.error}`),
  ].filter(Boolean).join('\n'));
}

// ---------- companies / detect / discover ----------

const listOpt = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function detectHuman(r) {
  if (!r.found.length) return r.url ? `No supported ATS found at ${r.url}${r.error ? ` (${r.error})` : ''}. ${r.hint ?? `Try: gaj careers:check ${r.url}`}` : `No ATS board found for "${r.name}" (tried ${r.tried} URLs). Pass --slug or --url if you know the careers URL.`;
  return [`${r.name}: found ${r.found.length} board${r.found.length === 1 ? '' : 's'}`,
    ...r.found.map((f) => `  ${f.ats.padEnd(16)} ${f.slug.padEnd(28)} ${String(f.jobs).padStart(4)} job${f.jobs === 1 ? ' ' : 's'}  ${f.confidence === 'high' ? (f.boardName ? `✓ "${f.boardName}"` : f.url ? '✓ from the URL you gave' : '✓') : f.confidence === 'low' ? `⚠ board is "${f.boardName}" (probably another company)` : f.boardName ? `? board "${f.boardName}" only matches the slug; check it` : '? name not exposed by this ATS'}`),
    r.rateLimited ? `(rate-limited by ${r.rateLimited.join(', ')}; results may be incomplete, retry later)` : null,
    ...(() => {
      const best = r.found.find((f) => f.confidence !== 'low');
      return best ? [`Add with: gaj companies:add --name "${r.name}" --ats ${best.ats} --slug ${best.slug}${best.url ? ` --url ${best.url}` : ''}`] : [r.hint ?? 'No board clearly belongs to this company; pass --slug if you know it.'];
    })()].filter(Boolean).join('\n');
}

/**
 * Classify a careers URL: url-based ATS by host (workday/keka/zohorecruit), slug-based ATS
 * board links (greenhouse/lever/…), else try it as a SuccessFactors career site.
 * @param {string} name
 * @param {string} url
 * @param {{sources?: object, probeSlug?: Function}} [deps] injectable for tests
 */
export async function classifyCareersUrl(name, url, { sources = SOURCES, probeSlug = probe } = {}) {
  const found = [];
  const byHost = classifyAtsUrl(url);
  if (byHost) {
    const mod = typeof sources[byHost.ats]?.check === 'function' ? sources[byHost.ats] : URL_ATS[byHost.ats];
    const r = await mod.check(byHost.url);
    if (r.ok) found.push({ ats: byHost.ats, slug: byHost.slug, url: byHost.url, jobs: r.jobs, confidence: 'high' });
    return { name, url, found, tried: 1, ...(r.ok ? {} : { error: r.error }) };
  }
  const boards = detectEmbeddedAts(url).slice(0, 2);
  for (const b of boards) {
    const p = await probeSlug(b.ats, b.slug);
    if (p.jobs !== null) found.push({ ats: b.ats, slug: b.slug, jobs: p.jobs, boardName: p.boardName ?? null, confidence: 'high' });
  }
  if (found.length || boards.length) return { name, url, found, tried: boards.length };
  const v = validateAtsUrl('successfactors', url);
  if (!v.error) {
    const r = await (typeof sources.successfactors?.check === 'function' ? sources.successfactors : URL_ATS.successfactors).check(v.url);
    if (r.ok) found.push({ ats: 'successfactors', slug: v.slug, url: v.url, jobs: r.jobs, confidence: 'unknown' });
  }
  return { name, url, found, tried: 1, ...(found.length ? {} : { hint: `not a recognised ATS URL; try: gaj careers:check ${url}` }) };
}

async function companyDetect(argv) {
  const a = parse(argv, { slug: { type: 'string' }, url: { type: 'string' } });
  const name = a._.join(' ').trim();
  if (!name) fail('usage: gaj company:detect <name> [--slug s] [--url https://careers-url]');
  if (a.url && !/^https:\/\//i.test(a.url)) fail('--url must be an https URL');
  const r = a.url ? await classifyCareersUrl(name, a.url) : await detectCompany(name, { slugs: listOpt(a.slug) });
  out(r, a.json, detectHuman);
  if (!r.found.length) process.exitCode = 1;
}

function companiesTable(list) {
  if (!list.length) return 'No companies match.';
  const head = `${pad('NAME', 24)}  ${pad('ATS/SLUG', 36)}  ${pad('REGION', 18)}  ${pad('STAGE', 9)}  ${pad('SOURCE', 8)}  TAGS`;
  return [head, ...list.map((c) => `${pad(c.name, 24)}  ${pad(`${c.ats}/${c.slug}`, 36)}  ${pad((c.region ?? []).join(','), 18)}  ${pad(c.stage ?? '-', 9)}  ${pad(c.source ?? '-', 8)}  ${(c.tags ?? []).join(', ')}`), `${list.length} compan${list.length === 1 ? 'y' : 'ies'}`].join('\n');
}

async function companiesCmd(argv) {
  const a = parse(argv, { tag: { type: 'string' }, region: { type: 'string' } });
  out(filterCompanies(loadCompanies(), { tag: a.tag, region: a.region }), a.json, companiesTable);
}

async function companiesAdd(argv) {
  const a = parse(argv, {
    name: { type: 'string' }, ats: { type: 'string' }, slug: { type: 'string' }, tags: { type: 'string' },
    region: { type: 'string' }, stage: { type: 'string' }, source: { type: 'string' },
    force: { type: 'boolean' }, merge: { type: 'boolean' }, url: { type: 'string' },
  });
  const { entry, error } = validateCompany({ name: a.name, ats: a.ats, slug: a.slug, url: a.url, tags: a.tags, region: a.region, stage: a.stage, source: a.source ?? 'manual' });
  if (error) fail(`${error}\nusage: ${commands['companies:add'].usage}`);
  const check = await checkCompany(entry.ats, entry.slug, { url: entry.url });
  if (!check.ok && !a.force) fail(`${entry.ats}/${entry.slug} didn't verify: ${check.error}. Try: gaj company:detect "${entry.name}" (or --force to add anyway)`);
  if (!check.ok) warn(`adding unverified ${entry.ats}/${entry.slug} (--force): ${check.error}`);
  const { res, created } = await withLock(paths.companies, async () => {
    const { cfg, created: made } = loadCompaniesFile({ create: true });
    const r = addCompanies(cfg, [entry], { merge: !!a.merge });
    if (r.added.length || r.duplicates[0]?.changed.length) saveCompaniesFile(r.cfg);
    return { res: r, created: made };
  });
  for (const w of res.warnings) warn(w);
  const dup = res.duplicates[0];
  const result = {
    added: res.added.length === 1, duplicate: !!dup, changed: dup?.changed ?? [], created,
    company: dup ? dup.stored : entry, jobs: check.jobs, verified: check.ok, warnings: res.warnings,
  };
  out(result, a.json, () => [
    created ? `Created ${rel(paths.companies)} from the example.` : null,
    result.added ? `Added ${entry.name} (${entry.ats}/${entry.slug}, ${check.jobs} open jobs).`
      : dup.changed.length ? `${entry.ats}/${entry.slug} already exists; merged ${dup.changed.join(', ')}.`
        : `${entry.ats}/${entry.slug} already exists in ${rel(paths.companies)}; nothing changed${a.merge ? '' : ' (pass --merge to add new tags/region)'}.`,
  ].filter(Boolean).join('\n'));
}

/**
 * Detect ATS boards for YC companies. Pure-ish: `detect` is injectable for tests.
 * @param {object[]} ycList filtered yc-oss companies
 * @param {{detect?: Function, concurrency?: number}} [opts]
 */
export async function detectYc(ycList, { detect = detectCompany, concurrency = 6 } = {}) {
  return mapLimit(ycList, concurrency, async (c) => {
    const r = await detect(c.name, { slugs: [c.slug, websiteLabel(c.website)].filter(Boolean), concurrency: 4 });
    const usable = r.found.filter((f) => f.confidence !== 'low');
    const best = usable.find((f) => f.jobs > 0) ?? usable[0] ?? null;
    return {
      name: c.name, batch: batchCode(c.batch), region: mapRegions(c.regions), website: c.website ?? null,
      ats: best?.ats ?? null, slug: best?.slug ?? null, jobs: best?.jobs ?? null, confidence: best?.confidence ?? null,
      tags: tagsFor(c), stage: stageFor(c), ...(r.rateLimited ? { rateLimited: r.rateLimited } : {}),
    };
  });
}

function discoverTable(rows) {
  if (!rows.length) return 'No hiring YC companies match those filters.';
  const head = `${pad('NAME', 26)}  ${pad('BATCH', 5)}  ${pad('REGION', 22)}  ${pad('ATS/SLUG', 34)}  JOBS`;
  const found = rows.filter((r) => r.ats).length;
  return [head, ...rows.map((r) => `${pad(r.name, 26)}  ${pad(r.batch, 5)}  ${pad(r.region.join(','), 22)}  ${pad(r.ats ? `${r.ats}/${r.slug}${r.confidence === 'unknown' ? ' ?' : ''}` : '-', 34)}  ${r.jobs ?? '-'}`),
    `${found} of ${rows.length} have a supported ATS board ("?" = ATS doesn't expose the company name; check it). --add adds those with open jobs.`,
    ...(() => {
      const limited = [...new Set(rows.flatMap((r) => r.rateLimited ?? []))];
      return limited.length ? [`Rate-limited by ${limited.join(', ')}; some boards may be missing. Re-run later.`] : [];
    })()].join('\n');
}

async function discover(argv) {
  const a = parse(argv, { region: { type: 'string' }, industry: { type: 'string' }, batch: { type: 'string' }, limit: { type: 'string' }, add: { type: 'boolean' } });
  if (a._[0] !== 'yc') fail(`usage: ${commands.discover.usage}`);
  const regions = listOpt(a.region).map((r) => r.toLowerCase());
  const bad = regions.find((r) => !['india', 'us', 'eu', 'uk', 'apac', 'remote-global'].includes(r));
  if (bad) fail(`--region "${bad}" must be one of india, us, eu, uk, apac, remote-global`);
  const limit = intOpt(a.limit, 'limit', 1) ?? 20;
  let list;
  try { list = await loadYc(); } catch (err) { fail(`couldn't load the yc-oss dataset: ${err.message}`); }
  const picked = filterYc(list, { region: regions.join(','), industry: a.industry, batch: a.batch }).slice(0, limit);
  const rows = await detectYc(picked);
  let addResult = null;
  if (a.add) {
    // Only boards with open jobs: an empty board on a generic slug is often a different company.
    const entries = rows.filter((r) => r.ats && r.jobs > 0).map((r) => validateCompany({ name: r.name, ats: r.ats, slug: r.slug, tags: r.tags, region: r.region, stage: r.stage, source: 'yc' }).entry).filter(Boolean);
    const { res, created } = await withLock(paths.companies, async () => {
      const { cfg, created: made } = loadCompaniesFile({ create: true });
      const r = addCompanies(cfg, entries);
      saveCompaniesFile(r.cfg);
      return { res: r, created: made };
    });
    addResult = { added: res.added.length, duplicates: res.duplicates.length, created };
    for (const w of res.warnings) warn(w);
  }
  out({ count: rows.length, companies: rows, ...(addResult ? { add: addResult } : {}) }, a.json, () => [
    discoverTable(rows),
    addResult ? `Added ${addResult.added} to ${rel(paths.companies)} (${addResult.duplicates} already there).` : null,
  ].filter(Boolean).join('\n'));
}

/**
 * Check a company's public ATS feed.
 * @param {string} ats
 * @param {string} slug
 * @param {object} [deps] `{sources}` override for tests
 * @returns {Promise<{ok: boolean, ats: string, slug: string, jobs: number, sample: string[], error?: string}>}
 */
export async function checkCompany(ats, slug, { sources = SOURCES, url } = {}) {
  if (URL_ATS[ats]) {
    const v = validateAtsUrl(ats, url);
    if (v.error) return { ok: false, ats, slug, url: url ?? null, jobs: 0, sample: [], error: v.error };
    const r = await (sources[ats] ?? URL_ATS[ats]).check(v.url);
    return { ok: r.ok, ats, slug, url: v.url, jobs: r.jobs, sample: r.sample ?? [], ...(r.ok ? {} : { error: r.error }) };
  }
  if (!sources[ats] && ats !== 'careers') return { ok: false, ats, slug, jobs: 0, sample: [], error: `unknown ats "${ats}"` };
  if (ats === 'careers') {
    // Never crawls: relies on a recent successful `careers:check` of the same URL.
    const rec = url ? recentCareersCheck(url) : null;
    if (!rec) return { ok: false, ats, slug, url, jobs: 0, sample: [], error: `run careers:check ${url ?? '<url>'} first (no successful check in the last 7 days)` };
    return { ok: true, ats, slug, url, jobs: rec.jobs, method: rec.method, checkedAt: rec.checkedAt, sample: [] };
  }
  try {
    const jobs = await sources[ats].fetchJobs({ name: slug, slug }, { http: { retries: 1 } });
    if (ats === 'smartrecruiters' && !jobs.length) {
      // SmartRecruiters answers 200 with an empty list for any unknown company id.
      return { ok: false, ats, slug, jobs: 0, sample: [], error: 'unverifiable: 0 postings (SmartRecruiters returns an empty list for unknown companies)' };
    }
    return { ok: true, ats, slug, jobs: jobs.length, sample: [...new Set(jobs.map((j) => j.title))].slice(0, 5) };
  } catch (err) {
    const notFound = err.status === 404 ? `no ${ats} board named "${slug}"` : err.message;
    return { ok: false, ats, slug, jobs: 0, sample: [], error: notFound };
  }
}

async function companyCheck(argv) {
  const a = parse(argv, { url: { type: 'string' } });
  const [ats, slug] = a._;
  if (!COMPANY_ATS.includes(ats)) fail(`usage: ${commands['company:check'].usage}`);
  if (!slug || !/^[A-Za-z0-9._-]{1,100}$/.test(slug)) fail('slug must be the board name from the careers URL (letters, digits, . _ -)');
  if ((ats === 'careers' || URL_ATS[ats]) && !/^https:\/\//i.test(a.url ?? '')) fail(`${ats} needs --url <https careers URL>`);
  const r = await checkCompany(ats, slug, { url: a.url });
  out(r, a.json, () => (r.ok
    ? `✓ ${ats}/${slug}: ${r.jobs} open job${r.jobs === 1 ? '' : 's'}${r.sample.length ? `\n  e.g. ${r.sample.join(' · ')}` : ''}`
    : `✗ ${ats}/${slug}: ${r.error}`));
  if (!r.ok) process.exitCode = 1;
}

export const commands = {
  scrape: { summary: 'Fetch jobs from your companies, enabled boards and providers into data/jobs.json', usage: 'gaj scrape [--track id] [--days 14] [--limit N] [--company name] [--paid] [--json]', run: scrape },
  jobs: { summary: 'List scraped jobs (no descriptions)', usage: 'gaj jobs [--status s] [--eligibility green|orange|unknown] [--track id] [--limit N] [--json]', run: jobs },
  job: { summary: 'Show one job including its description', usage: 'gaj job <key> [--json]', run: job },
  'jobs:set': { summary: 'Update a job (status, quick fit, rank)', usage: 'gaj jobs:set <key> [--status s] [--quick-fit f] [--rank-file path.json] | gaj jobs:set --quick-fit-file map.json', run: jobsSet },
  'company:check': { summary: "Verify a company's public ATS feed", usage: `gaj company:check <${COMPANY_ATS.join('|')}> <slug> [--url https://… (careers, ${URL_ATS_LIST.join(', ')})] [--json]`, run: companyCheck },
  'careers:check': { summary: 'Crawl one careers page and report the jobs found (records success for 7 days)', usage: 'gaj careers:check <https url> [--json]', run: careersCheck },
  'jobs:import': { summary: 'Import jobs from a JSON file (e.g. LinkedIn alert emails)', usage: 'gaj jobs:import <file.json> [--source linkedin-alert|email-alert|browser|manual] [--via linkedin|naukri|indeed|wellfound|instahyre|cutshort|glassdoor|other] [--json]', run: jobsImport },
  'company:detect': { summary: 'Find which ATS a company uses (slug variants, or classify --url)', usage: 'gaj company:detect <name> [--slug s] [--url https://careers-url] [--json]', run: companyDetect },
  companies: { summary: 'List your companies (config/companies.json)', usage: 'gaj companies [--tag t] [--region r] [--json]', run: companiesCmd },
  'companies:add': { summary: 'Verify and add a company to config/companies.json', usage: 'gaj companies:add --name N --ats A --slug S [--url https://… (careers)] [--tags a,b] [--region us,eu] [--stage s] [--source seed|yc|discover|manual] [--merge] [--force] [--json]', run: companiesAdd },
  discover: { summary: 'Discover hiring YC companies and detect their ATS', usage: 'gaj discover yc [--region india,us,eu,uk,apac,remote-global] [--industry x] [--batch W24] [--limit N (default 20)] [--add] [--json]', run: discover },
  fetch: { summary: 'Fetch one posting URL as text', usage: 'gaj fetch <url> [--json]', run: fetchCmd },
  'jobs:enrich': { summary: 'Fill missing job descriptions from each posting\'s own URL (best fit first)', usage: 'gaj jobs:enrich [--fit high,medium] [--limit 25] [--min-chars 400] [--delay 1500] [--json]', run: jobsEnrich },
};
