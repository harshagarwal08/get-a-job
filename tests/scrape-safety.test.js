import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-safety-'));
process.env.GAJ_ROOT = ROOT;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures', 'scrape');
const json = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const prefs = JSON.parse(fs.readFileSync(path.join(REPO, 'examples', 'preferences.example.json'), 'utf8'));
const withSources = (sources) => ({ ...prefs, sources: { ...prefs.sources, ...sources } });

const { clampProviderConfig } = await import('../src/scrape/providers/limits.js');
const { meter, usageFor, monthOf } = await import('../src/scrape/usage.js');
const gj = await import('../src/scrape/providers/googlejobs.js');
const apify = await import('../src/scrape/providers/apify.js');
const jobspy = await import('../src/scrape/providers/jobspy.js');
const { getJSON, request, stripAuthHeaders } = await import('../src/scrape/http.js');
const { mergeJobs, sameLocation } = await import('../src/scrape/merge.js');
const { makeJob } = await import('../src/scrape/job.js');
const { importJobs } = await import('../src/scrape/importer.js');

const SECRET = 'sk_live_SAFETY_SECRET_987654';
const notFound = () => { const e = new Error('HTTP 404'); e.status = 404; throw e; };
void notFound;

// ---------- hard ceilings ----------
test('provider config is clamped to the hard ceilings with warnings', () => {
  let r = clampProviderConfig('googleJobs', { maxQueries: 500 });
  assert.equal(r.cfg.maxQueries, 20);
  assert.match(r.warnings[0], /clamped to 20/);
  r = clampProviderConfig('googleJobs', { maxQueries: 'lots' });
  assert.equal(r.cfg.maxQueries, 6);
  assert.match(r.warnings[0], /invalid/);
  assert.equal(clampProviderConfig('googleJobs', {}).cfg.maxRequestsPerMonth, 100);
  r = clampProviderConfig('apify', { maxItems: 0, maxChargeUsd: 50 });
  assert.equal(r.cfg.maxItems, 100, 'maxItems=0 never passed through');
  assert.equal(r.cfg.maxChargeUsd, 5);
  assert.equal(r.warnings.length, 2);
  r = clampProviderConfig('jobspy', { resultsWanted: 10000, maxQueries: 9, hoursOld: -1 });
  assert.deepEqual([r.cfg.resultsWanted, r.cfg.maxQueries, r.cfg.hoursOld], [100, 5, 168]);
  assert.deepEqual(clampProviderConfig('jobspy', true).cfg.maxQueries, 3);
});

// ---------- usage ledger ----------
test('meter counts each attempt and refuses past the monthly budget', () => {
  const now = Date.parse('2031-01-15T00:00:00Z');
  const m = meter('googleJobs', { maxRequests: 2, now });
  m.attempt();
  m.attempt();
  assert.throws(() => m.attempt(), (e) => e.code === 'BUDGET' && e.noRetry === true);
  assert.equal(usageFor('googleJobs', now).requests, 2);
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'usage.json'), 'utf8'));
  assert.deepEqual(ledger[monthOf(now)].googleJobs, { requests: 2, usdCap: 0 });
  const a = meter('apify', { maxUsd: 1, now });
  a.reserveUsd(0.6);
  assert.throws(() => a.reserveUsd(0.6), /monthly budget/);
  assert.equal(usageFor('apify', now).usdCap, 0.6);
});

test('googleJobs: retries count, budget stops the run with a warning, no failure', async () => {
  const now = Date.parse('2031-02-10T00:00:00Z');
  const p = withSources({ googleJobs: { enabled: true, provider: 'jsearch', maxQueries: 3, maxRequestsPerMonth: 3 } });
  let sent = 0;
  // each query costs 2 attempts (first fails, retry succeeds)
  const request = async (q, cfg, key, onAttempt) => { onAttempt(); onAttempt(); sent++; return json('jsearch.json'); };
  const r = await gj.fetchJobs(p, { getKey: () => SECRET, request, now });
  assert.equal(sent, 1, 'second query refused: 2 used + 2 would pass 3');
  assert.match(r.warning, /monthly request budget reached \(3\/3\)/);
  assert.match(r.usage, /^google-jobs: 3 requests this run, 3\/3 this month \(jsearch\)/);
  assert.equal(r.jobs.length, 2);
});

test('JSearch retries go through onAttempt (real http path, mocked fetch)', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => (++calls === 1 ? new Response('busy', { status: 503 }) : new Response(JSON.stringify(json('jsearch.json')), { status: 200 }));
    let attempts = 0;
    await getJSON('https://jsearch.p.rapidapi.com/search?query=x', { retries: 1, backoff: 1, onAttempt: () => { attempts++; } });
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- http: auth headers across origins ----------
test('credential headers are dropped when a redirect changes origin; noRedirect refuses', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  try {
    globalThis.fetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      if (url.startsWith('https://jsearch.p.rapidapi.com')) return new Response(null, { status: 302, headers: { location: 'https://serpapi.com/x' } });
      if (url === 'https://api.apify.com/a') return new Response(null, { status: 302, headers: { location: '/b' } });
      return new Response('{}', { status: 200 });
    };
    await getJSON('https://jsearch.p.rapidapi.com/search', { retries: 0, headers: { 'x-rapidapi-key': SECRET, 'x-rapidapi-host': 'jsearch.p.rapidapi.com', authorization: `Bearer ${SECRET}` } });
    assert.equal(seen[0].headers['x-rapidapi-key'], SECRET);
    assert.equal(seen[1].url, 'https://serpapi.com/x');
    assert.ok(!JSON.stringify(seen[1].headers).includes(SECRET), 'no credentials to the other origin');
    seen.length = 0;
    await getJSON('https://api.apify.com/a', { retries: 0, headers: { authorization: `Bearer ${SECRET}` } });
    assert.equal(seen[1].headers.authorization, `Bearer ${SECRET}`, 'same-origin redirect keeps auth');
    await assert.rejects(request('https://api.apify.com/a', { retries: 0, noRedirect: true }), /redirects are disabled/);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(stripAuthHeaders({ Authorization: 'x', 'X-RapidAPI-Key': 'y', accept: 'a', 'user-agent': 'u' }), { accept: 'a', 'user-agent': 'u' });
});

// ---------- apify async flow ----------
test('apify runActor: passes timeout/memory/maxItems/charge, polls, fetches dataset', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET', auth: init.headers?.authorization });
      if (url.includes('/acts/someone~scraper/runs')) return Response.json({ data: { id: 'run1', status: 'RUNNING', defaultDatasetId: 'ds1' } });
      if (url.includes('/actor-runs/run1?waitForFinish')) return Response.json({ data: { id: 'run1', status: 'SUCCEEDED', defaultDatasetId: 'ds1' } });
      if (url.includes('/datasets/ds1/items')) return Response.json(json('apify.json'));
      return new Response('nope', { status: 404 });
    };
    let attempts = 0;
    const items = await apify.runActor('someone~scraper', { input: { q: 1 }, maxItems: 50, maxChargeUsd: 0.3, memory: 256 }, SECRET, { onAttempt: () => { attempts++; } });
    assert.equal(items.length, 3);
    const start = new URL(calls[0].url);
    assert.equal(calls[0].method, 'POST');
    assert.deepEqual(Object.fromEntries(start.searchParams), { timeout: '240', memory: '256', maxItems: '50', maxTotalChargeUsd: '0.3' });
    assert.ok(calls.every((c) => c.auth === `Bearer ${SECRET}` && !c.url.includes(SECRET)), 'token only in the header');
    assert.equal(attempts, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('apify runActor aborts the run when it outlives the local deadline', async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  let t = 0;
  const now = () => t;
  try {
    globalThis.fetch = async (url, init) => {
      calls.push(`${init.method ?? 'GET'} ${url}`);
      if (url.includes('/runs?')) return Response.json({ data: { id: 'run9', status: 'RUNNING', defaultDatasetId: 'ds9' } });
      if (url.includes('/abort')) return Response.json({ data: { id: 'run9', status: 'ABORTING' } });
      t += 600; // each poll "waits" 0.6s and the run is still going
      return Response.json({ data: { id: 'run9', status: 'RUNNING' } });
    };
    await assert.rejects(apify.runActor('someone~scraper', { input: {}, maxItems: 5, maxChargeUsd: 0.1 }, SECRET, { deadlineMs: 1000, now, sleep: async () => {} }), /run aborted \(timed out\)/);
    assert.ok(calls.filter((c) => c.includes('waitForFinish')).length >= 2, 'polled before giving up');
    assert.ok(calls.some((c) => c === 'POST https://api.apify.com/v2/actor-runs/run9/abort'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('apify: more than 3 actors refused; monthly dollar budget enforced', async () => {
  const now = Date.parse('2031-03-05T00:00:00Z');
  const four = Array.from({ length: 4 }, (_, i) => ({ id: `o~a${i}`, input: {} }));
  await assert.rejects(apify.fetchJobs(withSources({ apify: { enabled: true, actors: four } }), { getKey: () => SECRET, run: async () => [] }), /at most 3 are allowed/);
  const p = withSources({ apify: { enabled: true, actors: [{ id: 'o~a', input: { q: 1 } }, { id: 'o~b', input: { q: 2 } }], maxChargeUsd: 0.4, maxUsdPerMonth: 0.5 } });
  let runs = 0;
  const r = await apify.fetchJobs(p, { getKey: () => SECRET, now, run: async (a, c, t, { onAttempt }) => { onAttempt(); runs++; return json('apify.json'); } });
  assert.equal(runs, 1);
  assert.match(r.warning, /monthly budget would pass \$0\.5/);
  assert.match(r.usage, /^apify: 1 run, 3 items, cap \$0\.40\/actor\/run, ~\$0\.40\/\$0\.5 budget used this month \(caps, not actual charges\)/);
});

// ---------- jobspy ----------
test('jobspy: pinned version, key-stripped env, linkedin only when sources.linkedin', async () => {
  const [cmd, argv] = jobspy.runnerCommand({ a: 1 });
  assert.equal(cmd, 'uvx');
  assert.ok(argv.includes(`python-jobspy==${jobspy.JOBSPY_VERSION}`));
  assert.match(jobspy.JOBSPY_VERSION, /^\d+\.\d+\.\d+$/);
  const env = jobspy.childEnv({ PATH: '/bin', HOME: '/h', SERPAPI_API_KEY: 'x', JSEARCH_RAPIDAPI_KEY: 'y', APIFY_TOKEN: 'z', GITHUB_TOKEN: 'g', OPENAI_API_KEY: 'o', DB_PASSWORD: 'p', MY_SECRET: 's' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h' });
  let args;
  const run = async (a) => { args = a; return []; };
  const off = await jobspy.fetchJobs(withSources({ linkedin: false, jobspy: { enabled: true, sites: ['linkedin', 'indeed'], resultsWanted: 999 } }), { hasUv: () => true, run });
  assert.deepEqual(args.sites, ['indeed']);
  assert.equal(args.results_wanted, 100);
  assert.match(off.warning, /skipping linkedin/);
  await jobspy.fetchJobs(withSources({ linkedin: true, jobspy: { enabled: true, sites: ['linkedin', 'indeed'], maxQueries: 1 } }), { hasUv: () => true, run });
  assert.deepEqual(args.sites, ['linkedin', 'indeed']);
  const only = await jobspy.fetchJobs(withSources({ linkedin: false, jobspy: { enabled: true, sites: ['linkedin'] } }), { hasUv: () => true, run });
  assert.equal(only.jobs.length, 0);
});

// ---------- merge ----------
const rec = (o) => ({ ...makeJob({ source: 'greenhouse', url: 'https://x.example', ...o }), track: 'fe', eligibility: 'unknown', eligibilityReason: 'x' });

test('reviewer repro: expired orange SF greenhouse job vs green Bengaluru google-jobs job → both kept', () => {
  const sf = { ...rec({ title: 'Frontend Engineer', company: 'Acme', location: 'San Francisco, CA', sourceId: 'gh1' }), eligibility: 'orange' };
  let { store } = mergeJobs({ version: 1, jobs: {} }, [sf], { now: '2026-09-01T00:00:00Z' });
  store.jobs[sf.key].status = 'expired';
  const blr = { ...rec({ title: 'Frontend Engineer', company: 'Acme', location: 'Bengaluru, India', source: 'google-jobs', sourceId: 'g1' }), eligibility: 'green' };
  const res = mergeJobs(store, [blr], { now: '2026-10-17T00:00:00Z' });
  assert.equal(Object.keys(res.store.jobs).length, 2);
  assert.equal(res.store.jobs[blr.key].eligibility, 'green');
  assert.equal(res.stats.crossSource, 0);
});

test('fold only when locations agree; live records only', () => {
  const ats = rec({ title: 'Frontend Engineer', company: 'Acme', location: 'London, UK', sourceId: 'gh2' });
  let { store } = mergeJobs({ version: 1, jobs: {} }, [ats], { now: '2026-10-01T00:00:00Z' });
  const india = rec({ title: 'Frontend Engineer', company: 'Acme', location: 'Bengaluru, India', source: 'jobspy', sourceId: 'j1' });
  const london = rec({ title: 'Frontend Engineer', company: 'Acme Ltd', location: 'London, England', source: 'jobspy', sourceId: 'j2' });
  const res = mergeJobs(store, [india, london], { now: '2026-10-02T00:00:00Z' });
  assert.ok(res.store.jobs[india.key], 'different country → new record');
  assert.deepEqual(res.store.jobs[ats.key].alsoSeenOn, ['jobspy']);
  assert.equal(sameLocation({ countries: [], location: 'Pune' }, { countries: [], location: 'Pune, MH' }), true);
  assert.equal(sameLocation({ countries: [], location: 'Pune' }, { countries: [], location: 'Mumbai' }), false);
  // skipped ATS record is not a fold target
  ({ store } = mergeJobs({ version: 1, jobs: {} }, [ats], { now: '2026-10-01T00:00:00Z' }));
  store.jobs[ats.key].status = 'skipped';
  const again = mergeJobs(store, [london], { now: '2026-10-02T00:00:00Z' });
  assert.ok(again.store.jobs[london.key]);
});

test('time-based expiry keeps tracked jobs, expires ranked ones', () => {
  const t = rec({ title: 'UI Engineer', company: 'T Co', location: 'Remote', source: 'google-jobs', sourceId: 't' });
  const r = rec({ title: 'UI Engineer', company: 'R Co', location: 'Remote', source: 'google-jobs', sourceId: 'r' });
  let { store } = mergeJobs({ version: 1, jobs: {} }, [t, r], { now: '2026-09-01T00:00:00Z' });
  store.jobs[t.key].status = 'tracked';
  store.jobs[r.key].status = 'ranked';
  ({ store } = mergeJobs(store, [], { now: '2026-11-01T00:00:00Z', boardExpireDays: 28 }));
  assert.equal(store.jobs[t.key].status, 'tracked');
  assert.equal(store.jobs[r.key].status, 'expired');
});

// ---------- jobs:import caps ----------
test('importJobs caps lengths and drops future postedAt', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const r = importJobs([{ title: 'T'.repeat(500), company: 'C'.repeat(300), url: 'https://x.example/1', description: 'd'.repeat(120000), postedAt: '2030-01-01T00:00:00Z' }], { now });
  const [j] = r.jobs;
  assert.equal(j.title.length, 200);
  assert.equal(j.company.length, 120);
  assert.equal(j.description.length, 50000);
  assert.equal(j.postedAt, null);
});

// ---------- paid gating (CLI) ----------
test('scrape skips paid providers without --paid / GAJ_ALLOW_PAID', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-paid-'));
  try {
    fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    const p = withSources({ hn: false, remotive: false, arbeitnow: false, remoteok: false, linkedin: false, careersPages: false,
      googleJobs: { enabled: true, provider: 'jsearch' }, apify: { enabled: true, actors: [] }, jobspy: { enabled: false } });
    fs.writeFileSync(path.join(root, 'profile', 'preferences.json'), JSON.stringify(p));
    fs.writeFileSync(path.join(root, 'config', 'companies.json'), JSON.stringify({ version: 1, companies: [] }));
    const env = { ...process.env, GAJ_ROOT: root };
    delete env.GAJ_ALLOW_PAID;
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'gaj.js'), 'scrape', '--json'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.ok(s.warnings.includes('paid providers skipped (pass --paid): googleJobs, apify'));
    assert.deepEqual(s.usage, []);
    const withPaid = spawnSync(process.execPath, [path.join(REPO, 'bin', 'gaj.js'), 'scrape', '--json', '--paid'],
      { env: { ...env, JSEARCH_RAPIDAPI_KEY: '', APIFY_TOKEN: '' }, encoding: 'utf8' });
    const s2 = JSON.parse(withPaid.stdout);
    assert.ok(!s2.warnings.some((w) => /paid providers skipped/.test(w)));
    assert.ok(s2.usage.some((u) => /google-jobs: skipped \(no jsearch key\)/.test(u)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
