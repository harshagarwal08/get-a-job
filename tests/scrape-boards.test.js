import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// paths.js reads GAJ_ROOT at import time: set it before any dynamic import.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-boards-'));
process.env.GAJ_ROOT = ROOT;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'scrape');
const json = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const prefs = JSON.parse(fs.readFileSync(path.join(FIX, '..', '..', '..', 'examples', 'preferences.example.json'), 'utf8'));

const sr = await import('../src/scrape/sources/smartrecruiters.js');
const rc = await import('../src/scrape/sources/recruitee.js');
const hn = await import('../src/scrape/boards/hn.js');
const arbeitnow = await import('../src/scrape/boards/arbeitnow.js');
const remotive = await import('../src/scrape/boards/remotive.js');
const remoteok = await import('../src/scrape/boards/remoteok.js');
const { recognizeUrl } = await import('../src/scrape/urls.js');
const { slugCandidates, detectCompany, nameMatches, createSession, probe, confidenceFor } = await import('../src/scrape/detect.js');
const { validateCompany, addCompanies, filterCompanies, loadCompaniesFile } = await import('../src/scrape/companies.js');
const yc = await import('../src/scrape/yc.js');
const { eligibility, classify, matchJobTrack } = await import('../src/scrape/filter.js');
const { consolidate, mergeJobs } = await import('../src/scrape/merge.js');
const { cached } = await import('../src/scrape/cache.js');
const { parseSalaryText } = await import('../src/scrape/job.js');
const { fixMojibake } = await import('../src/scrape/text.js');
const { detectYc, checkCompany } = await import('../src/scrape/cli.js');
const { splitExclusions, detectCountries } = await import('../src/scrape/geo.js');
const { isApiUrl, getJSON } = await import('../src/scrape/http.js');
const { textHasPhrase } = await import('../src/scrape/filter.js');

const ACME = { name: 'Acme', slug: 'Acme1' };

// ---------- new ATS ----------
test('smartrecruiters list + detail normalize', () => {
  const [fe, acct] = sr.normalize(json('smartrecruiters-list.json'), ACME);
  assert.equal(fe.title, 'Senior Frontend Engineer');
  assert.equal(fe.url, 'https://jobs.smartrecruiters.com/Acme1/744000156077279');
  assert.deepEqual(fe.countries, ['IN']);
  assert.equal(fe.workMode, 'hybrid');
  assert.equal(fe.description, '');
  assert.equal(acct.workMode, 'remote');
  assert.equal(acct.location, 'San Mateo, CA, US');
  const d = sr.normalizeOne(json('smartrecruiters-detail.json'), ACME);
  assert.equal(d.key, fe.key, 'detail keeps the same key');
  assert.deepEqual(d.salary, { min: 3000000, max: 4200000, currency: 'INR', unit: 'year' });
  assert.match(d.description, /^Company Description\n\nAcme builds CRM software\.\n\nJob Description\n\n- Own the React app\n- Mentor engineers/);
  assert.match(d.applyUrl, /oga=true$/);
});

test('recruitee normalize skips drafts, parses salary/period', () => {
  const jobs = rc.normalize(json('recruitee.json'), { name: 'Channel Co', slug: 'channel' });
  assert.equal(jobs.length, 1);
  const [j] = jobs;
  assert.equal(j.workMode, 'hybrid');
  assert.deepEqual(j.countries, ['NL']);
  assert.deepEqual(j.salary, { min: 3650, max: 5000, currency: 'EUR', unit: 'month' });
  assert.equal(j.postedAt, '2026-10-16T11:35:00.000Z');
  assert.equal(j.description, 'We build feeds.\n\n- Vue or React');
  assert.equal(j.sourceId, 'senior-frontend-developer-3');
});

test('url recognition for smartrecruiters and recruitee', () => {
  assert.deepEqual(recognizeUrl('https://jobs.smartrecruiters.com/Freshworks/744000156077279-senior-manager'), { source: 'smartrecruiters', slug: 'Freshworks', id: '744000156077279' });
  assert.deepEqual(recognizeUrl('https://channable.recruitee.com/o/senior-frontend-developer-3'), { source: 'recruitee', slug: 'channable', id: 'senior-frontend-developer-3' });
  assert.equal(recognizeUrl('https://channable.recruitee.com/'), null);
});

// ---------- HN ----------
test('HN first-line parsing across common formats', () => {
  const cases = [
    ['Acme AI (YC W24) | Senior Frontend Engineer | Bengaluru, India | ONSITE | Full-time | ₹40L - ₹60L',
      { company: 'Acme AI', roles: ['Senior Frontend Engineer'], location: 'Bengaluru, India', onsite: true, remote: false, visa: false }],
    ['Globex | Forward Deployed Engineer, Solutions Engineer | REMOTE (Worldwide) | VISA | $150k-$190k + equity',
      { company: 'Globex', roles: ['Forward Deployed Engineer', 'Solutions Engineer'], location: 'REMOTE (Worldwide)', remote: true, visa: true }],
    ['Initech | Software Engineer - Frontend | San Francisco, CA | ONSITE | No visa sponsorship',
      { company: 'Initech', roles: ['Software Engineer - Frontend'], location: 'San Francisco, CA', visa: false }],
    ['Hooli — Full-Stack Engineer — Remote (US only) — https://hooli.example',
      { company: 'Hooli', roles: ['Full-Stack Engineer'], location: 'Remote (US only)', remote: true }],
    ['Umbrella | Multiple roles | London, UK | HYBRID | VISA',
      { company: 'Umbrella', roles: ['Multiple roles'], location: 'London, UK', hybrid: true, visa: true }],
    ['Stark Labs | Backend Engineer (Go) | REMOTE (EU timezones) | Full-time',
      { company: 'Stark Labs', roles: ['Backend Engineer (Go)'], location: 'REMOTE (EU timezones)', remote: true }],
    ['Wayne Corp | UI Engineer, Design Engineer | Remote (APAC) | INTERNS welcome',
      { company: 'Wayne Corp', roles: ['UI Engineer', 'Design Engineer'], location: 'Remote (APAC)' }],
    ['Soylent (Remote, India) | Senior Front End Developer & Engineering Manager | Full-time',
      { company: 'Soylent', roles: ['Senior Front End Developer', 'Engineering Manager'], location: 'Remote, India', remote: true }],
    ['Tyrell | Berlin, Germany (or remote, CET/CEST overlap) | Full-time https://tyrell.example',
      { company: 'Tyrell', roles: [], location: 'Berlin, Germany (or remote, CET/CEST overlap)' }],
  ];
  for (const [line, want] of cases) {
    const got = hn.parseFirstLine(line);
    for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k], v, `${line} → ${k}`);
  }
  assert.deepEqual(hn.parseFirstLine('Acme | $120k-$150k | Remote').salary, { min: 120000, max: 150000, currency: 'USD', unit: 'year' });
  // spaced hyphen separator (only when there are no pipes) and "Name: rest"
  const dash = hn.parseFirstLine('Quantum Widgets - Senior Frontend Engineer - Remote (India)');
  assert.deepEqual([dash.company, dash.roles, dash.location], ['Quantum Widgets', ['Senior Frontend Engineer'], 'Remote (India)']);
  assert.deepEqual(hn.parseFirstLine('Initech | Software Engineer - Frontend | Remote').roles, ['Software Engineer - Frontend']);
  const named = hn.parseFirstLine('Blue Orbit: Frontend Engineers, Remote (APAC)');
  assert.equal(named.company, 'Blue Orbit');
  assert.deepEqual(named.roles, ['Frontend Engineers']);
});

test('HN parser rejects non-job comments', () => {
  for (const line of [
    'Location: Bengaluru, India',
    'Remote: Yes',
    'Willing to relocate: No',
    'Technologies: React, TypeScript',
    'Résumé: https://example.com/cv.pdf',
    'Email: me@example.com',
    'Role: UX/UI Designer | Remote',
    'Is anyone hiring for embedded roles in Europe this month? Asking for a friend',
    'We are a small team building developer tools for the next generation of web apps and our stack | React',
    'Thanks for posting this every month',
  ]) assert.equal(hn.parseFirstLine(line), null, line);
});

test('HN thread normalize: one job per top-level comment, HN item URLs, visa flag', () => {
  const jobs = hn.normalize(json('hn-thread.json'));
  assert.equal(jobs.length, 10, 'deleted/empty, seeker, meta and kv comments and replies skipped');
  assert.ok(jobs.every((j) => !('intern' in j)));
  assert.ok(jobs.every((j) => j.company.length <= 60 && j.title.length <= 120));
  const by = Object.fromEntries(jobs.map((j) => [j.company, j]));
  assert.equal(by.Globex.url, 'https://news.ycombinator.com/item?id=102');
  assert.equal(by.Globex.visa, true);
  assert.equal(by.Globex.workMode, 'remote');
  assert.equal(by.Globex.hnThread, '49922569');
  assert.equal(by.Cyberdyne.title, 'ML Engineer', 'newline-terminated first line');
  assert.equal(by.Umbrella.title, 'Multiple roles');
  assert.match(by['Acme AI'].description, /We build agents/);
  assert.equal(hn.latestThread(json('hn-search.json')).objectID, '49922569');
});

test('HN track matching uses roles, then first line + body', () => {
  const by = Object.fromEntries(hn.normalize(json('hn-thread.json')).map((j) => [j.company, j]));
  assert.equal(matchJobTrack(by['Acme AI'], prefs.tracks), 'fe');
  assert.equal(matchJobTrack(by.Globex, prefs.tracks), 'fde');
  assert.equal(matchJobTrack(by.Umbrella, prefs.tracks), 'fe', 'role named in body');
  assert.equal(matchJobTrack(by.Tyrell, prefs.tracks), 'fe');
  assert.equal(matchJobTrack(by['Stark Labs'], prefs.tracks), null);
  assert.equal(matchJobTrack(by.Soylent, prefs.tracks), 'fe', 'one listed role matches even if another is excluded');
});

test('HN fallback matching respects excludeTitles and needs a role noun nearby', () => {
  const mk = (firstLine, roles, body) => ({ title: roles.join(', ') || 'Multiple roles', roles, firstLine, matchText: body });
  const t = prefs.tracks;
  assert.equal(matchJobTrack(mk('Acme | Engineering Manager | Remote', ['Engineering Manager'], 'You will lead our frontend team of 6 frontend engineers.'), t), null);
  assert.equal(matchJobTrack(mk('Acme | Frontend Intern | Remote', ['Frontend Intern'], 'Frontend engineer internship'), t), null);
  assert.equal(matchJobTrack(mk('Acme | Backend Engineer | Remote', ['Backend Engineer'], 'Our React frontend engineer team is separate.'), t), null);
  assert.equal(matchJobTrack(mk('Acme | RF Engineer | Onsite', ['RF Engineer'], 'Design the RF front-end and antennas.'), t), null);
  assert.equal(matchJobTrack(mk('Acme | Multiple roles | Remote', ['Multiple roles'], 'Hiring a senior frontend engineer and a designer.'), t), 'fe');
  assert.equal(matchJobTrack(mk('Acme | Multiple roles | Remote', ['Multiple roles'], 'We need a frontend engineer intern.'), t), null);
  assert.equal(textHasPhrase('our frontend team', 'Frontend Engineer'), false);
  assert.equal(textHasPhrase('frontend engineer wanted', 'Frontend Engineer'), true);
});

test('HN eligibility: India/APAC/worldwide green, US-only orange, VISA + needsSponsorship green', () => {
  const by = Object.fromEntries(hn.normalize(json('hn-thread.json')).map((j) => [j.company, j]));
  const e = (j, p = prefs) => eligibility(j, p).eligibility;
  assert.equal(e(by['Acme AI']), 'green');
  assert.equal(e(by.Globex), 'green');
  assert.equal(e(by['Wayne Corp']), 'green');
  assert.equal(e(by.Soylent), 'green');
  assert.equal(e(by.Hooli), 'orange');
  assert.equal(e(by['Stark Labs']), 'orange');
  assert.equal(e(by.Umbrella), 'orange');
  const sponsor = { ...prefs, location: { ...prefs.location, needsSponsorship: true } };
  assert.equal(e(by.Umbrella, sponsor), 'green');
  assert.equal(e(by.Initech, sponsor), 'orange', '"No visa sponsorship" is not a VISA flag');
});

// ---------- other boards ----------
test('arbeitnow normalize: epoch seconds, remote and visa flags', () => {
  const [a, b] = arbeitnow.normalize(json('arbeitnow.json'));
  assert.equal(a.postedAt, new Date(1792220444 * 1000).toISOString());
  assert.equal(a.visa, true);
  assert.deepEqual(a.countries, ['DE']);
  assert.equal(b.workMode, 'remote');
  const sponsor = { ...prefs, location: { ...prefs.location, needsSponsorship: true } };
  assert.equal(eligibility(a, sponsor).eligibility, 'green');
  assert.equal(eligibility(a, prefs).eligibility, 'orange');
  assert.equal(eligibility(b, prefs).eligibility, 'orange');
});

test('remotive normalize: remote locations, salary text, attribution', () => {
  const [us, ww, multi] = remotive.normalize(json('remotive.json'));
  assert.equal(us.location, 'Remote (USA, Canada, USA timezones)');
  assert.deepEqual(us.salary, { min: 170000, max: 200000, currency: 'USD', unit: 'year' });
  assert.equal(us.postedAt, '2026-10-14T20:33:44.000Z');
  assert.match(us.description, /Source: Remotive \(https:\/\/remotive\.com/);
  assert.equal(eligibility(us, prefs).eligibility, 'orange');
  assert.equal(eligibility(ww, prefs).eligibility, 'green');
  assert.equal(eligibility(multi, prefs).eligibility, 'green', 'APAC in the list covers India');
});

test('remoteok normalize: skips legal row, fixes mojibake, salary, attribution', () => {
  const jobs = remoteok.normalize(json('remoteok.json'));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].location, 'Remote');
  assert.match(jobs[0].description, /You don’t just ship UI\./);
  assert.match(jobs[0].description, /Source: Remote OK/);
  assert.deepEqual(jobs[0].salary, { min: 90000, max: 120000, currency: 'USD', unit: 'year' });
  assert.equal(jobs[1].salary, null);
  assert.equal(eligibility(jobs[1], prefs).eligibility, 'orange');
  assert.equal(fixMojibake('plain ascii'), 'plain ascii');
});

test('geo phrases from boards', () => {
  const remote = (location) => eligibility({ title: 'Frontend Engineer', location, workMode: 'remote', countries: [], description: '' }, prefs);
  assert.equal(remote('Remote (US only)').eligibility, 'orange');
  assert.equal(remote('Remote (North America)').eligibility, 'orange');
  assert.equal(remote('Remote (Northern America, LATAM)').eligibility, 'orange');
  assert.equal(remote('Remote - EU timezones').eligibility, 'orange');
  assert.equal(remote('Remote, CET +/- 2h').eligibility, 'orange');
  assert.equal(remote('Remote (Europe)').eligibility, 'orange');
  for (const w of ['Worldwide', 'Anywhere', 'Remote (Global)']) assert.equal(remote(w).eligibility, 'green', w);
});

test('parseSalaryText', () => {
  assert.deepEqual(parseSalaryText('€75k–80k'), { min: 75000, max: 80000, currency: 'EUR', unit: 'year' });
  assert.deepEqual(parseSalaryText('120,000 - 150,000 USD'), { min: 120000, max: 150000, currency: 'USD', unit: 'year' });
  assert.equal(parseSalaryText('Series B'), null);
  assert.equal(parseSalaryText(''), null);
});

// ---------- merge for boards ----------
test('board expiry: HN jobs from an older thread expire; boards expire by age', () => {
  const oct = hn.normalize(json('hn-thread.json')).slice(0, 2).map((j) => ({ ...j, hnThread: '1' }));
  let { store } = mergeJobs({ version: 1, jobs: {} }, oct, { now: '2026-10-02T00:00:00Z', scraped: [] });
  const res = mergeJobs(store, [], {
    now: '2026-11-02T00:00:00Z',
    scraped: [{ company: null, source: 'hn', seenKeys: new Set(), expireIf: (j) => j.hnThread !== '2' }],
  });
  assert.ok(Object.values(res.store.jobs).every((j) => j.status === 'expired'));
  assert.equal(res.stats.expired, 2);

  const rm = remotive.normalize(json('remotive.json')).slice(0, 1);
  ({ store } = mergeJobs({ version: 1, jobs: {} }, rm, { now: '2026-10-01T00:00:00Z' }));
  const seenOnly = [{ company: null, source: 'remotive', seenKeys: new Set([rm[0].key]), missExpiry: false }];
  ({ store } = mergeJobs(store, [], { now: '2026-10-25T00:00:00Z', scraped: seenOnly, boardExpireDays: 28 }));
  assert.equal(store.jobs[rm[0].key].status, 'new', 'seen (even if filtered) refreshes lastSeen');
  ({ store } = mergeJobs(store, [], { now: '2026-11-30T00:00:00Z', scraped: [{ ...seenOnly[0], seenKeys: new Set() }], boardExpireDays: 28 }));
  assert.equal(store.jobs[rm[0].key].status, 'expired');
});

test('HN jobs ignore the age filter when requested', () => {
  const [j] = hn.normalize(json('hn-thread.json'));
  const now = new Date('2026-10-30T00:00:00Z');
  assert.equal(classify(j, prefs, { now }).reason, 'age');
  assert.equal(classify(j, prefs, { now, ignoreAge: true }).keep, true);
});

// ---------- detect ----------
test('slug candidates', () => {
  assert.deepEqual(slugCandidates('Acme Robotics AI').lower.slice(0, 4), ['acmeroboticsai', 'acmerobotics', 'acme-robotics-ai', 'acme-robotics']);
  assert.deepEqual(slugCandidates('Linear').lower.slice(0, 3), ['linear', 'linearhq', 'linearai']);
  assert.deepEqual(slugCandidates('Hugging Face, Inc.').lower.slice(0, 2), ['huggingface', 'hugging-face']);
  assert.equal(slugCandidates('Zepto Technologies Pvt Ltd').lower[1], 'zepto');
  assert.equal(slugCandidates('Café Labs').lower[1], 'cafe');
  assert.deepEqual(slugCandidates('Acme', ['acme-inc', 'acmehq']).lower.slice(0, 2), ['acme-inc', 'acmehq']);
  assert.ok(slugCandidates('Freshworks').cased.includes('Freshworks'));
  assert.equal(nameMatches('Linear', 'Linear, Inc.'), true);
  assert.equal(nameMatches('Acme Robotics AI', 'Acme Robotics'), true);
  assert.equal(nameMatches('Linear', 'Linear Orbit'), false);
  assert.equal(nameMatches('Raven', 'Acme'), false);
});

const notFound = () => { const e = new Error('HTTP 404'); e.status = 404; throw e; };

test('detectCompany: ≤24 requests, ranking, 0-job boards, low confidence last', async () => {
  const calls = [];
  const getJSON = async (url) => {
    calls.push(url);
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/acmerobotics') return { jobs: [{}, {}, {}] };
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acmeroboticsai/jobs') return { jobs: [] };
    if (url === 'https://apply.workable.com/api/v1/widget/accounts/acmerobotics') return { name: 'Acme Robotics Interiors', jobs: [{}] };
    if (url.includes('smartrecruiters')) return { totalFound: 0, content: [] };
    return notFound();
  };
  const r = await detectCompany('Acme Robotics AI', { getJSON, session: createSession({ workableGapMs: 0 }) });
  assert.ok(calls.length <= 24);
  assert.equal(r.tried, calls.length);
  assert.deepEqual(r.found.map((f) => [f.ats, f.slug, f.jobs, f.confidence]), [
    ['ashby', 'acmerobotics', 3, 'unknown'], ['workable', 'acmerobotics', 1, 'low'], ['greenhouse', 'acmeroboticsai', 0, 'unknown'],
  ]);
  const none = await detectCompany('Nothing Here', { getJSON: notFound, session: createSession({ workableGapMs: 0 }) });
  assert.deepEqual(none.found, []);
});

test('detectCompany: board named like the slug is not "high"; jobs>0 ranks first (Linear case)', async () => {
  const getJSON = async (url) => {
    if (url === 'https://api.ashbyhq.com/posting-api/job-board/linear') return { jobs: Array(29).fill({}) };
    if (url === 'https://apply.workable.com/api/v1/widget/accounts/linear') return { name: 'Linear', jobs: [] };
    return notFound();
  };
  const r = await detectCompany('Linear', { getJSON, session: createSession({ workableGapMs: 0 }) });
  assert.deepEqual(r.found.map((f) => [f.ats, f.jobs, f.confidence]), [['ashby', 29, 'unknown'], ['workable', 0, 'unknown']]);
  assert.equal(confidenceFor('Linear', 'linear', 'Linear'), 'unknown');
  assert.equal(confidenceFor('Linear', 'linearapp', 'Linear'), 'high');
});

test('detectCompany stops at the first high-confidence board with jobs; 429 skips that ATS for the run', async () => {
  let calls = 0;
  const getJSON = async (url) => {
    calls++;
    if (url === 'https://boards-api.greenhouse.io/v1/boards/acmerobotics/jobs') return { jobs: [{ company_name: 'Acme Robotics Inc.' }] };
    return notFound();
  };
  const r = await detectCompany('Acme Robotics', { getJSON, session: createSession({ workableGapMs: 0 }) });
  assert.equal(r.found[0].confidence, 'high');
  assert.equal(calls, 6, 'one round only');

  const session = createSession({ workableGapMs: 0 });
  let lever = 0;
  const limited = async (url) => {
    if (url.includes('api.lever.co')) { lever++; const e = new Error('HTTP 429'); e.status = 429; throw e; }
    return notFound();
  };
  const a = await detectCompany('First Co', { getJSON: limited, session });
  const b = await detectCompany('Second Co', { getJSON: limited, session });
  assert.equal(lever, 1, 'lever skipped after its first 429');
  assert.deepEqual(a.rateLimited, ['lever']);
  assert.equal(b.rateLimited, undefined);
});

test('probe slots: never more than the per-ATS limit in flight, waiters get the slot', async () => {
  const session = createSession();
  let inflight = 0;
  let peak = 0;
  const getJSON = async () => { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 5)); inflight--; return { jobs: [] }; };
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => probe('ashby', `s${i}`, { getJSON, session })));
  assert.equal(rs.length, 12);
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(session.slots.ashby.n, 0);
});

test('detectCompany caches results for 7 days in data/cache/detect.json', async () => {
  let calls = 0;
  const getJSON = async (url) => { calls++; return url.includes('ashbyhq.com/posting-api/job-board/cachedco') ? { jobs: [{}] } : notFound(); };
  const now = Date.parse('2026-10-17T00:00:00Z');
  const session = createSession({ workableGapMs: 0 });
  await detectCompany('Cached Co', { getJSON, session, cache: true, now });
  const n = calls;
  const again = await detectCompany('Cached Co', { getJSON, session, cache: true, now: now + 86400e3 });
  assert.equal(calls, n);
  assert.equal(again.cached, true);
  await detectCompany('Cached Co', { getJSON, session, cache: true, now: now + 8 * 86400e3 });
  assert.ok(calls > n);
  assert.ok(fs.existsSync(path.join(ROOT, 'data', 'cache', 'detect.json')));
});

test('checkCompany: SmartRecruiters with 0 postings is unverifiable', async () => {
  const sources = { smartrecruiters: { fetchJobs: async () => [] } };
  const r = await checkCompany('smartrecruiters', 'Whatever', { sources });
  assert.equal(r.ok, false);
  assert.match(r.error, /unverifiable: 0 postings/);
});

// ---------- companies ----------
test('validateCompany and addCompanies dedupe by ats+slug', () => {
  assert.match(validateCompany({ name: 'X', ats: 'bamboo', slug: 'x' }).error, /ats/);
  assert.match(validateCompany({ name: 'X', ats: 'lever', slug: '../x' }).error, /slug/);
  assert.match(validateCompany({ name: 'X', ats: 'lever', slug: 'x', region: 'mars' }).error, /region/);
  assert.match(validateCompany({ name: 'X', ats: 'lever', slug: 'x', stage: 'ipo' }).error, /stage/);
  const { entry } = validateCompany({ name: ' Acme ', ats: 'lever', slug: 'acme', tags: 'AI, fintech', region: 'india,us', source: 'manual' });
  assert.deepEqual(entry, { name: 'Acme', ats: 'lever', slug: 'acme', tags: ['ai', 'fintech'], region: ['india', 'us'], source: 'manual' });
  const cfg = { version: 1, companies: [{ name: 'Acme', ats: 'lever', slug: 'ACME', tags: ['ai'] }] };
  const plain = addCompanies(cfg, [entry, { name: 'Beta', ats: 'ashby', slug: 'beta' }, { name: 'Acme', ats: 'ashby', slug: 'acme-ashby' }]);
  assert.deepEqual(plain.added.map((c) => c.slug), ['beta', 'acme-ashby']);
  assert.equal(plain.duplicates.length, 1);
  assert.deepEqual(plain.duplicates[0].changed, []);
  assert.deepEqual(plain.duplicates[0].stored, { name: 'Acme', ats: 'lever', slug: 'ACME', tags: ['ai'] }, 'stored entry, not the input');
  assert.deepEqual(plain.cfg.companies[0].tags, ['ai'], 'no silent merge');
  assert.match(plain.warnings[0], /"Acme" is already listed as lever\/ACME/);
  const merged = addCompanies(cfg, [entry], { merge: true });
  assert.deepEqual(merged.duplicates[0].changed, ['tags', 'region', 'source']);
  assert.deepEqual(merged.cfg.companies[0].tags, ['ai', 'fintech']);
  assert.deepEqual(merged.cfg.companies[0].region, ['india', 'us']);
  assert.equal(cfg.companies[0].region, undefined, 'input not mutated');
  assert.deepEqual(filterCompanies(merged.cfg.companies, { region: 'us' }).map((c) => c.name), ['Acme']);
  assert.deepEqual(filterCompanies(merged.cfg.companies, { tag: 'fintech,devtools' }).map((c) => c.name), ['Acme']);
});

test('loadCompaniesFile creates companies.json from the example', () => {
  fs.mkdirSync(path.join(ROOT, 'config'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'config', 'companies.example.json'), JSON.stringify({ version: 1, _comment: 'x', companies: [{ name: 'A', ats: 'lever', slug: 'a' }] }));
  const r = loadCompaniesFile({ create: true });
  assert.equal(r.created, true);
  const written = fs.readFileSync(path.join(ROOT, 'config', 'companies.json'), 'utf8');
  assert.match(written, /^\{\n  "version": 1,\n  "companies": \[/);
  assert.equal(loadCompaniesFile({ create: true }).created, false);
});

// ---------- YC ----------
test('yc filter, region mapping, batch codes, stage and tags', () => {
  const list = json('yc.json');
  assert.deepEqual(yc.mapRegions(['India', 'South Asia', 'Remote', 'Fully Remote']), ['india', 'apac', 'remote-global']);
  assert.deepEqual(yc.mapRegions(['South Asia', 'Remote', 'Partly Remote']), ['apac'], '"Remote" parent and South Asia alone');
  assert.deepEqual(yc.mapRegions(['United States of America', 'America / Canada']), ['us']);
  assert.deepEqual(yc.mapRegions(['America / Canada', 'Canada']), [], 'Canada-only');
  assert.deepEqual(yc.mapRegions(['Germany', 'Europe']), ['eu']);
  assert.deepEqual(yc.mapRegions(['Partly Remote']), []);
  assert.equal(yc.batchCode('Winter 2024'), 'W24');
  assert.equal(yc.batchCode('Spring 2025'), 'X25');
  assert.equal(yc.batchCode('Fall 2025'), 'F25');
  const names = (o) => yc.filterYc(list, o).map((c) => c.name);
  assert.deepEqual(names({}), ['Bolna AI', 'Old Corp', 'Berlin Dev', 'London Pay']);
  assert.deepEqual(names({ region: 'india' }), ['Bolna AI']);
  assert.deepEqual(names({ region: 'eu,uk' }), ['Berlin Dev', 'London Pay']);
  assert.deepEqual(names({ region: 'remote-global' }), ['Bolna AI']);
  assert.deepEqual(names({ region: 'india,uk' }), ['Bolna AI', 'London Pay']);
  assert.deepEqual(names({ industry: 'fintech' }), ['Old Corp', 'London Pay']);
  assert.deepEqual(names({ batch: 'W24' }), ['Berlin Dev']);
  assert.deepEqual(names({ batch: 'winter 2024' }), ['Berlin Dev']);
  const now = new Date('2026-10-17T00:00:00Z');
  assert.equal(yc.stageFor(list[0], now), 'seed');
  assert.equal(yc.stageFor(list[1], now), 'unknown');
  assert.equal(yc.stageFor(list[5], now), 'unknown', 'team > 25');
  assert.deepEqual(yc.tagsFor(list[0]), ['yc', 'b2b', 'ai', 'voice-ai']);
  assert.equal(yc.websiteLabel('https://www.bolna.ai'), 'bolna');
  assert.equal(yc.websiteLabel('london.example'), 'london');
});

test('detectYc passes YC slug + website label and skips mismatched boards', async () => {
  const seen = [];
  const detect = async (name, { slugs }) => {
    seen.push([name, slugs]);
    return name === 'Bolna AI'
      ? { found: [{ ats: 'workable', slug: 'bolna', jobs: 9, confidence: 'low' }, { ats: 'ashby', slug: 'bolna', jobs: 7, confidence: 'unknown' }] }
      : { found: [] };
  };
  const rows = await detectYc(yc.filterYc(json('yc.json'), { region: 'india,eu' }), { detect });
  assert.deepEqual(seen[0], ['Bolna AI', ['bolna', 'bolna']]);
  assert.equal(rows[0].ats, 'ashby');
  assert.equal(rows[0].batch, 'F25');
  assert.deepEqual(rows[0].region, ['india', 'apac', 'remote-global']);
  assert.equal(rows[1].ats, null);
});

// ---------- cache ----------
test('cache reuses data within TTL and refetches after', async () => {
  let n = 0;
  const fetcher = async () => ({ n: ++n });
  const t0 = Date.parse('2026-10-17T00:00:00Z');
  assert.deepEqual(await cached('demo', 3600e3, fetcher, { now: t0 }), { data: { n: 1 }, cached: false });
  assert.deepEqual(await cached('demo', 3600e3, fetcher, { now: t0 + 1000 }), { data: { n: 1 }, cached: true });
  assert.deepEqual(await cached('demo', 3600e3, fetcher, { now: t0 + 86400e3 }), { data: { n: 2 }, cached: false });
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'data', 'cache')).filter((f) => f.startsWith('demo-')), ['demo-2026-10-18.json']);
});

test('consolidate works on board jobs', () => {
  const jobs = consolidate(remotive.normalize(json('remotive.json')), prefs);
  assert.equal(jobs.length, 3);
});

// ---------- review round 2 ----------
test('eligibility: exclusion clauses and US city-state abbreviations', () => {
  const e = (location, workMode = 'remote') => eligibility({ title: 'Frontend Engineer', location, workMode, countries: detectCountries(location), description: '' }, prefs);
  assert.deepEqual(e('Remote (worldwide, excluding India)'), { eligibility: 'orange', eligibilityReason: 'Remote, but excludes IN' });
  assert.equal(e('Remote - anywhere except APAC').eligibilityReason, 'Remote, but excludes APAC');
  assert.equal(e('Remote (Worldwide, not US)').eligibility, 'green');
  assert.equal(e('Delhi, NY', 'onsite').eligibility, 'orange');
  assert.deepEqual(detectCountries('Delhi, NY'), ['US']);
  assert.deepEqual(detectCountries('Chennai, TN, India'), ['IN']);
  assert.deepEqual(detectCountries('New Delhi, India'), ['IN']);
  assert.deepEqual(splitExclusions('Remote outside of the EU').excludedRegions, ['eu']);
});

test('http request only talks to known API hosts and re-checks redirect hops', async () => {
  assert.equal(isApiUrl('https://boards-api.greenhouse.io/v1/boards/x/jobs'), true);
  assert.equal(isApiUrl('https://acme.recruitee.com/api/offers/'), true);
  assert.equal(isApiUrl('http://api.lever.co/v0/postings/x'), false);
  assert.equal(isApiUrl('https://evil.example/'), false);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => (url.includes('lever')
      ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } })
      : new Response('{}', { status: 200 }));
    await assert.rejects(getJSON('https://api.lever.co/v0/postings/x', { retries: 0 }), /not a known job-board API host/);
    await assert.rejects(getJSON('https://evil.example/x', { retries: 0 }), /not a known job-board API host/);
    globalThis.fetch = async (url) => (url.endsWith('/a')
      ? new Response(null, { status: 301, headers: { location: '/b' } })
      : new Response('{"ok":true}', { status: 200 }));
    assert.deepEqual(await getJSON('https://api.ashbyhq.com/a', { retries: 0 }), { ok: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cache: negative cache, stale fallback, newest valid file wins', async () => {
  const t0 = Date.parse('2026-10-17T00:00:00Z');
  const boom = async () => { throw new Error('HTTP 503'); };
  await assert.rejects(cached('neg', 3600e3, boom, { now: t0 }), /fetch failed/);
  let calls = 0;
  await assert.rejects(cached('neg', 3600e3, async () => { calls++; return 1; }, { now: t0 + 60e3 }), /retrying after 1h/);
  assert.equal(calls, 0, 'failing source not refetched within 1h');
  assert.deepEqual(await cached('neg', 3600e3, async () => { calls++; return 1; }, { now: t0 + 2 * 3600e3 }), { data: 1, cached: false });
  const stale = await cached('neg', 3600e3, boom, { now: t0 + 5 * 3600e3 });
  assert.deepEqual(stale, { data: 1, cached: true, stale: true });
  // future-dated entry (clock skew) is not "fresh"
  fs.writeFileSync(path.join(ROOT, 'data', 'cache', 'skew-2026-10-20.json'), JSON.stringify({ fetchedAt: '2026-10-20T00:00:00.000Z', data: 'future' }));
  assert.deepEqual(await cached('skew', 3600e3, async () => 'now', { now: t0 }), { data: 'now', cached: false });
  // corrupt newest file falls back to the next valid one
  fs.writeFileSync(path.join(ROOT, 'data', 'cache', 'cor-2026-10-17.json'), '{nope');
  fs.writeFileSync(path.join(ROOT, 'data', 'cache', 'cor-2026-10-16.json'), JSON.stringify({ fetchedAt: '2026-10-16T23:30:00.000Z', data: 'ok' }));
  assert.deepEqual(await cached('cor', 3600e3, async () => 'refetched', { now: t0 }), { data: 'ok', cached: true });
});

test('HN jobs also expire by age even when the hn source is off', () => {
  const [j] = hn.normalize(json('hn-thread.json'));
  let { store } = mergeJobs({ version: 1, jobs: {} }, [j], { now: '2026-10-01T00:00:00Z' });
  ({ store } = mergeJobs(store, [], { now: '2026-11-15T00:00:00Z', boardExpireDays: 28 }));
  assert.equal(store.jobs[j.key].status, 'expired');
});
