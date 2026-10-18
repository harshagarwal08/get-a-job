// python-jobspy (open source) via uvx. Opt-in (preferences.sources.jobspy). It scrapes
// LinkedIn/Indeed/Naukri/Glassdoor/Google search pages, which those sites' terms may forbid:
// personal, low-volume use only.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cached } from '../cache.js';
import { makeJob, makeSalary, salaryUnit } from '../job.js';
import { buildQueries, PROVIDER_TTL, hashOf, isOn } from './common.js';
import { clampProviderConfig } from './limits.js';
import { KEYS } from '../../lib/env.js';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'jobspy_runner.py');
const TIMEOUT_MS = 180000;
export const JOBSPY_VERSION = '1.3.0'; // pinned; verified on PyPI 2026-10-17
const SITES = new Set(['linkedin', 'indeed', 'naukri', 'glassdoor', 'google', 'zip_recruiter', 'bayt', 'bdjobs']);
const INDEED_COUNTRY = { IN: 'india', US: 'usa', GB: 'uk', CA: 'canada', AU: 'australia', DE: 'germany', FR: 'france', NL: 'netherlands', SG: 'singapore', AE: 'united arab emirates', IE: 'ireland', ES: 'spain' };

/** True if `uvx` is on PATH. */
export function hasUv(run = spawnSync) {
  try { return run('uvx', ['--version'], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

/**
 * Normalise jobspy records (one per job; dates already ISO strings).
 * @param {object[]} records
 */
export function normalize(records) {
  return (Array.isArray(records) ? records : []).filter((r) => r && r.title && r.company && r.job_url).map((r) => {
    const job = makeJob({
      title: r.title,
      company: r.company,
      location: r.is_remote && !/remote/i.test(r.location ?? '') ? `Remote${r.location ? ` (${r.location})` : ''}` : (r.location ?? ''),
      workModeField: r.is_remote ? 'remote' : null,
      url: r.job_url,
      applyUrl: r.job_url_direct ?? r.job_url,
      source: 'jobspy',
      sourceId: r.id ?? r.job_url,
      department: r.job_function ?? null,
      salary: makeSalary(r.min_amount, r.max_amount, r.currency, salaryUnit(r.interval)),
      postedAt: r.date_posted ?? null,
      description: r.description ?? '',
    });
    return { ...job, via: r.site ?? null };
  });
}

/** Run the Python runner once; resolves to parsed records. */
/**
 * Environment for the Python child: provider keys and anything that looks like a secret
 * (*_KEY, *_TOKEN, *_SECRET, *PASSWORD*) removed.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function childEnv(env = process.env) {
  const drop = new Set(Object.values(KEYS));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k) && !/(_KEY|_TOKEN|_SECRET|PASSWORD|_PASS)$/i.test(k) && !/API_?KEY|SECRET|PASSWORD/i.test(k)));
}

/** Command line for the pinned runner. */
export function runnerCommand(args) {
  return ['uvx', ['--python', '3.12', '--with', `python-jobspy==${JOBSPY_VERSION}`, 'python', RUNNER, JSON.stringify(args)]];
}

export function runJobspy(args, { timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = runnerCommand(args);
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`jobspy timed out after ${timeout / 1000}s`)); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`jobspy exited ${code}: ${err.trim().split('\n').pop() ?? ''}`));
      try { resolve(JSON.parse(out || '[]')); } catch (e) { reject(new Error(`jobspy printed invalid JSON: ${e.message}`)); }
    });
  });
}

/**
 * Run jobspy for the user's queries (12h cache per query).
 * @param {object} prefs
 * @param {{trackId?: string, run?: Function, hasUv?: Function}} [opts] injectable for tests
 * @returns {Promise<{jobs: object[], usage: string, warning?: string}>}
 */
export async function fetchJobs(prefs, opts = {}) {
  const { cfg, warnings } = clampProviderConfig('jobspy', prefs.sources?.jobspy);
  if (!(opts.hasUv ?? hasUv)()) {
    return { jobs: [], usage: 'jobspy: skipped (uv not installed)', warning: 'jobspy: needs uv (brew install uv, or https://docs.astral.sh/uv/getting-started/installation/); skipping' };
  }
  const linkedinOk = isOn(prefs.sources?.linkedin);
  const wanted = Array.isArray(cfg.sites) ? cfg.sites : ['indeed'];
  const sites = wanted.filter((s) => SITES.has(s) && (s !== 'linkedin' || linkedinOk));
  if (wanted.includes('linkedin') && !linkedinOk) warnings.push('jobspy: skipping linkedin (enable sources.linkedin to allow it)');
  if (!sites.length) return { jobs: [], usage: 'jobspy: no usable sites', warning: warnings.join('; ') || 'jobspy: no usable sites' };
  const queries = buildQueries(prefs, { maxQueries: cfg.maxQueries, trackId: opts.trackId });
  const country = INDEED_COUNTRY[prefs.location?.countryCode] ?? null;
  const jobs = [];
  let live = 0;
  const errors = [];
  for (const q of queries) {
    const args = {
      sites, search_term: q.remote ? `${q.term} remote` : q.term, location: q.remote ? (prefs.location?.based ?? '') : q.location,
      results_wanted: cfg.resultsWanted, hours_old: cfg.hoursOld, country_indeed: country,
    };
    try {
      const res = await cached(`jobspy-${hashOf(args)}`, PROVIDER_TTL, async () => { live++; return (opts.run ?? runJobspy)(args); });
      jobs.push(...normalize(res.data));
    } catch (err) {
      errors.push(err.message);
    }
  }
  const usage = `jobspy: ${live} run${live === 1 ? '' : 's'} (${sites.join(', ')})${errors.length ? `, ${errors.length} failed` : ''}`;
  if (errors.length && !jobs.length) throw new Error(`jobspy: ${errors[0]}`);
  return { jobs, usage, ...(warnings.length ? { warning: warnings.join('; ') } : {}) };
}
