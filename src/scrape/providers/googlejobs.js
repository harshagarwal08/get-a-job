// Google Jobs results via JSearch (RapidAPI / OpenWeb Ninja) or SerpAPI's google_jobs engine.
// Opt-in (preferences.sources.googleJobs), paid, capped by maxQueries. Keys come from
// src/lib/env.js and are never logged, cached or written to data/.
import { getJSON, redact } from '../http.js';
import { cached } from '../cache.js';
import { makeJob, makeSalary, salaryUnit, parseSalaryText } from '../job.js';
import { getKey } from '../../lib/env.js';
import { buildQueries, PROVIDER_TTL, hashOf, scrub, relativeToISO, isAggregatorLink } from './common.js';
import { clampProviderConfig } from './limits.js';
import { meter } from '../usage.js';

const JSEARCH = 'https://jsearch.p.rapidapi.com/search';
const SERPAPI = 'https://serpapi.com/search.json';
const DATE_POSTED = new Set(['all', 'today', '3days', 'week', 'month']);

/** Prefer an employer/ATS apply link over aggregator links. */
function pickApply(options, fallback) {
  const direct = options.find((o) => o.direct) ?? options.find((o) => o.link && !isAggregatorLink(o.link));
  return direct?.link ?? fallback ?? options[0]?.link ?? null;
}

/**
 * Normalise a JSearch /search response (`{status, data: [...]}`).
 * @param {{data?: object[]}} payload
 */
export function normalizeJSearch(payload) {
  return (payload?.data ?? []).map((j) => {
    const options = (j.apply_options ?? []).map((o) => ({ link: o.apply_link, direct: o.is_direct === true, publisher: o.publisher }));
    if (j.job_apply_link) options.unshift({ link: j.job_apply_link, direct: j.job_apply_is_direct === true, publisher: j.job_publisher });
    const location = j.job_location || [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', ');
    const job = makeJob({
      title: j.job_title,
      company: j.employer_name,
      location: j.job_is_remote && !/remote/i.test(location) ? `Remote${location ? ` (${location})` : ''}` : location,
      countryHints: j.job_country ? [j.job_country] : [],
      workModeField: j.job_is_remote ? 'remote' : (j.work_arrangement ?? null),
      url: j.job_apply_link ?? j.job_google_link,
      applyUrl: pickApply(options, j.job_apply_link),
      source: 'google-jobs',
      sourceId: j.job_id,
      salary: makeSalary(j.job_min_salary, j.job_max_salary, j.job_salary_currency, salaryUnit(j.job_salary_period)),
      postedAt: j.job_posted_at_datetime_utc ?? j.job_posted_at_timestamp ?? null,
      description: j.job_description ?? '',
    });
    return { ...job, via: j.job_publisher ?? null };
  });
}

/**
 * Normalise a SerpAPI google_jobs response (`{jobs_results: [...]}`).
 * @param {{jobs_results?: object[]}} payload
 * @param {{now?: number}} [opts] reference time for "3 days ago"
 */
export function normalizeSerpApi(payload, { now = Date.now() } = {}) {
  return (payload?.jobs_results ?? []).map((j) => {
    const ext = j.detected_extensions ?? {};
    const options = (j.apply_options ?? []).map((o) => ({ link: o.link, publisher: o.title }));
    const via = String(j.via ?? '').replace(/^via\s+/i, '') || options[0]?.publisher || null;
    const job = makeJob({
      title: j.title,
      company: j.company_name,
      location: ext.work_from_home && !/remote/i.test(j.location ?? '') ? `Remote${j.location ? ` (${j.location})` : ''}` : (j.location ?? ''),
      workModeField: ext.work_from_home ? 'remote' : null,
      url: options[0]?.link ?? j.share_link,
      applyUrl: pickApply(options, null),
      source: 'google-jobs',
      sourceId: j.job_id,
      salary: parseSalaryText(ext.salary),
      postedAt: relativeToISO(ext.posted_at, now),
      description: j.description ?? '',
    });
    return { ...job, via };
  });
}

function jsearchRequest(q, cfg, key, onAttempt) {
  const query = q.remote ? `${q.term} remote` : `${q.term} in ${q.location}`;
  const params = new URLSearchParams({ query, page: '1', num_pages: '1' });
  if (cfg.country) params.set('country', String(cfg.country).toLowerCase());
  if (DATE_POSTED.has(cfg.datePosted)) params.set('date_posted', cfg.datePosted);
  if (q.remote) params.set('work_from_home', 'true');
  return getJSON(`${JSEARCH}?${params}`, {
    headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'jsearch.p.rapidapi.com' },
    timeout: 30000, retries: 1, secrets: [key], onAttempt, noRedirect: true,
  });
}

function serpRequest(q, cfg, key, onAttempt) {
  const params = new URLSearchParams({ engine: 'google_jobs', q: q.remote ? `${q.term} remote` : `${q.term} ${q.location}`, hl: 'en' });
  if (cfg.country) params.set('gl', String(cfg.country).toLowerCase());
  if (!q.remote && q.location) params.set('location', q.location);
  params.set('api_key', key); // SerpAPI only accepts the key as a query param; errors are redacted
  return getJSON(`${SERPAPI}?${params}`, { timeout: 30000, retries: 1, secrets: [key], onAttempt, noRedirect: true });
}

/**
 * Run the configured Google Jobs provider for the user's queries (12h cache per query).
 * Every HTTP attempt (retries included) is counted in data/usage.json and refused once
 * `maxRequestsPerMonth` is reached.
 * @param {object} prefs
 * @param {{trackId?: string, getKey?: Function, request?: Function, now?: number}} [opts] injectable for tests
 * @returns {Promise<{jobs: object[], usage: string, warning?: string}>}
 */
export async function fetchJobs(prefs, opts = {}) {
  const { cfg, warnings } = clampProviderConfig('googleJobs', prefs.sources?.googleJobs);
  const provider = cfg.provider === 'serpapi' ? 'serpapi' : 'jsearch';
  const key = (opts.getKey ?? getKey)(provider);
  if (!key) return { jobs: [], usage: `google-jobs: skipped (no ${provider} key)`, warning: [`google-jobs: no ${provider} key in .env; skipping`, ...warnings].join('; ') };
  const queries = buildQueries(prefs, { maxQueries: cfg.maxQueries, trackId: opts.trackId });
  const send = opts.request ?? (provider === 'jsearch' ? jsearchRequest : serpRequest);
  const m = meter('googleJobs', { maxRequests: cfg.maxRequestsPerMonth, now: opts.now });
  const jobs = [];
  let fromCache = 0;
  const errors = [];
  let budgetHit = null;
  for (const q of queries) {
    if (budgetHit) break;
    try {
      const res = await cached(`googlejobs-${provider}-${hashOf([q, cfg.country, cfg.datePosted])}`, PROVIDER_TTL, async () => {
        try {
          return scrub(await send(q, cfg, key, () => m.attempt()), key, ['search_metadata', 'search_parameters', 'parameters', 'serpapi_pagination']);
        } catch (err) {
          if (err.code === 'BUDGET') throw err;
          throw new Error(redact(err.message, [key])); // the negative cache stores this message
        }
      }, { cacheFailure: (err) => err.code !== 'BUDGET' });
      if (res.cached) fromCache++;
      jobs.push(...(provider === 'jsearch' ? normalizeJSearch(res.data) : normalizeSerpApi(res.data)));
    } catch (err) {
      if (err.code === 'BUDGET') budgetHit = err.message;
      else errors.push(redact(err.message, [key]));
    }
  }
  const month = m.month();
  const usage = `google-jobs: ${m.run.requests} request${m.run.requests === 1 ? '' : 's'} this run, ${month.requests}/${cfg.maxRequestsPerMonth} this month (${provider})${fromCache ? `, ${fromCache} cached` : ''}${errors.length ? `, ${errors.length} failed` : ''}`;
  const warning = [budgetHit, ...warnings].filter(Boolean).join('; ') || undefined;
  if (errors.length && !jobs.length && !budgetHit) throw new Error(`google-jobs (${provider}): ${errors[0]}`);
  return { jobs, usage, ...(warning ? { warning } : {}) };
}
