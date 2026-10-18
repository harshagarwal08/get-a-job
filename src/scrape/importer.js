import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { makeJob, httpUrl, parseSalaryText, makeSalary } from './job.js';
import { recognizeUrl } from './urls.js';
import { htmlToText } from './text.js';

export const IMPORT_SOURCES = ['linkedin-alert', 'manual'];
const MAX_TITLE = 200;
const MAX_COMPANY = 120;
const MAX_DESCRIPTION = 50000;

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const within = (child, parent) => { const r = path.relative(parent, child); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

/**
 * jobs:import may only read files under data/ or the OS temp dir (symlinks resolved).
 * @param {string} file
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function importPathAllowed(file) {
  const p = real(path.resolve(file));
  if (!p) return { ok: false, error: `cannot read ${path.basename(file)}: file not found` };
  const roots = [real(paths.dataDir), real(os.tmpdir())].filter(Boolean);
  return roots.some((r) => within(p, r))
    ? { ok: true, path: p }
    : { ok: false, error: 'jobs:import only reads files under data/ or the OS temp dir; move the file there first' };
}
const MODES = new Set(['remote', 'hybrid', 'onsite']);

/** Canonical LinkedIn job URL (https://www.linkedin.com/jobs/view/<id>/), or the input URL. */
export function canonicalJobUrl(url) {
  const rec = recognizeUrl(url);
  return rec?.source === 'linkedin' ? `https://www.linkedin.com/jobs/view/${rec.id}/` : url;
}

function salaryOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return parseSalaryText(v);
  if (typeof v === 'object') return makeSalary(v.min, v.max, v.currency, v.unit ?? 'year');
  return null;
}

/**
 * Validate and normalise imported entries ({title, company, url, location?, description?,
 * postedAt?, workMode?, salary?}). Invalid entries are reported, not thrown; duplicates
 * (same canonical URL or key) are dropped.
 * @param {unknown} data parsed JSON: an array, or `{jobs: [...]}`
 * Caps: title 200, company 120, description 50k chars; future `postedAt` → null;
 * `linkedin-alert` entries must point at linkedin.com.
 * @param {{source?: string, now?: number}} [opts]
 * @returns {{jobs: object[], errors: {index: number, error: string}[], duplicates: number}}
 */
export function importJobs(data, { source = 'manual', now = Date.now() } = {}) {
  if (!IMPORT_SOURCES.includes(source)) throw new Error(`--source must be one of ${IMPORT_SOURCES.join(', ')}`);
  const list = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : null;
  if (!list) throw new Error('import file must be a JSON array of jobs (or {"jobs": [...]})');
  const jobs = [];
  const errors = [];
  const seen = new Set();
  let duplicates = 0;
  list.forEach((e, index) => {
    if (!e || typeof e !== 'object') return errors.push({ index, error: 'not an object' });
    const title = typeof e.title === 'string' ? e.title.trim().slice(0, MAX_TITLE) : '';
    const company = typeof e.company === 'string' ? e.company.trim().slice(0, MAX_COMPANY) : '';
    if (!title) return errors.push({ index, error: 'title is required' });
    if (!company) return errors.push({ index, error: 'company is required' });
    const raw = httpUrl(e.url);
    if (!raw) return errors.push({ index, error: 'url must be an http(s) URL' });
    const url = canonicalJobUrl(raw);
    if (e.postedAt != null && Number.isNaN(Date.parse(e.postedAt))) return errors.push({ index, error: 'postedAt must be a date' });
    const li = recognizeUrl(url)?.source === 'linkedin';
    if (source === 'linkedin-alert' && !/(^|\.)linkedin\.com$/i.test(new URL(url).hostname)) return errors.push({ index, error: 'linkedin-alert entries need a linkedin.com job URL' });
    const rawDesc = typeof e.description === 'string' ? e.description.slice(0, MAX_DESCRIPTION * 2) : '';
    const description = (/<\/?[a-z][^>]*>/i.test(rawDesc) ? htmlToText(rawDesc) : rawDesc.trim()).slice(0, MAX_DESCRIPTION);
    const postedAt = e.postedAt != null && Date.parse(e.postedAt) <= now ? e.postedAt : null; // future dates are bogus
    const job = makeJob({
      title, company,
      location: typeof e.location === 'string' ? e.location : '',
      workModeField: MODES.has(e.workMode) ? e.workMode : null,
      url, applyUrl: url, source,
      sourceId: url,
      salary: salaryOf(e.salary),
      postedAt,
      description,
    });
    if (seen.has(url) || seen.has(job.key)) { duplicates++; return undefined; }
    seen.add(url);
    seen.add(job.key);
    jobs.push({ ...job, via: li ? 'LinkedIn' : null });
    return undefined;
  });
  return { jobs, errors, duplicates };
}
