import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { makeJob, httpUrl, parseSalaryText, makeSalary } from './job.js';
import { recognizeUrl } from './urls.js';
import { stripTracking, unwrapRedirect } from './boards/alertEmail.js';
import * as wellfound from './boards/wellfound.js';
import * as instahyre from './boards/instahyre.js';
import * as cutshort from './boards/cutshort.js';
import { htmlToText } from './text.js';

export const IMPORT_SOURCES = ['linkedin-alert', 'email-alert', 'browser', 'manual'];
// Sources whose entries carry a platform (`via`) and platform-checked links.
const VIA_SOURCES = new Set(['email-alert', 'browser']);
export const ALERT_VIA = ['linkedin', 'naukri', 'indeed', 'wellfound', 'instahyre', 'cutshort', 'glassdoor', 'other'];
// Platform helpers (built by the platforms module): URL normalisation for alert-email links.
const PLATFORM_URLS = { wellfound, instahyre, cutshort };
// Vetted hosts per platform: the registrable domain is fixed (no "indeed.evil.com"); one optional
// subdomain label is allowed (www., in., uk. …).
const SUB = '(?:[a-z0-9-]{1,63}\\.)?';
const VIA_HOSTS = {
  linkedin: new RegExp(`^${SUB}linkedin\\.com$`),
  naukri: new RegExp(`^${SUB}naukri\\.com$`),
  indeed: new RegExp(`^${SUB}indeed\\.(?:com|co\\.in|co\\.uk|ca|com\\.au|com\\.sg|ae|de|fr|nl|ie|es|it|jp|com\\.br|com\\.mx)$`),
  glassdoor: new RegExp(`^${SUB}glassdoor\\.(?:com|co\\.in|co\\.uk|ca|com\\.au|sg|de|fr|nl|ie|es|it|com\\.br|com\\.mx)$`),
};

/** `--via other` links must be ordinary public hosts (no IPs, localhost or internal names). */
function publicHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return !net.isIP(h) && h !== 'localhost' && h.includes('.') && !/\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h);
}
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
  const p = real(path.resolve(paths.root, file)); // relative paths are relative to the project root, not the cwd
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
 * `email-alert` and `browser` (collected in the user's own browser by /browse) imports need `via`
 * (platform) and normalise links with the platform helpers.
 * @param {{source?: string, via?: string|null, now?: number}} [opts]
 * @returns {{jobs: object[], errors: {index: number, error: string}[], duplicates: number}}
 */
/**
 * Normalise an alert-email job link: unwrap redirect wrappers, strip tracking params, then the
 * platform's canonical form (LinkedIn /jobs/view/<id>/, Wellfound/Instahyre/Cutshort helpers).
 * @param {string} url
 * @param {string} [via]
 * @returns {string|null}
 */
export function normalizeAlertUrl(url, via) {
  const clean = stripTracking(unwrapRedirect(String(url ?? '').trim()));
  if (!clean) return null;
  const p = PLATFORM_URLS[via];
  return p ? (p.normalizeJobUrl(clean) ?? clean) : canonicalJobUrl(clean);
}

export function importJobs(data, { source = 'manual', via = null, now = Date.now() } = {}) {
  if (!IMPORT_SOURCES.includes(source)) throw new Error(`--source must be one of ${IMPORT_SOURCES.join(', ')}`);
  if (VIA_SOURCES.has(source) && !ALERT_VIA.includes(via)) throw new Error(`--source ${source} needs --via ${ALERT_VIA.join('|')}`);
  if (!VIA_SOURCES.has(source) && via != null) throw new Error('--via is only used with --source email-alert or browser');
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
    const url = VIA_SOURCES.has(source) ? normalizeAlertUrl(raw, via) : canonicalJobUrl(raw);
    if (!url) return errors.push({ index, error: 'url must be an http(s) URL' });
    if (VIA_SOURCES.has(source)) {
      const host = new URL(url).hostname;
      const platform = PLATFORM_URLS[via];
      if (platform && !platform.isPlatformJobUrl(url)) return errors.push({ index, error: `not a ${via} job URL` });
      if (VIA_HOSTS[via] && !VIA_HOSTS[via].test(host)) return errors.push({ index, error: `not a ${via} URL` });
      if (!publicHost(host)) return errors.push({ index, error: 'url must point at a public host' });
    }
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
    jobs.push({ ...job, via: VIA_SOURCES.has(source) ? via : li ? 'LinkedIn' : null });
    return undefined;
  });
  return { jobs, errors, duplicates };
}
