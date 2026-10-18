import { detectCountries, detectRegions, regionCovers, splitExclusions } from './geo.js';

const SYNONYMS = [
  [/\bfront[\s-]+end\b/g, 'frontend'], [/\bback[\s-]+end\b/g, 'backend'], [/\bfull[\s-]+stack\b/g, 'fullstack'],
  [/\b(engineer|developer|designer|manager|scientist|architect)s\b/g, '$1'],
  [/\bsr\b\.?/g, 'senior'], [/\bjr\b\.?/g, 'junior'], [/\bswe\b/g, 'software engineer'], [/\bui\s*\/\s*ux\b/g, 'ui ux'],
  [/\bsoftware development engineer\b/g, 'software engineer'], [/\bsde\b/g, 'software engineer'],
  [/\bmember of (the )?technical staff\b/g, 'software engineer'], [/\bmts\b/g, 'software engineer'],
];

/** Lowercased word tokens with common title synonyms folded ("Front-End" → "frontend"). */
export function titleTokens(title) {
  let s = String(title ?? '').toLowerCase();
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  return s.split(/[^a-z0-9+#.]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter(Boolean);
}

/**
 * True if the tokens of `phrase` appear in the title in the same order (gaps allowed),
 * so "Software Engineer, Frontend" matches "Senior Software Engineer - Frontend Platform"
 * but "Solutions Engineer" doesn't match "Legal Engineer, Custom Solutions".
 * With `anyOrder`, only presence is checked (used for excludeTitles).
 */
export function titleHas(title, phrase, { anyOrder = false } = {}) {
  const have = titleTokens(title);
  const need = titleTokens(phrase);
  if (!need.length) return false;
  if (anyOrder) return need.every((t) => have.includes(t));
  let i = 0;
  for (const t of have) if (t === need[i] && ++i === need.length) return true;
  return false;
}

const ROLE_NOUNS = new Set(['engineer', 'developer', 'programmer', 'architect']);
const MULTI_ROLES = /^(multiple|various|several|many|open)\b.*\b(roles|positions|openings)$|^multiple roles$/i;

/**
 * Find `phrase` contiguously in `text` such that a role noun (engineer/developer/
 * programmer/architect) is inside the match or within 2 tokens after it, and no
 * `exclude` phrase token sits within 2 tokens either side ("Frontend Engineer Intern").
 * @param {string} text
 * @param {string} phrase
 * @param {string[]} [exclude] excludeTitles
 */
export function textHasPhrase(text, phrase, exclude = []) {
  const have = titleTokens(text);
  const need = titleTokens(phrase);
  if (!need.length) return false;
  const bad = new Set(exclude.flatMap(titleTokens));
  outer: for (let i = 0; i + need.length <= have.length; i++) {
    for (let k = 0; k < need.length; k++) if (have[i + k] !== need[k]) continue outer;
    const end = i + need.length;
    const span = have.slice(i, Math.min(end + 2, have.length));
    if (!span.some((t) => ROLE_NOUNS.has(t))) continue;
    const window = have.slice(Math.max(0, i - 2), Math.min(end + 2, have.length));
    if (window.some((t) => bad.has(t))) continue;
    return true;
  }
  return false;
}

/**
 * Track for a job: its title, then each listed role (HN comments list several), then a
 * fallback phrase search. The fallback is skipped for a track whose excludeTitles hit the
 * first line or every role; it searches the first line, plus the body only when no
 * specific roles were parsed ("Multiple roles").
 * @param {{title: string, roles?: string[], firstLine?: string, matchText?: string}} job
 * @param {object[]} tracks
 */
export function matchJobTrack(job, tracks = []) {
  const direct = matchTrack(job.title, tracks);
  if (direct) return direct;
  const roles = job.roles ?? [];
  for (const r of roles) { const t = matchTrack(r, tracks); if (t) return t; }
  if (!job.firstLine && !job.matchText) return null;
  const vague = !roles.length || roles.every((r) => MULTI_ROLES.test(r.trim()));
  const texts = [job.firstLine, vague ? job.matchText : null].filter(Boolean);
  for (const t of tracks) {
    const ex = t.excludeTitles ?? [];
    const excluded = (s) => ex.some((x) => titleHas(s, x, { anyOrder: true }));
    if ((job.firstLine && excluded(job.firstLine)) || (roles.length && !vague && roles.every(excluded))) continue;
    if ((t.titles ?? []).some((x) => texts.some((txt) => textHasPhrase(txt, x, ex)))) return t.id;
  }
  return null;
}

/**
 * Find the first track whose titles match and whose excludeTitles don't.
 * @param {string} title
 * @param {{id: string, titles?: string[], excludeTitles?: string[]}[]} tracks
 * @returns {string|null} track id
 */
export function matchTrack(title, tracks = []) {
  for (const t of tracks) {
    if ((t.excludeTitles ?? []).some((x) => titleHas(title, x, { anyOrder: true }))) continue;
    if ((t.titles ?? []).some((x) => titleHas(title, x))) return t.id;
  }
  return null;
}

const NO_SPONSOR = /\b(no|not|unable to|cannot|can't|won't|will not|do not|does not|don't|doesn't)\s+(\w+\s+){0,4}sponsor/i;
const SPONSOR = /\b(visa sponsorship|sponsor(ship)?\s+(your |a |work )?(visa|work permit)|relocation (support|assistance|package)|we (can|will) sponsor)/i;

/** Whether the posting text says it offers visa sponsorship / relocation support. */
export function offersSponsorship(text) {
  const s = String(text ?? '');
  return SPONSOR.test(s) && !NO_SPONSOR.test(s);
}

const words = (s) => String(s ?? '').toLowerCase();
const RANK = { green: 0, unknown: 1, orange: 2 };

function evalOne(rawLoc, job, prefs) {
  const p = prefs.location ?? {};
  const home = p.countryCode ?? null;
  const scope = (p.remoteScope ?? []).map((s) => s.toLowerCase());
  const auth = new Set([...(p.workAuthorization ?? []), home].filter(Boolean));
  const ex = splitExclusions(rawLoc);
  const loc = ex.text.replace(/\(\s*,?\s*\)/g, '').replace(/[\s,]+$/, '').trim();
  const isRemote = job.workMode === 'remote' || /\bremote\b/i.test(rawLoc);
  if (home) {
    const exRegion = ex.excludedRegions.find((r) => r !== 'global' && regionCovers(r, home));
    if (ex.excludedCountries.includes(home) || exRegion) {
      return ['orange', `${isRemote ? 'Remote' : `Based in ${loc || 'an unstated location'}`}, but excludes ${ex.excludedCountries.includes(home) ? home : exRegion.toUpperCase()}`];
    }
  }
  const text = `${loc} ${job.locations?.length ? '' : job.title}`;
  const structured = job.locations?.length || ex.excludedText ? [] : job.countries ?? [];
  const countries = [...new Set([...detectCountries(loc), ...structured])];
  const regions = detectRegions(text);
  const remote = job.workMode === 'remote' || /\bremote\b/i.test(loc);
  const mode = remote ? 'Remote' : job.workMode === 'hybrid' ? 'Hybrid' : job.workMode === 'onsite' ? 'Onsite' : 'Based';
  const where = loc || countries.join(', ');
  const sponsor = job.visa === true || offersSponsorship(job.description);
  const accepted = (p.acceptableLocations ?? []).find((a) => new RegExp(`(^|[^a-z])${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z])`).test(words(loc)));

  // An acceptable city name only counts if the location isn't clearly in another country ("Delhi, NY").
  if ((accepted && (!countries.length || countries.includes(home))) || (home && countries.includes(home))) {
    return ['green', `${mode} in ${where}, which matches your location (${accepted ?? home})`];
  }
  const authed = countries.find((c) => auth.has(c));
  if (authed) return ['green', `${mode} in ${where}; you're authorized to work in ${authed}`];

  if (remote) {
    const region = regions.find((r) => r === 'global' || scope.includes(r) || (home && regionCovers(r, home)));
    if (region) {
      return ['green', region === 'global' ? 'Remote, open worldwide' : `Remote within ${region.toUpperCase()}, which includes ${home ?? 'your region'}`];
    }
    if (countries.length) {
      if (p.needsSponsorship && sponsor) return ['green', `Remote limited to ${countries.join('/')}, but the posting mentions visa sponsorship`];
      return ['orange', `Remote, but limited to ${countries.join('/')}`];
    }
    if (regions.length) {
      if (p.needsSponsorship && sponsor) return ['green', `Remote within ${regions.map((r) => r.toUpperCase()).join('/')}; the posting mentions visa sponsorship`];
      return ['orange', `Remote, but limited to ${regions.map((r) => r.toUpperCase()).join('/')}`];
    }
    return ['unknown', 'Remote, but the allowed region isn\'t stated'];
  }

  if (countries.length || regions.length) {
    const target = countries.length ? countries.join('/') : regions.join('/').toUpperCase();
    if (p.needsSponsorship && sponsor) return ['green', `${mode} in ${where} (${target}); the posting mentions visa sponsorship`];
    return ['orange', `${mode} in ${where} (${target}), with no sponsorship path for you`];
  }
  return ['unknown', loc ? `Couldn't tell which country "${loc}" is in` : 'No location given'];
}

/**
 * Tag eligibility for a job given preferences. Multi-location jobs (`job.locations`)
 * are evaluated per location and the best result wins.
 * @param {object} job NormalizedJob
 * @param {object} prefs preferences.json
 * @returns {{eligibility: 'green'|'orange'|'unknown', eligibilityReason: string}}
 */
export function eligibility(job, prefs) {
  const locs = job.locations?.length ? job.locations : [job.location ?? ''];
  let best = null;
  for (const loc of locs) {
    const r = evalOne(loc, job, prefs);
    if (!best || RANK[r[0]] < RANK[best[0]]) best = r;
  }
  if (locs.length > 1) best = [best[0], `${best[1]} (best of ${locs.length} locations)`];
  return { eligibility: best[0], eligibilityReason: best[1] };
}

/**
 * Decide whether a scraped job should be kept.
 * @param {object} job
 * @param {object} prefs
 * @param {{trackId?: string, days?: number, now?: Date, ignoreAge?: boolean}} [opts]
 * @returns {{keep: boolean, reason?: 'title'|'track'|'age'|'workMode', track?: string}}
 */
export function classify(job, prefs, { trackId, days, now = new Date(), ignoreAge = false } = {}) {
  const track = matchJobTrack(job, prefs.tracks ?? []);
  if (!track) return { keep: false, reason: 'title' };
  if (trackId && track !== trackId) return { keep: false, reason: 'track' };
  const maxDays = days ?? prefs.sources?.maxAgeDays;
  if (!ignoreAge && maxDays !== undefined && maxDays !== null && job.postedAt) {
    // 0 = "today only" (since UTC midnight); N = rolling N days
    const cutoff = maxDays === 0 ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) : now - maxDays * 86400000;
    if (new Date(job.postedAt).getTime() < cutoff) return { keep: false, reason: 'age' };
  }
  const modes = prefs.location?.workModes;
  if (modes?.length && job.workMode !== 'unknown' && !modes.includes(job.workMode)) return { keep: false, reason: 'workMode' };
  return { keep: true, track };
}
