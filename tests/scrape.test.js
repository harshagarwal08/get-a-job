import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { htmlToText, decodeEntities } from '../src/scrape/text.js';
import { detectCountries, detectWorkMode, detectRegions } from '../src/scrape/geo.js';
import * as greenhouse from '../src/scrape/sources/greenhouse.js';
import * as lever from '../src/scrape/sources/lever.js';
import * as ashby from '../src/scrape/sources/ashby.js';
import * as workable from '../src/scrape/sources/workable.js';
import * as linkedin from '../src/scrape/sources/linkedin.js';
import { matchTrack, eligibility, classify, offersSponsorship } from '../src/scrape/filter.js';
import { consolidate, mergeJobs } from '../src/scrape/merge.js';
import { parseRobots, isAllowed } from '../src/scrape/robots.js';
import { recognizeUrl, hostClass } from '../src/scrape/urls.js';
import { parseGenericPage } from '../src/scrape/generic.js';
import { makeJob } from '../src/scrape/job.js';
import { isPrivateAddress, assertPublicHost, safeGet } from '../src/scrape/safeFetch.js';
import { validateRank, verdictFor, checkCompany } from '../src/scrape/cli.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scrape');
const json = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const text = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const prefs = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', 'examples', 'preferences.example.json'), 'utf8'));
const ACME = { name: 'Acme', slug: 'acme' };

// ---------- text ----------
test('htmlToText keeps paragraphs and list items, decodes entities', () => {
  const t = htmlToText('<h2>Role</h2><p>Build &amp; ship&nbsp;UI.</p><ul><li>React</li><li>TS &#8211; strict</li></ul><p>Bye<br>now</p>');
  assert.equal(t, 'Role\n\nBuild & ship UI.\n\n- React\n- TS – strict\n\nBye\nnow');
});

test('htmlToText handles entity-encoded HTML and strips scripts', () => {
  assert.equal(htmlToText('&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;'), 'Hi & bye');
  assert.equal(htmlToText('<script>alert(1)</script><style>p{}</style><p>ok</p>'), 'ok');
  assert.equal(decodeEntities('&#x20B9;5 &rsquo;s &unknown;'), '₹5 ’s &unknown;');
});

// ---------- geo ----------
test('detectCountries / regions / workMode', () => {
  assert.deepEqual(detectCountries('Bengaluru, Karnataka, India'), ['IN']);
  assert.deepEqual(detectCountries('Remote - US'), ['US']);
  assert.deepEqual(detectCountries('San Francisco, CA'), ['US']);
  assert.deepEqual(detectCountries('Chennai, TN, India'), ['IN']);
  assert.deepEqual(detectCountries('London, UK'), ['GB']);
  assert.deepEqual(detectCountries('Internal tools'), []);
  assert.deepEqual(detectRegions('Remote (APAC)'), ['apac']);
  assert.deepEqual(detectRegions('Anywhere in the world'), ['global']);
  assert.equal(detectWorkMode('OnSite', 'Remote'), 'onsite');
  assert.equal(detectWorkMode(null, 'Hybrid - London'), 'hybrid');
  assert.equal(detectWorkMode(null, 'Remote - India'), 'remote');
  assert.equal(detectWorkMode('unspecified', 'Pune'), 'unknown');
});

// ---------- sources ----------
test('greenhouse normalize', () => {
  const jobs = greenhouse.normalize(json('greenhouse.json'), ACME);
  assert.equal(jobs.length, 3);
  const [a, b] = jobs;
  assert.equal(a.title, 'Senior Frontend Engineer');
  assert.equal(a.source, 'greenhouse');
  assert.deepEqual(a.countries, ['IN']);
  assert.equal(a.department, 'Engineering');
  assert.equal(a.postedAt, '2026-10-10T13:00:00.000Z');
  assert.match(a.description, /About Acme\n\nWe build payments & cards\.\n\n- React & TypeScript\n- Design systems/);
  assert.match(a.key, /^acme--senior-frontend-engineer--[0-9a-f]{6}$/);
  assert.equal(b.location, 'San Francisco, CA (+1 location)');
  assert.deepEqual(b.locations, ['San Francisco, CA', 'New York, NY']);
  assert.deepEqual(b.salary, { min: 180000, max: 240000, currency: 'USD', unit: 'year' });
});

test('lever normalize', () => {
  const [fde, ap] = lever.normalize(json('lever.json'), ACME);
  assert.equal(fde.title, 'Forward Deployed Engineer');
  assert.equal(fde.workMode, 'hybrid');
  assert.deepEqual(fde.countries, ['IN']);
  assert.deepEqual(fde.salary, { min: 3000000, max: 4500000, currency: 'INR', unit: 'year' });
  assert.match(fde.description, /Work directly with customers\.\n\nWhat you'll do\n- Ship integrations\n- Own LLM deployments\n\nWe offer relocation support\./);
  assert.equal(fde.department, 'Solutions');
  assert.equal(ap.workMode, 'unknown');
  assert.equal(ap.salary, null);
});

test('ashby normalize: compensation, unlisted skipped, structured work mode', () => {
  const jobs = ashby.normalize(json('ashby.json'), ACME);
  assert.equal(jobs.length, 2);
  const [fe, fde] = jobs;
  assert.equal(fe.workMode, 'remote');
  assert.deepEqual(fe.salary, { min: 60000, max: 90000, currency: 'USD', unit: 'year' });
  assert.equal(fe.description, 'Acme builds voice AI.\n\n- React\n- Next.js');
  assert.equal(fde.workMode, 'onsite');
  assert.deepEqual(fde.countries, ['US']);
  assert.deepEqual(fde.locations, ['New York', 'San Francisco']);
});

test('workable normalize', () => {
  const [j] = workable.normalize(json('workable.json'), ACME);
  assert.equal(j.location, 'Paris, Île-de-France, France');
  assert.deepEqual(j.countries, ['FR']);
  assert.equal(j.workMode, 'remote');
  assert.equal(j.postedAt, '2026-10-09T00:00:00.000Z');
  assert.equal(j.description, 'Join our open-source team.');
});

test('linkedin search parse skips broken cards', () => {
  const jobs = linkedin.normalize(text('linkedin-search.html'));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].company, 'Acme & Co');
  assert.equal(jobs[0].url, 'https://www.linkedin.com/jobs/view/4477982333/');
  assert.equal(jobs[0].sourceId, '4477982333');
  assert.equal(jobs[1].workMode, 'remote');
  assert.deepEqual(jobs[1].countries, ['IN']);
});

test('linkedin posting parse', () => {
  const p = linkedin.parsePosting(text('linkedin-posting.html'));
  assert.equal(p.title, 'Frontend Engineer');
  assert.equal(p.company, 'Acme & Co');
  assert.equal(p.location, 'Bengaluru, Karnataka, India');
  assert.equal(p.description, 'About the role\n\nBuild UI.\n\n- React\n- TypeScript');
  assert.deepEqual(p.criteria, ['Mid-Senior level', 'Full-time']);
});

test('generic page prefers JSON-LD JobPosting', () => {
  const p = parseGenericPage(text('generic-jsonld.html'));
  assert.equal(p.title, 'Frontend Engineer');
  assert.equal(p.company, 'Initech');
  assert.equal(p.location, 'Pune, IN');
  assert.equal(p.text, 'Build dashboards.\n\n- Vue');
  const plain = parseGenericPage('<html><head><title>X</title></head><body><nav>menu</nav><main><p>JD here</p></main></body></html>');
  assert.deepEqual(plain, { title: 'X', company: null, location: null, text: 'JD here' });
});

// ---------- filter ----------
test('matchTrack is token-aware and honours excludeTitles', () => {
  const t = prefs.tracks;
  assert.equal(matchTrack('Senior Front-End Engineer', t), 'fe');
  assert.equal(matchTrack('Software Engineer - Frontend (React)', t), 'fe');
  assert.equal(matchTrack('Frontend Engineer Intern', t), null);
  assert.equal(matchTrack('Internal Tools Frontend Engineer', t), 'fe'); // "Intern" != "Internal"
  assert.equal(matchTrack('Engineering Manager, Frontend', t), null);
  assert.equal(matchTrack('Forward Deployed Engineer, APAC', t), 'fde');
  assert.equal(matchTrack('Backend Engineer', t), null);
  assert.equal(matchTrack('Legal Engineer, Custom Solutions', t), null);
  assert.equal(matchTrack('Frontend Software Engineer', t), 'fe');
});

const job = (location, extra = {}) => {
  const j = makeJob({ title: 'Frontend Engineer', company: 'Acme', location, source: 'greenhouse', ...extra });
  return { ...j, ...extra };
};
const elig = (location, extra, p = prefs) => eligibility(job(location, extra), p);

test('eligibility: green cases', () => {
  for (const loc of ['Bengaluru, India', 'Bangalore', 'Remote - India', 'Remote (APAC)', 'Anywhere', 'Remote - Worldwide', 'Hybrid - Pune, India']) {
    const e = elig(loc);
    assert.equal(e.eligibility, 'green', `${loc}: ${e.eligibilityReason}`);
    assert.ok(e.eligibilityReason.length > 10);
  }
  assert.match(elig('Remote (APAC)').eligibilityReason, /APAC/);
});

test('eligibility: orange cases', () => {
  for (const loc of ['Remote - US', 'San Francisco, CA', 'London, UK', 'Remote - EMEA', 'Berlin, Germany']) {
    assert.equal(elig(loc).eligibility, 'orange', loc);
  }
  assert.match(elig('Remote - US').eligibilityReason, /limited to US/);
});

test('eligibility: unknown cases', () => {
  assert.equal(elig('Remote').eligibility, 'unknown');
  assert.equal(elig('').eligibility, 'unknown');
  assert.equal(elig('HQ').eligibility, 'unknown');
});

test('eligibility: sponsorship path turns orange into green only when needed', () => {
  const p = { ...prefs, location: { ...prefs.location, needsSponsorship: true } };
  assert.equal(elig('London, UK', { description: 'We offer visa sponsorship.' }, p).eligibility, 'green');
  assert.equal(elig('London, UK', { description: 'We are unable to sponsor visas.' }, p).eligibility, 'orange');
  assert.equal(elig('London, UK', { description: 'We offer visa sponsorship.' }).eligibility, 'orange');
  assert.equal(offersSponsorship('We do not offer visa sponsorship'), false);
});

test('eligibility: work authorization counts as green', () => {
  const p = { ...prefs, location: { ...prefs.location, workAuthorization: ['IN', 'GB'] } };
  assert.equal(elig('London, UK', {}, p).eligibility, 'green');
});

test('classify: title, track, age, work mode', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const fresh = job('Bengaluru', { postedAt: '2026-10-15T00:00:00Z', workMode: 'hybrid' });
  assert.deepEqual(classify(fresh, prefs, { now }), { keep: true, track: 'fe' });
  assert.equal(classify({ ...fresh, title: 'Data Scientist' }, prefs, { now }).reason, 'title');
  assert.equal(classify(fresh, prefs, { now, trackId: 'fde' }).reason, 'track');
  assert.equal(classify({ ...fresh, postedAt: '2026-09-01T00:00:00Z' }, prefs, { now }).reason, 'age');
  assert.equal(classify({ ...fresh, postedAt: '2026-09-01T00:00:00Z' }, prefs, { now, days: 60 }).keep, true);
  assert.equal(classify({ ...fresh, postedAt: null }, prefs, { now }).keep, true);
  const remoteOnly = { ...prefs, location: { ...prefs.location, workModes: ['remote'] } };
  assert.equal(classify(fresh, remoteOnly, { now }).reason, 'workMode');
});

// ---------- merge ----------
test('consolidate collapses multi-country duplicates', () => {
  const mk = (location, postedAt) => makeJob({ title: 'Frontend Engineer', company: 'Acme', location, source: 'greenhouse', postedAt, sourceId: location });
  const out = consolidate([
    mk('London, UK', '2026-10-01'), mk('Bengaluru, India', '2026-10-02'),
    mk('Berlin, Germany', '2026-10-05'), mk('Remote - US', '2026-10-03'),
    makeJob({ title: 'Backend Engineer', company: 'Acme', location: 'London, UK', source: 'greenhouse' }),
  ], prefs);
  assert.equal(out.length, 2);
  const fe = out.find((j) => j.title === 'Frontend Engineer');
  assert.equal(fe.location, 'Bengaluru, India (+3 locations)');
  assert.deepEqual(fe.countries.sort(), ['DE', 'GB', 'IN', 'US']);
  assert.equal(fe.eligibility, 'green');
  assert.match(fe.eligibilityReason, /\(best of 4 locations\)$/);
  assert.equal(fe.postedAt, '2026-10-05T00:00:00.000Z');
  const again = consolidate([mk('Berlin, Germany'), mk('Bengaluru, India'), mk('London, UK'), mk('Remote - US')], prefs);
  assert.equal(again.find((j) => j.title === 'Frontend Engineer').key, fe.key, 'key is stable regardless of order');
  assert.equal(out.find((j) => j.title === 'Backend Engineer').eligibility, 'orange');
});

test('mergeJobs keeps user fields, refreshes data, expires after 2 misses', () => {
  const a = { ...job('Bengaluru'), key: 'acme--fe--aaaaaa', description: 'v1', salary: null, track: 'fe', eligibility: 'green', eligibilityReason: 'x' };
  const b = { ...a, key: 'acme--fe2--bbbbbb' };
  const scraped = (keys) => [{ company: 'Acme', source: 'greenhouse', seenKeys: new Set(keys) }];

  let { store, stats } = mergeJobs({ version: 1, jobs: {} }, [a, b], { now: 't1', scraped: scraped([a.key, b.key]) });
  assert.equal(stats.new, 2);
  assert.equal(store.jobs[a.key].status, 'new');
  assert.equal(store.jobs[a.key].firstSeen, 't1');

  store.jobs[a.key] = { ...store.jobs[a.key], status: 'ranked', quickFit: 'high', rank: { score: 80, verdict: 'Strong' } };
  ({ store, stats } = mergeJobs(store, [{ ...a, description: 'v2', salary: { min: 1, max: 2, currency: 'INR', unit: 'year' } }], { now: 't2', scraped: scraped([a.key]) }));
  const ja = store.jobs[a.key];
  assert.equal(stats.updated, 1);
  assert.deepEqual([ja.firstSeen, ja.lastSeen, ja.status, ja.quickFit, ja.rank.score, ja.description, ja.salary.max], ['t1', 't2', 'ranked', 'high', 80, 'v2', 2]);
  assert.equal(store.jobs[b.key].missCount, 1);
  assert.equal(store.jobs[b.key].status, 'new');

  ({ store, stats } = mergeJobs(store, [a], { now: 't3', scraped: scraped([a.key]) }));
  assert.equal(store.jobs[b.key].status, 'expired');
  assert.equal(stats.expired, 1);

  // a company that failed (not in `scraped`) never expires anything
  ({ store } = mergeJobs(store, [], { now: 't4', scraped: [] }));
  assert.equal(store.jobs[a.key].status, 'ranked');

  // seen in feed but filtered out (e.g. too old): not a miss
  ({ store } = mergeJobs(store, [], { now: 't5', scraped: scraped([a.key]) }));
  ({ store } = mergeJobs(store, [], { now: 't6', scraped: scraped([a.key]) }));
  assert.equal(store.jobs[a.key].status, 'ranked');
  assert.equal(store.jobs[a.key].lastSeen, 't6');

  // expired job that reappears comes back as new
  ({ store } = mergeJobs(store, [b], { now: 't7', scraped: scraped([a.key, b.key]) }));
  assert.equal(store.jobs[b.key].status, 'new');
  assert.equal(store.jobs[b.key].missCount, 0);
});

// ---------- robots ----------
test('robots parser: groups, longest match, allow wins ties, wildcards', () => {
  const rules = parseRobots(`
User-agent: Googlebot
Disallow: /

User-agent: *
User-agent: other
Disallow: /private
Allow: /private/jobs
Disallow: /*.pdf$
Disallow:
`);
  assert.equal(isAllowed(rules, '/careers/123'), true);
  assert.equal(isAllowed(rules, '/private/x'), false);
  assert.equal(isAllowed(rules, '/private/jobs/1'), true);
  assert.equal(isAllowed(rules, '/files/jd.pdf'), false);
  assert.equal(isAllowed(rules, '/files/jd.pdf?x=1'), true);
  assert.equal(isAllowed(parseRobots('User-agent: get-a-job-cli\nDisallow: /\n\nUser-agent: *\nAllow: /'), '/a'), false);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a'), '/a'), true);
  assert.equal(isAllowed(parseRobots(''), '/x'), true);
});

// ---------- urls ----------
test('recognizeUrl and hostClass', () => {
  assert.deepEqual(recognizeUrl('https://boards.greenhouse.io/acme/jobs/123?gh_src=x'), { source: 'greenhouse', slug: 'acme', id: '123' });
  assert.deepEqual(recognizeUrl('https://job-boards.eu.greenhouse.io/groww/jobs/4970739101'), { source: 'greenhouse', slug: 'groww', id: '4970739101' });
  assert.deepEqual(recognizeUrl('https://jobs.lever.co/cred/aa98-bb/apply'), { source: 'lever', slug: 'cred', id: 'aa98-bb' });
  assert.deepEqual(recognizeUrl('https://jobs.ashbyhq.com/vapi/d270d613-30b8-4fdc-96e0-514993ca7a82'), { source: 'ashby', slug: 'vapi', id: 'd270d613-30b8-4fdc-96e0-514993ca7a82' });
  assert.deepEqual(recognizeUrl('https://apply.workable.com/huggingface/j/81B46579FE/'), { source: 'workable', slug: 'huggingface', id: '81B46579FE' });
  assert.deepEqual(recognizeUrl('https://www.linkedin.com/jobs/view/frontend-engineer-at-acme-4477982333/'), { source: 'linkedin', id: '4477982333' });
  assert.deepEqual(recognizeUrl('https://in.linkedin.com/jobs/view/4477982333'), { source: 'linkedin', id: '4477982333' });
  assert.deepEqual(recognizeUrl('https://www.linkedin.com/jobs/search/?currentJobId=4477982333'), { source: 'linkedin', id: '4477982333' });
  assert.equal(recognizeUrl('https://jobs.lever.co/cred'), null);
  assert.equal(recognizeUrl('https://example.com/careers/1'), null);
  assert.equal(recognizeUrl('not a url'), null);
  assert.equal(hostClass('https://jobs.lever.co/x/y'), 'ats');
  assert.equal(hostClass('https://acme.wd5.myworkdayjobs.com/x'), 'ats');
  assert.equal(hostClass('https://www.linkedin.com/jobs/view/1'), 'linkedin');
  assert.equal(hostClass('https://acme.com/careers'), 'unknown');
});

// ---------- review follow-ups ----------

test('isPrivateAddress covers v4/v6 private ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd12:3456::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '104.16.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

const fakeLookup = (table) => async (host) => (table[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

test('assertPublicHost checks every resolved address', async () => {
  await assertPublicHost('ok.example', fakeLookup({ 'ok.example': ['93.184.216.34'] }));
  await assert.rejects(assertPublicHost('mixed.example', fakeLookup({ 'mixed.example': ['93.184.216.34', '10.0.0.1'] })), /private or local/);
  await assert.rejects(assertPublicHost('localhost'), /local/);
  await assert.rejects(assertPublicHost('nx.example', fakeLookup({})), /cannot resolve/);
});

test('safeGet re-checks host and robots after each redirect, caps body', async () => {
  const lookup = fakeLookup({ 'a.example': ['93.184.216.34'], 'b.example': ['93.184.216.35'], 'evil.example': ['192.168.0.10'] });
  const routes = {
    'https://a.example/job': () => new Response(null, { status: 302, headers: { location: 'https://b.example/job' } }),
    'https://b.example/job': () => new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } }),
    'https://a.example/bad': () => new Response(null, { status: 301, headers: { location: 'http://evil.example/x' } }),
    'https://a.example/loop': () => new Response(null, { status: 302, headers: { location: '/loop' } }),
    'https://a.example/big': () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(97)); c.close(); },
    })),
  };
  const fetchImpl = async (url) => routes[url]();
  const robotsSeen = [];
  const robots = async (u) => { robotsSeen.push(new URL(u).host); return true; };

  const ok = await safeGet('https://a.example/job', { lookup, fetchImpl, robots });
  assert.equal(ok.text, '<p>hi</p>');
  assert.equal(ok.url, 'https://b.example/job');
  assert.deepEqual(robotsSeen, ['a.example', 'b.example']);
  await assert.rejects(safeGet('https://a.example/bad', { lookup, fetchImpl }), /private or local/);
  await assert.rejects(safeGet('https://a.example/loop', { lookup, fetchImpl }), /too many redirects/);
  await assert.rejects(safeGet('https://a.example/job', { lookup, fetchImpl, robots: async () => false }), /robots\.txt/);
  await assert.rejects(safeGet('file:///etc/passwd', { lookup, fetchImpl }), /refusing/);
  const big = await safeGet('https://a.example/big', { lookup, fetchImpl });
  assert.equal(big.text.length, 5 * 1024 * 1024);
  assert.equal(big.truncated, true);
});

test('makeJob drops non-http(s) URLs', () => {
  const j = makeJob({ title: 'T', company: 'C', source: 'manual', url: 'javascript:alert(1)', applyUrl: 'https://ok.example/apply' });
  assert.equal(j.url, null);
  assert.equal(j.applyUrl, 'https://ok.example/apply');
  assert.equal(makeJob({ title: 'T', company: 'C', source: 'manual', url: 'not a url' }).url, null);
});

test('classify --days 0 means today only', () => {
  const now = new Date('2026-10-17T15:00:00Z');
  const j = job('Bengaluru', { workMode: 'hybrid' });
  assert.equal(classify({ ...j, postedAt: '2026-10-17T01:00:00Z' }, prefs, { now, days: 0 }).keep, true);
  assert.equal(classify({ ...j, postedAt: '2026-10-16T23:00:00Z' }, prefs, { now, days: 0 }).reason, 'age');
});

const goodRank = () => ({
  score: 71, verdict: 'Good', dimensions: { technical: 80, experience: 70, culture: 60, career: 75 },
  gates: { eligibility: 'pass', compensation: 'unknown', notice: 'flag' }, strengths: ['a'], gaps: ['b'], note: 'n',
});

test('validateRank is strict', () => {
  assert.equal(validateRank(goodRank()), null);
  assert.deepEqual([80, 75, 74, 60, 59, 45, 44, 30, 29, 0].map(verdictFor),
    ['Strong', 'Strong', 'Good', 'Good', 'Moderate', 'Moderate', 'Weak', 'Weak', 'Poor', 'Poor']);
  const bad = (patch, re) => assert.match(validateRank({ ...goodRank(), ...patch }) ?? '', re);
  bad({ verdict: 'Strong' }, /expected "Good"/);
  bad({ score: 101 }, /score/);
  bad({ dimensions: { technical: 80, experience: 70, culture: 60 } }, /dimensions\.career/);
  bad({ dimensions: { technical: '80', experience: 70, culture: 60, career: 1 } }, /dimensions\.technical/);
  bad({ gates: { eligibility: 'maybe', compensation: 'pass', notice: 'pass' } }, /gates\.eligibility/);
  bad({ gates: { eligibility: 'pass', compensation: 'pass', notice: 'fail' } }, /gates\.notice/);
  bad({ strengths: 'React' }, /strengths/);
  bad({ gaps: [1] }, /gaps/);
  assert.match(validateRank([]), /object/);
});

test('checkCompany reports ok/jobs/sample and failures', async () => {
  const sources = {
    lever: { fetchJobs: async () => [{ title: 'A' }, { title: 'B' }, { title: 'A' }] },
    ashby: { fetchJobs: async () => { const e = new Error('HTTP 404'); e.status = 404; throw e; } },
  };
  assert.deepEqual(await checkCompany('lever', 'acme', { sources }), { ok: true, ats: 'lever', slug: 'acme', jobs: 3, sample: ['A', 'B'] });
  const r = await checkCompany('ashby', 'nope', { sources });
  assert.equal(r.ok, false);
  assert.match(r.error, /no ashby board named "nope"/);
});

test('mergeJobs: key drift carries user fields and records aliases', () => {
  const scraped = (keys) => [{ company: 'Acme', source: 'greenhouse', seenKeys: new Set(keys) }];
  const v1 = { ...job('Bengaluru'), key: 'acme--fe--old111', sourceId: '42', source: 'greenhouse', track: 'fe' };
  let { store } = mergeJobs({ version: 1, jobs: {} }, [v1], { now: '2026-10-01T00:00:00Z', scraped: scraped([v1.key]) });
  store.jobs[v1.key] = { ...store.jobs[v1.key], status: 'ranked', quickFit: 'high', rank: { score: 80, verdict: 'Strong' } };
  const v2 = { ...v1, key: 'acme--fe--new222', location: 'Bengaluru (+1 location)' };
  const res = mergeJobs(store, [v2], { now: '2026-10-02T00:00:00Z', scraped: scraped([v2.key]) });
  ({ store } = res);
  assert.equal(store.jobs[v1.key], undefined);
  const n = store.jobs[v2.key];
  assert.deepEqual([n.status, n.quickFit, n.rank.score, n.firstSeen, n.aliases], ['ranked', 'high', 80, '2026-10-01T00:00:00Z', ['acme--fe--old111']]);
  assert.equal(res.stats.new, 0);
  const v3 = { ...v1, key: 'acme--fe--new333' };
  ({ store } = mergeJobs(store, [v3], { now: '2026-10-03T00:00:00Z', scraped: scraped([v3.key]) }));
  assert.deepEqual(store.jobs[v3.key].aliases, ['acme--fe--old111', 'acme--fe--new222']);
});

test('mergeJobs: new jobs that no longer match become skipped; ranked untouched', () => {
  const a = { ...job('Bengaluru'), key: 'k-a', sourceId: 'a' };
  const b = { ...job('Bengaluru'), key: 'k-b', sourceId: 'b' };
  const scraped = [{ company: 'Acme', source: 'greenhouse', seenKeys: new Set(['k-a', 'k-b']) }];
  let { store } = mergeJobs({ version: 1, jobs: {} }, [a, b], { now: '2026-10-01T00:00:00Z', scraped });
  store.jobs['k-b'].status = 'ranked';
  const res = mergeJobs(store, [], { now: '2026-10-02T00:00:00Z', scraped, noLongerMatching: new Set(['k-a', 'k-b']) });
  assert.equal(res.store.jobs['k-a'].status, 'skipped');
  assert.equal(res.store.jobs['k-a'].skipReason, 'no longer matches preferences');
  assert.equal(res.store.jobs['k-b'].status, 'ranked');
  assert.equal(res.stats.skipped, 1);
});

test('mergeJobs: LinkedIn jobs expire after linkedinExpireDays without being seen', () => {
  const li = { ...job('Bengaluru'), key: 'li-1', source: 'linkedin', sourceId: '1' };
  let { store } = mergeJobs({ version: 1, jobs: {} }, [li], { now: '2026-09-01T00:00:00Z' });
  ({ store } = mergeJobs(store, [], { now: '2026-09-20T00:00:00Z', linkedinExpireDays: 28 }));
  assert.equal(store.jobs['li-1'].status, 'new');
  const res = mergeJobs(store, [], { now: '2026-10-01T00:00:00Z', linkedinExpireDays: 28 });
  assert.equal(res.store.jobs['li-1'].status, 'expired');
  assert.equal(res.stats.expired, 1);
});
