import { createHash } from 'node:crypto';

/** A preferences.sources entry is on when it's `true` or `{ enabled: true, ... }`. */
export function isOn(v) {
  return v === true || (!!v && typeof v === 'object' && v.enabled === true);
}

/** Config object for a source entry (`{}` for booleans). */
export const cfgOf = (v) => (v && typeof v === 'object' ? v : {});

export const PROVIDER_TTL = 12 * 3600 * 1000;

const ALIASES = [['bengaluru', 'bangalore'], ['mumbai', 'bombay'], ['gurugram', 'gurgaon'], ['kolkata', 'calcutta'], ['chennai', 'madras']];
const canon = (l) => {
  const k = l.toLowerCase().trim();
  return ALIASES.find((a) => a.includes(k))?.[0] ?? k;
};

/**
 * Provider queries: each track title × each acceptable location, plus "remote",
 * interleaved so a small cap still covers every track and location. City aliases
 * (Bengaluru/Bangalore) count once.
 * @param {object} prefs
 * @param {{maxQueries?: number, trackId?: string}} [opts]
 * @returns {{term: string, location: string, remote: boolean}[]}
 */
export function buildQueries(prefs, { maxQueries = 6, trackId } = {}) {
  const tracks = (prefs.tracks ?? []).filter((t) => !trackId || t.id === trackId);
  const seen = new Set();
  const locs = [];
  for (const l of prefs.location?.acceptableLocations ?? []) {
    const c = canon(l);
    if (!seen.has(c)) { seen.add(c); locs.push(l); }
  }
  if (!locs.length && prefs.location?.based) locs.push(prefs.location.based);
  const places = [...locs.map((l) => ({ location: l, remote: false })), { location: '', remote: true }];
  // titles interleaved across tracks: t1[0], t2[0], t1[1], t2[1], ...
  const titles = [];
  const maxLen = Math.max(0, ...tracks.map((t) => (t.titles ?? []).length));
  for (let i = 0; i < maxLen; i++) for (const t of tracks) if (t.titles?.[i]) titles.push(t.titles[i]);
  const out = [];
  const keys = new Set();
  for (let i = 0; out.length < maxQueries && i < titles.length * places.length; i++) {
    // walk diagonally: title i % T with place (i / T + i) % P so early queries vary both
    const ti = i % titles.length;
    const pi = (Math.floor(i / titles.length) + ti) % places.length;
    const q = { term: titles[ti], ...places[pi] };
    const k = `${q.term.toLowerCase()}|${q.location.toLowerCase()}|${q.remote}`;
    if (keys.has(k)) continue;
    keys.add(k);
    out.push(q);
  }
  return out;
}

/** Short stable hash for cache file names (never includes secrets). */
export const hashOf = (v) => createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);

/**
 * Deep-copy JSON with any occurrence of `secret` replaced, and drop request-echo fields,
 * so provider responses can be cached without keys.
 */
export function scrub(data, secret, dropKeys = []) {
  const json = JSON.stringify(data, (k, v) => (dropKeys.includes(k) ? undefined : v));
  return JSON.parse(secret && secret.length >= 4 ? json.split(secret).join('[redacted]') : json);
}

/**
 * Parse relative "posted" strings ("3 days ago", "an hour ago", "30+ days ago") to ISO.
 * @param {string} s
 * @param {number} [now]
 */
export function relativeToISO(s, now = Date.now()) {
  const m = /(\d+|an?|one)\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago/i.exec(String(s ?? ''));
  if (!m) return /\b(today|just posted|just now)\b/i.test(String(s ?? '')) ? new Date(now).toISOString() : null;
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
  const unit = { minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[m[2].toLowerCase()];
  return new Date(now - n * unit).toISOString();
}

const AGGREGATOR_HOSTS = /(^|\.)(linkedin|indeed|naukri|glassdoor|ziprecruiter|bebee|talent|monster|simplyhired|foundit|instahyre|cutshort|wellfound|jooble|adzuna|google|shine|timesjobs|hirist|iimjobs|jobrapido|careerjet|jobleads|learn4good|whatjobs|teal|dice|builtin|ladders|lensa|snagajob|workingnomads|remoterocketship|himalayas|jobgether)\.[a-z.]+$/i;

/** True when a link points at a job aggregator rather than the employer/ATS. */
export function isAggregatorLink(url) {
  try { return AGGREGATOR_HOSTS.test(new URL(url).hostname); } catch { return true; }
}
