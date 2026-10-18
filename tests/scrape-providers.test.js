import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// paths.js reads GAJ_ROOT at import time: set it before any dynamic import.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-providers-'));
process.env.GAJ_ROOT = ROOT;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'scrape');
const REPO = path.resolve(HERE, '..');
const json = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const prefs = JSON.parse(fs.readFileSync(path.join(REPO, 'examples', 'preferences.example.json'), 'utf8'));

const common = await import('../src/scrape/providers/common.js');
const gj = await import('../src/scrape/providers/googlejobs.js');
const apify = await import('../src/scrape/providers/apify.js');
const jobspy = await import('../src/scrape/providers/jobspy.js');
const { importJobs, canonicalJobUrl } = await import('../src/scrape/importer.js');
const { mergeJobs, identityOf } = await import('../src/scrape/merge.js');
const { redact, redactUrl, HttpError } = await import('../src/scrape/http.js');
const { checkCompany } = await import('../src/scrape/cli.js');
const { validateCompany } = await import('../src/scrape/companies.js');
const { makeJob } = await import('../src/scrape/job.js');

const SECRET = 'sk_live_TEST_SECRET_123456';
const cacheText = () => {
  const dir = path.join(ROOT, 'data', 'cache');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') : '';
};
const withSources = (sources) => ({ ...prefs, sources: { ...prefs.sources, ...sources } });

// ---------- query builder ----------
test('buildQueries: titles × locations + remote, aliases once, capped, interleaved across tracks', () => {
  const p = { ...prefs, location: { ...prefs.location, acceptableLocations: ['Bengaluru', 'Bangalore', 'India'] } };
  const qs = common.buildQueries(p, { maxQueries: 6 });
  assert.equal(qs.length, 6);
  assert.ok(!qs.some((q) => q.location === 'Bangalore'), 'alias of Bengaluru skipped');
  assert.ok(qs.some((q) => q.remote));
  const tracksSeen = new Set(qs.map((q) => prefs.tracks.find((t) => t.titles.includes(q.term))?.id));
  assert.deepEqual([...tracksSeen].sort(), ['fde', 'fe']);
  assert.equal(new Set(qs.map((q) => `${q.term}|${q.location}|${q.remote}`)).size, 6, 'no duplicates');
  assert.equal(common.buildQueries(p, { maxQueries: 2 }).length, 2);
  assert.ok(common.buildQueries(p, { maxQueries: 50, trackId: 'fe' }).every((q) => prefs.tracks[0].titles.includes(q.term)));
  const all = common.buildQueries(p, { maxQueries: 1000 });
  const titles = prefs.tracks.flatMap((t) => t.titles).length;
  assert.equal(all.length, titles * 3, 'every title × (2 locations + remote)');
});

test('isOn accepts booleans and {enabled}', () => {
  assert.equal(common.isOn(true), true);
  assert.equal(common.isOn({ enabled: true }), true);
  assert.equal(common.isOn({ enabled: false }), false);
  assert.equal(common.isOn(undefined), false);
  assert.equal(common.relativeToISO('3 days ago', Date.parse('2026-10-17T00:00:00Z')), '2026-10-14T00:00:00.000Z');
  assert.equal(common.relativeToISO('an hour ago', Date.parse('2026-10-17T01:00:00Z')), '2026-10-17T00:00:00.000Z');
  assert.equal(common.relativeToISO('Full-time'), null);
});

// ---------- google jobs ----------
test('JSearch mapping: direct employer apply link, via publisher, salary, remote', () => {
  const [a, b] = gj.normalizeJSearch(json('jsearch.json'));
  assert.equal(a.source, 'google-jobs');
  assert.equal(a.via, 'LinkedIn');
  assert.equal(a.applyUrl, 'https://jobs.ashbyhq.com/ikuto/1b2c3d4e-0000-0000-0000-000000000001');
  assert.equal(a.url, 'https://www.linkedin.com/jobs/view/enterprise-solutions-engineer-api-4300000001');
  assert.deepEqual(a.salary, { min: 180000, max: 314000, currency: null, unit: 'year' });
  assert.equal(a.workMode, 'hybrid');
  assert.deepEqual(a.countries, ['US']);
  assert.equal(a.postedAt, '2026-09-14T00:00:00.000Z');
  assert.equal(b.workMode, 'remote');
  assert.equal(b.location, 'Remote (India)');
  assert.equal(b.applyUrl, 'https://www.naukri.com/job-listings-senior-frontend-engineer-acme-1', 'falls back to the only link');
  assert.equal(b.salary, null);
});

test('SerpAPI mapping: via, relative dates, non-aggregator apply link, salary text', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const [barista, fe] = gj.normalizeSerpApi(json('serpapi.json'), { now });
  assert.equal(barista.via, 'ZipRecruiter');
  assert.equal(barista.postedAt, '2026-09-22T00:00:00.000Z');
  assert.match(barista.applyUrl, /ziprecruiter/, 'only aggregators available');
  assert.equal(fe.via, 'LinkedIn');
  assert.equal(fe.applyUrl, 'https://boards.greenhouse.io/globex/jobs/123');
  assert.equal(fe.workMode, 'remote');
  assert.deepEqual(fe.salary, { min: 2500000, max: 4000000, currency: 'INR', unit: 'year' });
  assert.equal(fe.sourceId, 'eyJqb2JfdGl0bGUiOiJGRSJ9');
});

test('googleJobs: missing key skips with a one-line warning', async () => {
  const r = await gj.fetchJobs(withSources({ googleJobs: { enabled: true, provider: 'serpapi' } }), { getKey: () => null });
  assert.deepEqual(r.jobs, []);
  assert.match(r.warning, /no serpapi key/);
  assert.ok(!r.warning.includes('\n'));
});

test('googleJobs: usage line, 12h cache, keys never cached or in errors', async () => {
  const p = withSources({ googleJobs: { enabled: true, provider: 'serpapi', maxQueries: 2, country: 'in' } });
  let calls = 0;
  const request = async (q, cfg, key, onAttempt) => {
    onAttempt();
    calls++;
    assert.equal(key, SECRET);
    const payload = json('serpapi.json');
    payload.search_metadata.json_endpoint = `https://serpapi.com/searches/x.json?api_key=${key}`;
    payload.jobs_results[0].description += ` leaked ${key}`;
    return payload;
  };
  const r = await gj.fetchJobs(p, { getKey: () => SECRET, request });
  assert.equal(calls, 2);
  assert.equal(r.usage, 'google-jobs: 2 requests this run, 2/100 this month (serpapi)');
  assert.equal(r.jobs.length, 4);
  assert.ok(!cacheText().includes(SECRET), 'key not in cache files');
  const again = await gj.fetchJobs(p, { getKey: () => SECRET, request });
  assert.equal(calls, 2, 'served from cache');
  assert.equal(again.usage, 'google-jobs: 0 requests this run, 2/100 this month (serpapi), 2 cached');

  const p2 = withSources({ googleJobs: { enabled: true, provider: 'jsearch', maxQueries: 1, country: 'zz' } });
  const boom = async (q, cfg, key) => { throw new Error(`HTTP 403 for https://jsearch.p.rapidapi.com/search?query=x (key ${key})`); };
  await assert.rejects(gj.fetchJobs(p2, { getKey: () => SECRET, request: boom }), (err) => !err.message.includes(SECRET) || assert.fail(err.message));
});

test('redaction helpers', () => {
  assert.equal(redactUrl('https://serpapi.com/search.json?engine=google_jobs&api_key=abc123&q=x'), 'https://serpapi.com/search.json?engine=google_jobs&api_key=[redacted]&q=x');
  assert.equal(redact(`token ${SECRET} here`, [SECRET]), 'token [redacted] here');
  assert.ok(!new HttpError(401, `https://serpapi.com/search.json?api_key=${SECRET}`).message.includes(SECRET));
});

test('http request errors never include the key (header or query)', async () => {
  const { getJSON } = await import('../src/scrape/http.js');
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError(`fetch failed for key ${SECRET}`); };
    await assert.rejects(getJSON(`https://serpapi.com/search.json?api_key=${SECRET}`, { retries: 0, secrets: [SECRET] }), (err) => {
      assert.ok(!err.message.includes(SECRET), err.message);
      return true;
    });
    globalThis.fetch = async () => new Response('denied', { status: 401 });
    await assert.rejects(getJSON(`https://serpapi.com/search.json?api_key=${SECRET}`, { retries: 0 }), (err) => {
      assert.ok(!err.message.includes(SECRET), err.message);
      assert.equal(err.status, 401);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------- apify ----------
test('apify mapping is heuristic across actor shapes', () => {
  const jobs = apify.normalize(json('apify.json'), 'someone~indeed-scraper', { now: Date.parse('2026-10-17T00:00:00Z') });
  assert.equal(jobs.length, 2, 'row without company skipped');
  const [a, b] = jobs;
  assert.deepEqual([a.title, a.company, a.via, a.applyUrl], ['Frontend Developer', 'Initech', 'someone~indeed-scraper', 'https://initech.example/careers/fe']);
  assert.equal(a.postedAt, '2026-10-15T00:00:00.000Z');
  assert.deepEqual(a.salary, { min: 1200000, max: 1800000, currency: 'INR', unit: 'year' });
  assert.equal(b.description, 'Design systems.');
  assert.equal(b.workMode, 'remote');
  assert.equal(apify.actorPath('owner/actor-name'), 'owner~actor-name');
  assert.equal(apify.actorPath('../etc'), null);
});

test('apify refuses actors whose input carries cookies/passwords/li_at', async () => {
  assert.equal(apify.forbiddenInputKey({ startUrls: [], proxy: { useApifyProxy: true } }), null);
  assert.equal(apify.forbiddenInputKey({ Cookie: 'x' }), 'Cookie');
  assert.equal(apify.forbiddenInputKey({ auth: { li_at: 'x' } }), 'auth.li_at');
  assert.equal(apify.forbiddenInputKey({ linkedinPassword: 'x' }), 'linkedinPassword');
  const p = withSources({ apify: { enabled: true, actors: [{ id: 'evil~li-scraper', input: { cookies: [{ name: 'li_at' }] } }], maxItems: 10, maxChargeUsd: 0.2 } });
  let ran = false;
  await assert.rejects(apify.fetchJobs(p, { getKey: () => SECRET, run: async () => { ran = true; return []; } }), /refusing actor evil~li-scraper: its input has "cookies"/);
  assert.equal(ran, false);
});

test('apify run: Bearer token stays out of cache; usage reports runs/items/cap', async () => {
  const p = withSources({ apify: { enabled: true, actors: [{ id: 'someone~indeed-scraper', input: { position: 'frontend', country: 'IN' } }], maxItems: 10, maxChargeUsd: 0.31 } });
  let seen;
  const run = async (actor, cfg, token, { onAttempt }) => { onAttempt(); seen = { actor, cfg, token }; return [...json('apify.json'), { title: 'T', company: 'C', url: 'https://c.example', note: token }]; };
  const r = await apify.fetchJobs(p, { getKey: () => SECRET, run });
  assert.equal(seen.actor, 'someone~indeed-scraper');
  assert.equal(seen.cfg.maxItems, 10);
  assert.equal(r.usage, 'apify: 1 run, 4 items, cap $0.31/actor/run, ~$0.31/$5 budget used this month (caps, not actual charges)');
  assert.ok(!cacheText().includes(SECRET));
  const none = await apify.fetchJobs(p, { getKey: () => null });
  assert.match(none.warning, /no APIFY_TOKEN/);
});

// ---------- jobspy ----------
test('jobspy mapping from real runner output', () => {
  const jobs = jobspy.normalize(json('jobspy.json'));
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].source, 'jobspy');
  assert.equal(jobs[0].via, 'indeed');
  assert.match(jobs[0].url, /^https:\/\/in\.indeed\.com\/viewjob/);
  const remote = jobs.find((j) => j.workMode === 'remote' && j.via === 'indeed');
  assert.ok(remote);
  const naukri = jobs.find((j) => j.via === 'naukri');
  assert.deepEqual(naukri.salary, { min: 1800000, max: 2500000, currency: 'INR', unit: 'year' });
});

test('jobspy: missing uv skips with install hint; runner args', async () => {
  const p = withSources({ jobspy: { enabled: true, sites: ['indeed', 'naukri', 'myspace'], resultsWanted: 5, hoursOld: 72, maxQueries: 1 } });
  const skipped = await jobspy.fetchJobs(p, { hasUv: () => false });
  assert.match(skipped.warning, /brew install uv/);
  let args;
  const r = await jobspy.fetchJobs(p, { hasUv: () => true, run: async (a) => { args = a; return json('jobspy.json'); } });
  assert.deepEqual(args.sites, ['indeed', 'naukri']);
  assert.equal(args.country_indeed, 'india');
  assert.equal(args.results_wanted, 5);
  assert.equal(args.hours_old, 72);
  assert.equal(r.jobs.length, 3);
  assert.match(r.usage, /^jobspy: 1 run \(indeed, naukri\)$/);
});

// ---------- jobs:import ----------
test('importJobs validates, canonicalises LinkedIn URLs, dedupes', () => {
  const r = importJobs(json('import.json'), { source: 'manual' });
  assert.equal(r.jobs.length, 3);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.errors.map((e) => e.index), [4, 5, 6, 7, 8]);
  assert.match(r.errors.find((e) => e.index === 6).error, /http/);
  const [li, fde] = r.jobs;
  assert.equal(li.url, 'https://www.linkedin.com/jobs/view/4300000009/');
  assert.equal(li.via, 'LinkedIn');
  assert.equal(li.source, 'manual');
  const alert = importJobs(json('import.json'), { source: 'linkedin-alert' });
  assert.equal(alert.jobs.length, 1, 'linkedin-alert keeps only linkedin.com URLs');
  assert.ok(alert.errors.some((e) => e.index === 2 && /linkedin\.com/.test(e.error)));
  assert.equal(fde.workMode, 'remote');
  assert.deepEqual(fde.salary, { min: 90000, max: 120000, currency: 'USD', unit: 'year' });
  assert.equal(canonicalJobUrl('https://www.linkedin.com/jobs/search/?currentJobId=123456789'), 'https://www.linkedin.com/jobs/view/123456789/');
  assert.throws(() => importJobs([], { source: 'scraped' }), /--source/);
  assert.throws(() => importJobs({ nope: 1 }), /array/);
});

test('gaj jobs:import end to end (temp root)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-import-'));
  try {
    fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(root, 'profile', 'preferences.json'), JSON.stringify(prefs));
    const run = (...args) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'gaj.js'), ...args], { env: { ...process.env, GAJ_ROOT: root }, encoding: 'utf8' });
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const file = path.join(root, 'data', 'import.json');
    fs.copyFileSync(path.join(FIX, 'import.json'), file);
    const r = run('jobs:import', file, '--source', 'manual', '--json');
    assert.equal(r.status, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.equal(s.new, 3);
    assert.equal(s.invalid.length, 5);
    assert.equal(s.noTrack, 1, 'Barista kept without a track');
    const store = JSON.parse(fs.readFileSync(path.join(root, 'data', 'jobs.json'), 'utf8'));
    const li = Object.values(store.jobs).find((j) => j.source === 'manual' && j.company === 'Globex');
    assert.equal(li.eligibility, 'green');
    assert.equal(li.track, 'fe');
    const again = JSON.parse(run('jobs:import', file, '--source', 'manual', '--json').stdout);
    assert.deepEqual([again.new, again.updated], [0, 3]);
    assert.equal(run('jobs:import', file, '--source', 'nope').status, 1);
    // outside data/ and the temp dir: refused
    const outside = run('jobs:import', path.join(FIX, 'import.json'));
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /only reads files under data\/ or the OS temp dir/);
    // parse errors never echo file contents
    fs.writeFileSync(path.join(root, 'data', 'bad.json'), 'SECRET-CONTENT-123 {');
    const bad = run('jobs:import', path.join(root, 'data', 'bad.json'));
    assert.equal(bad.status, 1);
    assert.ok(!bad.stderr.includes('SECRET-CONTENT-123'), bad.stderr);
    assert.match(bad.stderr, /bad\.json is not valid JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- cross-source dedupe + expiry ----------
test('aggregated jobs fold into an existing ATS record (alsoSeenOn) instead of duplicating', () => {
  const ats = { ...makeJob({ title: 'Senior Frontend Engineer', company: 'Acme Robotics', location: 'Bengaluru, India', source: 'greenhouse', sourceId: '1', url: 'https://boards.greenhouse.io/acme/jobs/1' }), track: 'fe', eligibility: 'green', eligibilityReason: 'x' };
  const g = { ...makeJob({ title: 'Senior Front-End Engineer', company: 'Acme Robotics Pvt Ltd', location: 'India', source: 'google-jobs', sourceId: 'g1', url: 'https://www.linkedin.com/jobs/view/1' }), via: 'LinkedIn', track: 'fe', eligibility: 'green', eligibilityReason: 'x' };
  const js = { ...g, key: 'other-key', source: 'jobspy', sourceId: 'j1', via: 'naukri' };
  assert.equal(identityOf(ats), identityOf(g));
  // same batch: ATS first even if listed after
  let { store, stats } = mergeJobs({ version: 1, jobs: {} }, [g, ats, js], { now: '2026-10-17T00:00:00Z' });
  assert.equal(Object.keys(store.jobs).length, 1);
  assert.deepEqual(store.jobs[ats.key].alsoSeenOn, ['google-jobs', 'jobspy']);
  assert.equal(stats.crossSource, 2);
  assert.equal(store.jobs[ats.key].source, 'greenhouse');
  // later run: google job alone still folds in
  ({ store, stats } = mergeJobs(store, [g], { now: '2026-10-18T00:00:00Z' }));
  assert.equal(Object.keys(store.jobs).length, 1);
  // a different role is added normally
  const other = { ...g, title: 'Data Scientist', key: 'acme--ds--1', sourceId: 'g2' };
  ({ store } = mergeJobs(store, [other], { now: '2026-10-18T00:00:00Z' }));
  assert.equal(store.jobs['acme--ds--1'].source, 'google-jobs');
  assert.equal(store.jobs['acme--ds--1'].via, 'LinkedIn');
});

test('provider and imported jobs expire after boardExpireDays without being seen', () => {
  for (const source of ['google-jobs', 'apify', 'jobspy', 'linkedin-alert', 'manual']) {
    const j = { ...makeJob({ title: 'UI Engineer', company: `Co ${source}`, location: 'Remote', source, sourceId: source, url: 'https://x.example' }) };
    let { store } = mergeJobs({ version: 1, jobs: {} }, [j], { now: '2026-10-01T00:00:00Z' });
    ({ store } = mergeJobs(store, [], { now: '2026-11-15T00:00:00Z', boardExpireDays: 28 }));
    assert.equal(store.jobs[j.key].status, 'expired', source);
  }
});

// ---------- careers integration (stubbed crawler) ----------
test('careers entries: validation needs https url; company:check uses the careers:check record, never crawls', async () => {
  const { recordCareersCheck } = await import('../src/scrape/careersChecks.js');
  assert.match(validateCompany({ name: 'Acme', ats: 'careers', slug: 'acme' }).error, /--url/);
  assert.match(validateCompany({ name: 'Acme', ats: 'careers', slug: 'acme', url: 'http://acme.example/careers' }).error, /https/);
  assert.deepEqual(validateCompany({ name: 'Acme', ats: 'careers', slug: 'acme', url: 'https://acme.example/careers' }).entry,
    { name: 'Acme', ats: 'careers', slug: 'acme', url: 'https://acme.example/careers' });
  let crawled = false;
  const careers = { checkCareers: async () => { crawled = true; return { ok: true, jobs: 4 }; } };
  const missing = await checkCompany('careers', 'acme', { sources: { careers }, url: 'https://acme.example/careers' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /run careers:check https:\/\/acme\.example\/careers first/);
  recordCareersCheck('https://acme.example/careers', { jobs: 4, method: 'jsonld' });
  const r = await checkCompany('careers', 'acme', { sources: { careers }, url: 'https://acme.example/careers' });
  assert.deepEqual([r.ok, r.jobs, r.method], [true, 4, 'jsonld']);
  assert.equal(crawled, false, 'never crawls');
  recordCareersCheck('https://old.example/careers', { jobs: 2 }, Date.now() - 8 * 86400e3);
  assert.equal((await checkCompany('careers', 'old', { url: 'https://old.example/careers' })).ok, false, 'older than 7 days');
});
