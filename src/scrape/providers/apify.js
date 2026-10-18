// Apify actors via the async run API (start → wait → dataset items; abort on timeout).
// Opt-in (preferences.sources.apify) and paid: every run passes maxItems, timeout, memory and
// maxTotalChargeUsd (the last only bounds pay-per-event actors). The token goes in an
// Authorization header so it never appears in URLs, logs or cache files. Actors needing
// cookies/credentials are refused.
import { request, redact } from '../http.js';
import { cached } from '../cache.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary, parseSalaryText } from '../job.js';
import { getKey } from '../../lib/env.js';
import { PROVIDER_TTL, hashOf, scrub, relativeToISO } from './common.js';
import { clampProviderConfig, MAX_APIFY_ACTORS } from './limits.js';
import { meter } from '../usage.js';

const API = 'https://api.apify.com/v2/acts';
const FORBIDDEN_INPUT = /cookie|password|passwd|li_at|session_?id|auth_?token|credential/i;

/**
 * Return the first forbidden key path in an actor input (cookies, passwords, li_at, ...), or null.
 * @param {unknown} input
 */
export function forbiddenInputKey(input, prefix = '') {
  if (!input || typeof input !== 'object') return null;
  for (const [k, v] of Object.entries(input)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (FORBIDDEN_INPUT.test(k)) return p;
    const nested = forbiddenInputKey(v, p);
    if (nested) return nested;
  }
  return null;
}

/** Apify actor ids are "owner~name" (also accepts "owner/name"). Returns null if invalid. */
export function actorPath(id) {
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)[~/]([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(String(id ?? ''));
  return m ? `${m[1]}~${m[2]}` : null;
}

const first = (o, keys) => { for (const k of keys) { const v = k.split('.').reduce((a, p) => a?.[p], o); if (v !== undefined && v !== null && v !== '') return v; } return null; };
const str = (v) => (v && typeof v === 'object' ? (v.name ?? v.title ?? v.text ?? JSON.stringify(v)) : v);

/**
 * Heuristically map dataset items from common job-scraper actors to jobs.
 * @param {object[]} items
 * @param {string} actorId used as `via`
 * @param {{now?: number}} [opts]
 */
export function normalize(items, actorId, { now = Date.now() } = {}) {
  const jobs = [];
  for (const it of Array.isArray(items) ? items : []) {
    const title = str(first(it, ['title', 'positionName', 'jobTitle', 'position', 'name']));
    const company = str(first(it, ['companyName', 'company', 'company.name', 'employerName', 'organization', 'hiringOrganization.name']));
    const url = first(it, ['url', 'jobUrl', 'link', 'jobLink', 'applyUrl', 'externalApplyLink']);
    if (!title || !company || !url) continue;
    const location = str(first(it, ['location', 'jobLocation', 'place', 'formattedLocation', 'city'])) ?? '';
    const descHtml = first(it, ['descriptionHtml', 'description_html']);
    const description = descHtml ? htmlToText(descHtml) : String(first(it, ['description', 'descriptionText', 'jobDescription', 'snippet']) ?? '');
    const postedRaw = first(it, ['postedAt', 'publishedAt', 'datePosted', 'postingDate', 'date', 'listedAt', 'postedTime']);
    const postedAt = typeof postedRaw === 'string' && /ago|today|just/i.test(postedRaw) ? relativeToISO(postedRaw, now) : postedRaw;
    const salaryRaw = first(it, ['salary', 'salaryText', 'salaryInfo']);
    const salary = typeof salaryRaw === 'string' ? parseSalaryText(salaryRaw)
      : salaryRaw && typeof salaryRaw === 'object' ? makeSalary(salaryRaw.min ?? salaryRaw.from, salaryRaw.max ?? salaryRaw.to, salaryRaw.currency, salaryRaw.unit ?? 'year') : null;
    const remote = first(it, ['isRemote', 'remote', 'workFromHome']) === true || /remote/i.test(String(first(it, ['workplaceType', 'workType', 'jobType']) ?? ''));
    const job = makeJob({
      title: String(title), company: String(company), location: String(location),
      workModeField: remote ? 'remote' : first(it, ['workplaceType']),
      url, applyUrl: first(it, ['applyUrl', 'externalApplyLink', 'applyLink']) ?? url,
      source: 'apify', sourceId: first(it, ['id', 'jobId', 'positionId']) ?? url,
      salary, postedAt, description,
    });
    jobs.push({ ...job, via: actorId });
  }
  return jobs;
}

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const ACTOR_TIMEOUT_S = 240;
const LOCAL_DEADLINE_MS = 270000;

/**
 * Start an actor run, wait for it, fetch its dataset. Uses the async run API so a run that
 * outlives our deadline can be aborted (no orphaned, still-billing runs).
 * Note: maxTotalChargeUsd only bounds pay-per-event actors; compute-unit actors are bounded by
 * maxItems + timeout + memory, which we always pass.
 * @param {string} actor "owner~name"
 * @param {{input: object, maxItems: number, maxChargeUsd: number, memory?: number}} cfg
 * @param {string} token
 * @param {{onAttempt?: Function, deadlineMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>}} [opts]
 */
export async function runActor(actor, cfg, token, { onAttempt, deadlineMs = LOCAL_DEADLINE_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const base = { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, secrets: [token], onAttempt, noRedirect: true };
  const params = new URLSearchParams({
    timeout: String(ACTOR_TIMEOUT_S), memory: String(cfg.memory === 256 ? 256 : 512),
    maxItems: String(cfg.maxItems), maxTotalChargeUsd: String(cfg.maxChargeUsd),
  });
  const start = await (await request(`${API}/${actor}/runs?${params}`, {
    ...base, method: 'POST', headers: { ...base.headers, 'content-type': 'application/json' }, body: JSON.stringify(cfg.input ?? {}), timeout: 30000, retries: 0,
  })).json();
  let run = start.data ?? {};
  const t0 = now();
  try {
    while (!TERMINAL.has(run.status)) {
      const left = deadlineMs - (now() - t0);
      if (left <= 0) throw Object.assign(new Error(`run ${run.id} did not finish within ${Math.round(deadlineMs / 1000)}s`), { timedOut: true });
      const wait = Math.max(1, Math.min(60, Math.floor(left / 1000)));
      const before = Date.now();
      run = (await (await request(`https://api.apify.com/v2/actor-runs/${run.id}?waitForFinish=${wait}`, { ...base, timeout: (wait + 15) * 1000, retries: 1 })).json()).data ?? run;
      // waitForFinish normally blocks server-side; never spin if it returns early
      if (!TERMINAL.has(run.status) && Date.now() - before < 1000) await sleep(2000);
    }
  } catch (err) {
    if (run.id) {
      try { await request(`https://api.apify.com/v2/actor-runs/${run.id}/abort`, { ...base, method: 'POST', timeout: 15000, retries: 1 }); } catch { /* best effort */ }
    }
    throw err.timedOut || err.status === 408 || err.name === 'TimeoutError' ? new Error(`${actor}: run aborted (timed out)`) : err;
  }
  if (run.status === 'FAILED') throw new Error(`${actor}: run failed`);
  const items = await (await request(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=${cfg.maxItems}`, { ...base, timeout: 60000, retries: 1 })).json();
  return Array.isArray(items) ? items : [];
}

/**
 * Run each configured actor once (12h cache per actor+input), at most 3 actors.
 * Each run reserves its `maxChargeUsd` cap in data/usage.json first and is refused once the
 * month's `maxUsdPerMonth` would be exceeded.
 * @param {object} prefs
 * @param {{getKey?: Function, run?: Function, now?: number}} [opts] injectable for tests
 * @returns {Promise<{jobs: object[], usage: string, warning?: string}>}
 */
export async function fetchJobs(prefs, opts = {}) {
  const { cfg, warnings } = clampProviderConfig('apify', prefs.sources?.apify);
  const token = (opts.getKey ?? getKey)('apify');
  if (!token) return { jobs: [], usage: 'apify: skipped (no APIFY_TOKEN)', warning: ['apify: no APIFY_TOKEN in .env; skipping', ...warnings].join('; ') };
  const actors = Array.isArray(cfg.actors) ? cfg.actors : [];
  if (!actors.length) return { jobs: [], usage: 'apify: no actors configured' };
  if (actors.length > MAX_APIFY_ACTORS) throw new Error(`apify: ${actors.length} actors configured; at most ${MAX_APIFY_ACTORS} are allowed`);
  const m = meter('apify', { maxUsd: cfg.maxUsdPerMonth, now: opts.now });
  const jobs = [];
  let runs = 0;
  let items = 0;
  const errors = [];
  let budgetHit = null;
  for (const a of actors) {
    const actor = actorPath(a.id);
    if (!actor) { errors.push(`invalid actor id "${a.id}" (expected owner~name)`); continue; }
    const bad = forbiddenInputKey(a.input);
    if (bad) { errors.push(`refusing actor ${actor}: its input has "${bad}" (cookies, passwords and session tokens are never sent)`); continue; }
    if (budgetHit) break;
    try {
      const res = await cached(`apify-${hashOf([actor, a.input, cfg.maxItems, cfg.maxChargeUsd])}`, PROVIDER_TTL, async () => {
        m.reserveUsd(cfg.maxChargeUsd);
        runs++;
        try {
          return scrub(await (opts.run ?? runActor)(actor, { ...cfg, input: a.input }, token, { onAttempt: () => m.attempt() }), token);
        } catch (err) {
          throw new Error(redact(err.message, [token])); // the negative cache stores this message
        }
      }, { cacheFailure: (err) => err.code !== 'BUDGET' });
      const list = Array.isArray(res.data) ? res.data : [];
      items += list.length;
      jobs.push(...normalize(list, actor));
    } catch (err) {
      if (err.code === 'BUDGET') budgetHit = err.message;
      else errors.push(`${actor}: ${redact(err.message, [token])}`);
    }
  }
  const month = m.month();
  const usage = `apify: ${runs} run${runs === 1 ? '' : 's'}, ${items} items, cap $${cfg.maxChargeUsd.toFixed(2)}/actor/run, ~$${month.usdCap.toFixed(2)}/$${cfg.maxUsdPerMonth} budget used this month (caps, not actual charges)${errors.length ? `, ${errors.length} failed` : ''}`;
  const warning = [budgetHit, ...warnings, ...(jobs.length ? errors : [])].filter(Boolean).join('; ') || undefined;
  if (errors.length && !jobs.length && !budgetHit) throw new Error(`apify: ${errors.join('; ')}`);
  return { jobs, usage, ...(warning ? { warning } : {}) };
}
