import { spawnSync } from 'node:child_process';
import { getKey, KEYS } from './env.js';
import { REGIONS } from '../scrape/geo.js';

const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * Validate preferences.json. `errors` make the file unusable (block saving from the tracker);
 * `warnings` are fixable gaps (zero comp floor, missing provider key, uv not installed).
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePreferences(prefs) {
  const errors = [];
  const warnings = [];
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) return { errors: ['preferences must be a JSON object'], warnings };
  if (!Array.isArray(prefs.tracks) || prefs.tracks.length === 0) errors.push('tracks: need at least one track');
  const ids = new Set();
  for (const [i, t] of (prefs.tracks ?? []).entries()) {
    if (!t || typeof t !== 'object') { errors.push(`tracks[${i}]: must be an object`); continue; }
    if (!t.id || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) errors.push(`tracks[${i}].id: lowercase letters, digits, dashes`);
    else if (ids.has(t.id)) errors.push(`tracks[${i}].id: duplicate id "${t.id}"`);
    ids.add(t.id);
    if (!t.name) errors.push(`tracks[${i}].name: missing`);
    if (!isStrArr(t.titles) || t.titles.length === 0) errors.push(`tracks[${i}].titles: need at least one title`);
    if (t.excludeTitles !== undefined && !isStrArr(t.excludeTitles)) errors.push(`tracks[${i}].excludeTitles: list of strings`);
    if (t.keywords !== undefined && !isStrArr(t.keywords)) errors.push(`tracks[${i}].keywords: list of strings`);
  }
  const loc = prefs.location ?? {};
  if (!loc.based) errors.push('location.based: missing');
  if (!isStrArr(loc.acceptableLocations)) errors.push('location.acceptableLocations: must be a list of strings');
  if (!isStrArr(loc.workModes) || loc.workModes.some((m) => !['remote', 'hybrid', 'onsite'].includes(m))) errors.push('location.workModes: subset of remote, hybrid, onsite');
  if (!isStrArr(loc.remoteScope)) errors.push('location.remoteScope: must be a list of strings');
  const scopes = ['global', ...Object.keys(REGIONS)];
  for (const s of loc.remoteScope ?? []) {
    if (!scopes.includes(String(s).toLowerCase())) errors.push(`location.remoteScope: "${s}" is not one of ${scopes.join(', ')}`);
  }
  if (typeof loc.needsSponsorship !== 'boolean') errors.push('location.needsSponsorship: true or false');
  const comp = prefs.compensation ?? {};
  if (!comp.currency || typeof comp.min !== 'number' || comp.min < 0) errors.push('compensation: need currency and a non-negative numeric min');
  else if (comp.min === 0) warnings.push('Salary floor is 0: set a real minimum so jobs that publish pay can be checked against it');
  if (!['year', 'month', 'hour'].includes(comp.unit)) errors.push('compensation.unit: year, month or hour');
  if (prefs.noticePeriodDays !== undefined && !num(prefs.noticePeriodDays, 0, 365)) errors.push('noticePeriodDays: number between 0 and 365');

  const src = prefs.sources ?? {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'maxAgeDays') { if (!Number.isInteger(v) || v < 0 || v > 365) errors.push('sources.maxAgeDays: integer between 0 and 365'); }
    else if (v && typeof v === 'object') { if (typeof v.enabled !== 'boolean') errors.push(`sources.${k}.enabled: true or false`); }
    else if (typeof v !== 'boolean') errors.push(`sources.${k}: true or false`);
  }
  const caps = [
    ['googleJobs', 'maxQueries', 1, 20], ['googleJobs', 'maxRequestsPerMonth', 1, 10000],
    ['apify', 'maxItems', 1, 500], ['apify', 'maxChargeUsd', 0.01, 5], ['apify', 'maxUsdPerMonth', 0.01, 1000],
    ['jobspy', 'resultsWanted', 1, 100], ['jobspy', 'maxQueries', 1, 5],
  ];
  for (const [k, f, lo, hi] of caps) {
    if (src[k] && src[k][f] !== undefined && !num(src[k][f], lo, hi)) errors.push(`sources.${k}.${f}: number between ${lo} and ${hi}`);
  }
  if (Array.isArray(src.apify?.actors) && src.apify.actors.length > 3) errors.push('sources.apify.actors: at most 3 actors');
  if (src.jobspy?.enabled) {
    const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
    if (uv.error || uv.status !== 0) warnings.push('JobSpy is on but uv is not installed (brew install uv, or see docs/SETUP.md)');
  }
  const providerKeys = { googleJobs: ['Google for Jobs', (o) => (o.provider === 'serpapi' ? 'serpapi' : 'jsearch')], apify: ['Apify', () => 'apify'] };
  for (const [k, [label, keyOf]] of Object.entries(providerKeys)) {
    if (src[k]?.enabled && !getKey(keyOf(src[k]))) warnings.push(`${label} is on but ${KEYS[keyOf(src[k])]} is not set in .env, so it will be skipped`);
  }
  return { errors, warnings };
}

/** Remote-scope values the scraper understands (for UI pickers). */
export const REMOTE_SCOPES = ['global', ...Object.keys(REGIONS)];
