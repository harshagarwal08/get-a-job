import { jobKey } from '../lib/jobKey.js';
import { titleTokens, eligibility } from './filter.js';

const EXPIRE_AFTER_MISSES = 2;
const ELIG = { green: 0, unknown: 1, orange: 2 };

const normTitle = (t) => titleTokens(t).join(' ');

/**
 * Collapse separate postings of the same role in several locations
 * (same company + normalised title) into one record. The home-country
 * location is preferred as primary; countries are unioned and eligibility
 * is computed over every location.
 * @param {object[]} jobs NormalizedJob[] from one company/source
 * @param {object} prefs preferences.json
 * @returns {object[]} jobs with eligibility + eligibilityReason set
 */
export function consolidate(jobs, prefs) {
  const groups = new Map();
  for (const j of jobs) {
    const k = `${j.company.toLowerCase()}|${normTitle(j.title)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(j);
  }
  const home = prefs?.location?.countryCode;
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push({ ...group[0], ...eligibility(group[0], prefs) });
      continue;
    }
    const scored = group.map((j) => ({ j, e: eligibility(j, prefs) }));
    scored.sort((a, b) => (ELIG[a.e.eligibility] - ELIG[b.e.eligibility])
      || (b.j.countries.includes(home) - a.j.countries.includes(home))
      || String(b.j.postedAt ?? '').localeCompare(String(a.j.postedAt ?? '')));
    const primary = scored[0].j;
    const locations = [...new Set(group.flatMap((j) => j.locations ?? [j.location]).filter(Boolean))];
    const base = (primary.locations?.[0] ?? primary.location).replace(/\s*\(\+\d+ locations?\)$/, '');
    const location = locations.length > 1 ? `${base} (+${locations.length - 1} location${locations.length > 2 ? 's' : ''})` : base;
    const merged = {
      ...primary,
      key: jobKey({ company: primary.company, title: primary.title, location: `multi:${normTitle(primary.title)}` }),
      location,
      locations,
      countries: [...new Set(group.flatMap((j) => j.countries))],
      postedAt: group.map((j) => j.postedAt).filter(Boolean).sort().at(-1) ?? null,
      sourceIds: group.map((j) => j.sourceId),
    };
    const reason = scored[0].e.eligibilityReason.replace(/ \(best of \d+ locations\)$/, '');
    out.push({ ...merged, eligibility: scored[0].e.eligibility, eligibilityReason: `${reason} (best of ${locations.length} locations)` });
  }
  return out;
}

const DAY = 86400000;
/** Query-based sources with no per-company feed: expire by age since lastSeen (HN also expires on thread change). */
export const TIME_EXPIRY_SOURCES = new Set(['linkedin', 'hn', 'arbeitnow', 'remotive', 'remoteok', 'google-jobs', 'apify', 'jobspy', 'linkedin-alert', 'manual']);

/** Aggregated/secondary sources: when they repeat a job we already have from another source, merge into it. */
export const SECONDARY_SOURCES = new Set(['google-jobs', 'apify', 'jobspy', 'linkedin', 'linkedin-alert']);
const LEGAL = /\b(inc|incorporated|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc|technologies|technology|labs|hq)\b\.?/gi;

const cityOf = (job) => String(job.location ?? '').toLowerCase().replace(/\(.*?\)/g, '').split(/[,;|/]/)[0].replace(/\b(remote|hybrid|onsite|on-site)\b/g, '').replace(/[^a-z]+/g, ' ').trim();

/**
 * Whether two records plausibly describe the same posting location: their countries overlap,
 * or (when either side has no country info) their first location segment matches.
 */
export function sameLocation(a, b) {
  const ca = a.countries ?? [];
  const cb = b.countries ?? [];
  if (ca.length && cb.length) return ca.some((c) => cb.includes(c));
  const x = cityOf(a);
  return !!x && x === cityOf(b);
}

/** Company + normalised title, used to spot the same role arriving from another source. */
export function identityOf(job) {
  const company = String(job.company ?? '').toLowerCase().replace(LEGAL, ' ').replace(/[^a-z0-9]+/g, '');
  return `${company}|${normTitle(job.title)}`;
}
const idsOf = (j) => [j.sourceId, ...(j.sourceIds ?? [])].filter(Boolean).map((id) => `${j.source}|${id}`);

/**
 * Merge freshly scraped jobs into the jobs store, applying the CONTRACTS merge rule.
 * - New records keep firstSeen/status/quickFit/rank of an existing record with the same
 *   source+sourceId under a different key (key drift); the old key goes into `aliases`.
 * - ATS jobs missing from a successfully scraped feed for 2 runs become `expired`.
 * - LinkedIn/board jobs (no per-company feed) expire when lastSeen is older than `boardExpireDays`.
 * - A `scraped` entry with `company: null` covers every job of that source (HN thread);
 *   its optional `expireIf(job)` expires immediately (e.g. job from an older HN thread);
 *   `missExpiry: false` only refreshes lastSeen (partial board feeds rely on time expiry).
 * - Status `new` jobs still in the feed but no longer matching preferences become `skipped`.
 * - A secondary-source job (google-jobs/apify/jobspy/linkedin/linkedin-alert) that matches a job
 *   from another source (same company + normalised title, overlapping countries or same city,
 *   not expired/skipped) is not added; the existing record gains `alsoSeenOn: [source]` instead.
 * - Time-based expiry never touches `tracked` jobs.
 * @param {{version: number, updatedAt?: string, jobs: Record<string, object>}} store
 * @param {object[]} incoming jobs that passed filtering (with track/eligibility set)
 * @param {object} ctx
 * @param {string} ctx.now ISO timestamp
 * @param {{company: string|null, source: string, seenKeys: Set<string>, expireIf?: (job: object) => boolean, missExpiry?: boolean}[]} [ctx.scraped]
 *   companies whose feed was fetched successfully this run, with every key seen (pre-filter)
 * @param {Set<string>} [ctx.noLongerMatching] keys seen in a feed that fail title/workMode filters
 * @param {number} [ctx.boardExpireDays] (alias: linkedinExpireDays)
 * @returns {{store: object, stats: {new: number, updated: number, expired: number, skipped: number, crossSource: number, newKeys: string[]}}}
 */
export function mergeJobs(store, incoming, { now, scraped = [], noLongerMatching = new Set(), boardExpireDays, linkedinExpireDays }) {
  const expireDays = boardExpireDays ?? linkedinExpireDays ?? 30;
  const jobs = { ...(store?.jobs ?? {}) };
  const stats = { new: 0, updated: 0, expired: 0, skipped: 0, newKeys: [] };
  const incomingKeys = new Set(incoming.map((j) => j.key));
  const bySourceId = new Map();
  for (const j of Object.values(jobs)) if (!incomingKeys.has(j.key)) for (const id of idsOf(j)) bySourceId.set(id, j.key);
  // identity → candidate keys (live records only; primary sources first)
  const byIdentity = new Map();
  const index = (j) => {
    if (j.status === 'expired' || j.status === 'skipped') return;
    const id = identityOf(j);
    const list = byIdentity.get(id) ?? [];
    if (!list.includes(j.key)) (SECONDARY_SOURCES.has(j.source) ? list.push(j.key) : list.unshift(j.key));
    byIdentity.set(id, list);
  };
  for (const j of Object.values(jobs)) index(j);
  const foldTarget = (j) => (byIdentity.get(identityOf(j)) ?? [])
    .map((k) => jobs[k]).find((r) => r && r.source !== j.source && r.status !== 'expired' && r.status !== 'skipped' && sameLocation(r, j))?.key ?? null;
  stats.crossSource = 0;
  const seenElsewhere = (key, source) => {
    const r = jobs[key];
    jobs[key] = { ...r, alsoSeenOn: [...new Set([...(r.alsoSeenOn ?? []), source])], ...(TIME_EXPIRY_SOURCES.has(r.source) ? { lastSeen: now } : {}) };
    stats.crossSource++;
  };
  // Primary sources (ATS, careers, boards) first so secondaries can fold into them.
  const ordered = [...incoming].sort((a, b) => SECONDARY_SOURCES.has(a.source) - SECONDARY_SOURCES.has(b.source));

  for (const j of ordered) {
    let prev = jobs[j.key];
    if (SECONDARY_SOURCES.has(j.source)) {
      const live = prev && prev.status !== 'expired' && prev.status !== 'skipped';
      const sameRole = live && prev.source !== j.source && !SECONDARY_SOURCES.has(prev.source) ? j.key : null;
      const other = sameRole ?? (!prev && !idsOf(j).some((id) => bySourceId.has(id)) ? foldTarget(j) : null);
      if (other && jobs[other] && jobs[other].source !== j.source) {
        seenElsewhere(other, j.source);
        continue;
      }
    }
    let aliases = prev?.aliases ?? [];
    if (!prev) {
      const oldKey = idsOf(j).map((id) => bySourceId.get(id)).find((k) => k && jobs[k]);
      if (oldKey) {
        prev = jobs[oldKey];
        aliases = [...new Set([...(prev.aliases ?? []), oldKey])];
        delete jobs[oldKey];
        for (const id of idsOf(prev)) bySourceId.delete(id);
      }
    }
    if (!prev) {
      jobs[j.key] = { ...j, firstSeen: now, lastSeen: now, quickFit: null, status: 'new', rank: null, missCount: 0 };
      index(jobs[j.key]);
      stats.new++;
      stats.newKeys.push(j.key);
      continue;
    }
    jobs[j.key] = {
      ...prev,
      ...j,
      firstSeen: prev.firstSeen ?? now,
      lastSeen: now,
      status: prev.status === 'expired' ? 'new' : (prev.status ?? 'new'),
      quickFit: prev.quickFit ?? null,
      rank: prev.rank ?? null,
      source: prev.source && prev.source !== j.source && j.source === 'linkedin' ? prev.source : j.source,
      missCount: 0,
    };
    for (const f of ['sourceIds', 'locations']) if (!(f in j)) delete jobs[j.key][f];
    if (aliases.length) jobs[j.key].aliases = aliases;
    if (jobs[j.key].status !== 'skipped') delete jobs[j.key].skipReason;
    stats.updated++;
  }

  for (const { company, source, seenKeys, expireIf, missExpiry = true } of scraped) {
    for (const job of Object.values(jobs)) {
      if ((company != null && job.company !== company) || job.source !== source || incomingKeys.has(job.key)) continue;
      if (seenKeys.has(job.key)) {
        const next = { ...job, lastSeen: now, missCount: 0, status: job.status === 'expired' ? 'new' : job.status };
        if (noLongerMatching.has(job.key) && next.status === 'new') {
          next.status = 'skipped';
          next.skipReason = 'no longer matches preferences';
          stats.skipped++;
        }
        jobs[job.key] = next;
        continue;
      }
      if (!missExpiry && !expireIf?.(job)) continue;
      const missCount = (job.missCount ?? 0) + 1;
      const expire = (missCount >= EXPIRE_AFTER_MISSES || expireIf?.(job) === true) && job.status !== 'expired';
      jobs[job.key] = { ...job, missCount, status: expire ? 'expired' : job.status };
      if (expire) stats.expired++;
    }
  }

  const nowMs = Date.parse(now);
  if (Number.isFinite(nowMs)) {
    for (const job of Object.values(jobs)) {
      // tracked jobs are the user's applications: never expire them by age
      if (!TIME_EXPIRY_SOURCES.has(job.source) || job.status === 'expired' || job.status === 'tracked' || incomingKeys.has(job.key)) continue;
      const seen = Date.parse(job.lastSeen ?? job.firstSeen);
      if (Number.isFinite(seen) && nowMs - seen > expireDays * DAY) {
        jobs[job.key] = { ...job, status: 'expired' };
        stats.expired++;
      }
    }
  }
  return { store: { version: 1, updatedAt: now, jobs }, stats };
}
