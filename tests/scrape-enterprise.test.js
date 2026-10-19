import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-enterprise-'));
process.env.GAJ_ROOT = ROOT;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FIX = path.join(HERE, 'fixtures', 'scrape');
const json = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const text = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const prefs = JSON.parse(fs.readFileSync(path.join(REPO, 'examples', 'preferences.example.json'), 'utf8'));

const wd = await import('../src/scrape/sources/workday.js');
const keka = await import('../src/scrape/sources/keka.js');
const zoho = await import('../src/scrape/sources/zohorecruit.js');
const sf = await import('../src/scrape/sources/successfactors.js');
const { isApiUrl, hostMatchesSuffix } = await import('../src/scrape/http.js');
const { validateAtsUrl, classifyAtsUrl } = await import('../src/scrape/urlAts.js');
const { validateCompany, addCompanies } = await import('../src/scrape/companies.js');
const { detectEmbeddedAts } = await import('../src/scrape/careers/extract.js');
const { recognizeUrl } = await import('../src/scrape/urls.js');
const { detectCountries } = await import('../src/scrape/geo.js');
const { eligibility } = await import('../src/scrape/filter.js');
const { importJobs, normalizeAlertUrl } = await import('../src/scrape/importer.js');
const { mergeJobs, TIME_EXPIRY_SOURCES, SECONDARY_SOURCES } = await import('../src/scrape/merge.js');
const { makeJob } = await import('../src/scrape/job.js');
const { classifyCareersUrl, checkCompany, searchTermsFor } = await import('../src/scrape/cli.js');

const NOW = Date.parse('2026-10-19T10:00:00Z');
const NV = { name: 'NVIDIA', url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' };

// ---------- host allowlist ----------
test('suffix host patterns: exact label count, no lookalikes, no ports', () => {
  assert.equal(isApiUrl('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/x/jobs'), true);
  assert.equal(isApiUrl('https://jupiter.keka.com/careers/'), true);
  for (const bad of ['https://evilmyworkdayjobs.com/', 'https://myworkdayjobs.com/', 'https://a.b.wd5.myworkdayjobs.com/',
    'https://nvidia.wd5.myworkdayjobs.com.evil.com/', 'https://nvidia.wdx.myworkdayjobs.com/', 'http://nvidia.wd5.myworkdayjobs.com/',
    'https://nvidia.wd5.myworkdayjobs.com:8443/', 'https://keka.com/', 'https://a.b.keka.com/', 'https://-bad.keka.com/', 'https://127.0.0.1/']) {
    assert.equal(isApiUrl(bad), false, bad);
  }
  assert.equal(hostMatchesSuffix('x.keka.com', { suffix: 'keka.com', labels: 1 }), true);
  assert.equal(hostMatchesSuffix('x_y.keka.com', { suffix: 'keka.com', labels: 1 }), false);
});

// ---------- workday ----------
test('parseWorkdayUrl and postedOn parsing', () => {
  assert.deepEqual(wd.parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/India-Bengaluru/X_JR1'), {
    origin: 'https://nvidia.wd5.myworkdayjobs.com', tenant: 'nvidia', pod: 'wd5', site: 'NVIDIAExternalCareerSite',
    siteUrl: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', rest: '/job/India-Bengaluru/X_JR1' });
  assert.equal(wd.parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/'), null);
  assert.equal(wd.parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/x'), null);
  assert.equal(wd.parseWorkdayUrl('https://example.com/Site'), null);
  assert.equal(wd.postedOnToISO('Posted Today', NOW), '2026-10-19T00:00:00.000Z');
  assert.equal(wd.postedOnToISO('Posted Yesterday', NOW), '2026-10-18T00:00:00.000Z');
  assert.equal(wd.postedOnToISO('Posted 3 Days Ago', NOW), '2026-10-16T00:00:00.000Z');
  assert.equal(wd.postedOnToISO('Posted 30+ Days Ago', NOW), '2026-09-19T00:00:00.000Z');
  assert.equal(wd.postedOnToISO('Hiring now', NOW), null);
});

test('workday list + detail normalisation', () => {
  const jobs = wd.normalize(json('workday-jobs.json'), NV, { now: NOW });
  assert.equal(jobs.length, 4);
  assert.equal(jobs[0].location, 'India, Bengaluru');
  assert.deepEqual(jobs[0].countries, ['IN']);
  assert.match(jobs[0].url, /^https:\/\/nvidia\.wd5\.myworkdayjobs\.com\/NVIDIAExternalCareerSite\/job\/India-Bengaluru\//);
  assert.equal(jobs[0].sourceId, '/job/India-Bengaluru/HPC-Operations-Engineer_JR2014195', 'externalPath is the stable source id');
  const multi = jobs[3];
  assert.equal(multi.location, 'India Bengaluru', '"2 Locations" → location from externalPath');
  assert.equal(multi.postedAt, '2026-10-16T00:00:00.000Z');
  assert.equal(eligibility(multi, prefs).eligibility, 'green');
  const d = wd.normalizeDetail(json('workday-detail.json'), NV, { now: NOW });
  assert.equal(d.title, 'HPC Operations Engineer');
  assert.deepEqual(d.countries, ['IN']);
  assert.equal(d.postedAt, '2026-07-29T00:00:00.000Z');
  assert.ok(d.description.length > 50 && !/</.test(d.description));
  assert.match(d.applyUrl, /\/apply$/);
});

function mockFetch(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => { calls.push({ url, method: init.method ?? 'GET', body: init.body }); return handler(url, init, calls); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('workday fetchJobs: searchText per term (≤4), pagination stop, details only for matches', async () => {
  const page = json('workday-jobs.json');
  const m = mockFetch((url, init) => {
    if (url.endsWith('/jobs')) {
      const body = JSON.parse(init.body);
      // first term: a full page then a short one; other terms: short page
      if (body.searchText === 'Frontend' && body.offset === 0) return Response.json({ total: 24, jobPostings: Array.from({ length: 20 }, (_, i) => ({ ...page.jobPostings[0], externalPath: `/job/India-Bengaluru/Role-${i}_JR${i}`, title: `Role ${i}` })) });
      return Response.json({ total: 4, jobPostings: page.jobPostings });
    }
    return Response.json(json('workday-detail.json'));
  });
  try {
    const terms = ['Frontend', 'UI Engineer', 'Forward Deployed Engineer', 'UI Developer', 'React Developer', 'Solutions Engineer'];
    const jobs = await wd.fetchJobs(NV, { searchTerms: terms, wantDetail: (j) => /Frontend/i.test(j.title), gapMs: 0, robots: async () => true, now: NOW });
    const posts = m.calls.filter((c) => c.url.endsWith('/jobs'));
    const searched = posts.map((c) => JSON.parse(c.body).searchText);
    assert.deepEqual([...new Set(searched)], terms.slice(0, 4), 'capped at 4 terms');
    assert.equal(searched.filter((t) => t === 'Frontend').length, 2, 'second page fetched, then stopped (short page)');
    assert.equal(m.calls.filter((c) => c.method === 'GET').length, 1, 'one detail request (one title match)');
    const detailed = jobs.find((j) => j.description);
    assert.ok(detailed, 'detail merged');
    assert.equal(detailed.key, wd.normalize(page, NV, { now: NOW }).find((x) => x.title === 'Senior Frontend Engineer, Web Platform').key, 'detail never re-keys the list job');
    assert.equal(detailed.sourceId, '/job/India-Bengaluru/Senior-Frontend-Engineer--Web-Platform_JR9990001');
    assert.equal(jobs.length, 24);
    assert.ok(jobs.every((j) => !('externalPath' in j)));
    assert.ok(m.calls.every((c) => c.url.startsWith('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite')));
  } finally { m.restore(); }
});

test('workday check: 404 unknown site, 422 unknown tenant, robots refusal', async () => {
  let m = mockFetch(() => new Response('{"errorCode":"S21","httpStatus":404}', { status: 404 }));
  try { assert.match((await wd.check(NV.url, { robots: async () => true })).error, /no Workday site "NVIDIAExternalCareerSite"/); } finally { m.restore(); }
  m = mockFetch(() => new Response('{"errorCode":"HTTP_422"}', { status: 422 }));
  try { assert.match((await wd.check(NV.url, { robots: async () => true })).error, /no Workday tenant "nvidia" on wd5/); } finally { m.restore(); }
  assert.match((await wd.check(NV.url, { robots: async () => false })).error, /robots/);
  await assert.rejects(wd.fetchJobs(NV, { robots: async () => false }), /robots\.txt/);
});

// ---------- keka ----------
test('keka: portal id from the careers page, job normalisation', async () => {
  assert.equal(keka.portalId(text('keka-careers.html')), 'b5279857-cf81-4dde-a215-fc48957ee2b5');
  assert.equal(keka.parseKekaUrl('https://jupiter.keka.com/careers/').tenant, 'jupiter');
  assert.equal(keka.parseKekaUrl('https://keka.com/careers/'), null);
  const c = { name: 'Jupiter', url: 'https://jupiter.keka.com/careers/' };
  const [a] = keka.normalize(json('keka-jobs.json'), c);
  assert.equal(a.source, 'keka');
  assert.equal(a.location, 'Mumbai, MH, India');
  assert.deepEqual(a.countries, ['IN']);
  assert.equal(a.url, 'https://jupiter.keka.com/careers/jobdetails/141185');
  assert.ok(!/</.test(a.description));
  const m = mockFetch((url) => (url.endsWith('/careers/') ? new Response(text('keka-careers.html'), { headers: { 'content-type': 'text/html' } }) : Response.json(json('keka-jobs.json'))));
  try {
    const jobs = await keka.fetchJobs(c, { robots: async () => true });
    assert.equal(jobs.length, 2);
    assert.equal(m.calls[1].url, 'https://jupiter.keka.com/careers/api/embedjobs/default/active/b5279857-cf81-4dde-a215-fc48957ee2b5');
  } finally { m.restore(); }
});

// ---------- zoho recruit ----------
test('zohorecruit: embedded jobs JSON, unpublished skipped, job URLs', () => {
  const list = zoho.embeddedJobs(text('zoho-portal.html'));
  assert.equal(list.length, 3);
  const jobs = zoho.normalize(list, { name: 'Zylker', url: 'https://zylker.zohorecruit.com/jobs/Careers' });
  assert.equal(jobs.length, 2, 'Publish:false skipped');
  assert.equal(jobs[0].title, 'Software Engineer');
  assert.deepEqual(jobs[0].countries, ['IN']);
  assert.equal(jobs[0].location, 'Georgia, Tamil Nadu, India');
  assert.match(jobs[0].url, /^https:\/\/zylker\.zohorecruit\.com\/jobs\/Careers\/\d+$/);
  assert.equal(zoho.embeddedJobs('<html>nothing</html>'), null);
  assert.equal(zoho.portalUrl('https://careers.zohocorp.com/jobs/Careers?x=1'), 'https://careers.zohocorp.com/jobs/Careers');
});

// ---------- successfactors ----------
test('successfactors RMK search rows, totals and job descriptions', () => {
  const jobs = sf.normalize(text('sf-search.html'), { name: 'Tata Motors', url: 'https://careers.tatamotors.com' });
  assert.equal(jobs.length, 2);
  assert.match(jobs[0].url, /^https:\/\/careers\.tatamotors\.com\/job\//);
  assert.match(jobs[0].location, /, India$/);
  assert.deepEqual(jobs[0].countries, ['IN'], '"Pune, IN" is India, not Indiana');
  assert.match(jobs[0].postedAt, /^2026-\d\d-\d\dT00:00:00\.000Z$/);
  assert.match(jobs[0].sourceId, /^\d{6,}$/);
  assert.equal(sf.totalResults(text('sf-search.html')), 100);
  assert.equal(sf.descriptionFrom(text('sf-job.html')), 'Role\n\n- Build EV telematics apps\n- React and TypeScript');
  assert.equal(sf.siteOrigin('http://careers.tatamotors.com'), null);
});

test('geo: country codes after Indian cities', () => {
  assert.deepEqual(detectCountries('Pune, IN'), ['IN']);
  assert.deepEqual(detectCountries('Pune, MH, IN'), ['IN']);
  assert.deepEqual(detectCountries('Chennai, TN'), ['IN']);
  assert.deepEqual(detectCountries('Indianapolis, IN'), ['US']);
  assert.deepEqual(detectCountries('Nashville, TN'), ['US']);
  assert.deepEqual(detectCountries('Delhi, NY'), ['US']);
});

// ---------- URL validation / classification / companies ----------
test('validateAtsUrl / classifyAtsUrl / validateCompany for url-based ATSs', () => {
  assert.deepEqual(validateAtsUrl('workday', 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x'), { url: NV.url, slug: 'nvidia' });
  assert.match(validateAtsUrl('workday', 'https://jupiter.keka.com/careers/').error, /myworkdayjobs/);
  assert.match(validateAtsUrl('keka', 'https://nvidia.wd5.myworkdayjobs.com/x').error, /keka/);
  assert.deepEqual(validateAtsUrl('zohorecruit', 'https://careers.zohocorp.com/jobs/Careers'), { url: 'https://careers.zohocorp.com/jobs/Careers', slug: 'careers' });
  assert.match(validateAtsUrl('zohorecruit', 'https://acme.example/careers').error, /zohorecruit/);
  assert.match(validateAtsUrl('successfactors', 'https://jobs.lever.co/acme').error, /another ATS/);
  assert.deepEqual(validateAtsUrl('successfactors', 'https://careers.tatamotors.com/search/'), { url: 'https://careers.tatamotors.com', slug: 'tatamotors' });
  assert.equal(classifyAtsUrl('https://jupiter.keka.com/careers/jobdetails/1').ats, 'keka');
  assert.equal(classifyAtsUrl('https://zylker.zohorecruit.in/jobs/Careers').ats, 'zohorecruit');
  assert.equal(classifyAtsUrl('https://example.com/careers'), null);
  const { entry } = validateCompany({ name: 'NVIDIA', ats: 'workday', url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite' });
  assert.deepEqual(entry, { name: 'NVIDIA', ats: 'workday', slug: 'nvidia', url: NV.url });
  assert.match(validateCompany({ name: 'X', ats: 'workday', slug: 'x' }).error, /workday/);
  const r = addCompanies({ companies: [entry] }, [{ ...entry, slug: 'other' }, { name: 'NVIDIA Research', ats: 'workday', slug: 'nvidia', url: 'https://nvidia.wd5.myworkdayjobs.com/Research' }]);
  assert.equal(r.duplicates.length, 1, 'same url = duplicate');
  assert.equal(r.added.length, 1, 'another site of the same tenant is a different entry');
});

test('every seed entry in companies.example.json validates', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'companies.example.json'), 'utf8'));
  for (const c of seed.companies) assert.equal(validateCompany(c).error, undefined, `${c.name}: ${validateCompany(c).error}`);
  const urlBased = seed.companies.filter((c) => ['workday', 'keka', 'zohorecruit', 'successfactors'].includes(c.ats));
  assert.ok(urlBased.length >= 20);
});

test('careers page detection reports url-based ATS with canonical urls', () => {
  const found = detectEmbeddedAts('<a href="https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x">Jobs</a><iframe src="https://jupiter.keka.com/careers/"></iframe><script>"https:\\/\\/zylker.zohorecruit.com\\/jobs\\/Careers"</script>');
  const by = Object.fromEntries(found.map((f) => [f.ats, f]));
  assert.deepEqual(by.workday, { ats: 'workday', slug: 'nvidia', hits: 1, url: NV.url });
  assert.equal(by.keka.url, 'https://jupiter.keka.com/careers/');
  assert.equal(by.zohorecruit.url, 'https://zylker.zohorecruit.com/jobs/Careers');
  assert.equal(detectEmbeddedAts('https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/Site/jobs').length, 0, 'API path is not a site');
});

test('recognizeUrl for workday/keka/zoho job links', () => {
  assert.deepEqual(recognizeUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/India-Bengaluru/X_JR1'), { source: 'workday', slug: 'nvidia', id: 'job/India-Bengaluru/X_JR1', byUrl: true });
  assert.deepEqual(recognizeUrl('https://jupiter.keka.com/careers/jobdetails/141185'), { source: 'keka', slug: 'jupiter', id: '141185', byUrl: true });
  assert.deepEqual(recognizeUrl('https://zylker.zohorecruit.com/jobs/Careers/499887000002979001/Software-Engineer'), { source: 'zohorecruit', slug: 'zylker', id: '499887000002979001', byUrl: true });
  assert.equal(recognizeUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite'), null);
});

test('company:detect --url classification (stubbed sources)', async () => {
  const sources = {
    workday: { check: async (u) => ({ ok: true, jobs: 278, sample: [] }) },
    successfactors: { check: async () => ({ ok: true, jobs: 100, sample: [] }) },
  };
  const r = await classifyCareersUrl('NVIDIA', 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite', { sources });
  assert.deepEqual(r.found, [{ ats: 'workday', slug: 'nvidia', url: NV.url, jobs: 278, confidence: 'high' }]);
  const gh = await classifyCareersUrl('Acme', 'https://boards.greenhouse.io/acme', { sources, probeSlug: async () => ({ jobs: 7, boardName: 'Acme' }) });
  assert.deepEqual(gh.found.map((f) => [f.ats, f.slug, f.jobs]), [['greenhouse', 'acme', 7]]);
  const sfr = await classifyCareersUrl('Tata Motors', 'https://careers.tatamotors.com/', { sources });
  assert.deepEqual(sfr.found.map((f) => [f.ats, f.url]), [['successfactors', 'https://careers.tatamotors.com']]);
  const none = await classifyCareersUrl('X', 'https://x.example/careers', { sources: { successfactors: { check: async () => ({ ok: false, error: 'no' }) } } });
  assert.match(none.hint, /careers:check/);
});

test('company:check for url-based ATS requires a matching url', async () => {
  const r = await checkCompany('workday', 'nvidia', { url: 'https://jupiter.keka.com/careers/' });
  assert.equal(r.ok, false);
  assert.match(r.error, /myworkdayjobs/);
  const ok = await checkCompany('keka', 'jupiter', { url: 'https://jupiter.keka.com/careers/', sources: { keka: { check: async () => ({ ok: true, jobs: 5, sample: ['A'] }) } } });
  assert.deepEqual([ok.ok, ok.jobs, ok.url], [true, 5, 'https://jupiter.keka.com/careers/']);
});

test('search terms interleave track titles', () => {
  const terms = searchTermsFor(prefs);
  assert.equal(terms[0], prefs.tracks[0].titles[0]);
  assert.equal(terms[1], prefs.tracks[1].titles[0]);
  assert.ok(searchTermsFor(prefs, 'fe').every((t) => prefs.tracks[0].titles.includes(t)));
});

// ---------- email-alert imports ----------
test('jobs:import --source email-alert --via <platform>', () => {
  assert.throws(() => importJobs([], { source: 'email-alert' }), /--via/);
  assert.throws(() => importJobs([], { source: 'manual', via: 'naukri' }), /only used with --source email-alert/);
  const r = importJobs([
    { title: 'Frontend Engineer', company: 'Acme', url: 'https://www.linkedin.com/comm/jobs/view/4300000011/?trackingId=abc&refId=x' },
    { title: 'UI Engineer', company: 'Globex', url: 'https://www.naukri.com/job-listings-ui-engineer-globex-1?src=jobalert&utm_source=email' },
    { title: 'Bad host', company: 'X', url: 'https://example.com/job/1' },
  ], { source: 'email-alert', via: 'linkedin' });
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].url, 'https://www.linkedin.com/jobs/view/4300000011/');
  assert.equal(r.jobs[0].via, 'linkedin');
  assert.equal(r.jobs[0].source, 'email-alert');
  assert.equal(r.errors.length, 2);
  const n = importJobs([{ title: 'UI Engineer', company: 'Globex', url: 'https://www.naukri.com/job-listings-ui-engineer-globex-1?utm_source=email' }], { source: 'email-alert', via: 'naukri' });
  assert.equal(n.jobs[0].url, 'https://www.naukri.com/job-listings-ui-engineer-globex-1');
  const other = importJobs([{ title: 'Dev', company: 'Y', url: 'https://jobs.y.example/1?utm_campaign=z' }], { source: 'email-alert', via: 'other' });
  assert.equal(other.jobs[0].url, 'https://jobs.y.example/1');
  assert.ok(TIME_EXPIRY_SOURCES.has('email-alert') && SECONDARY_SOURCES.has('email-alert'));
});

test('email-alert links for wellfound/instahyre/cutshort use the platform helpers', async () => {
  const wf = await import('../src/scrape/boards/wellfound.js');
  const ih = await import('../src/scrape/boards/instahyre.js');
  const u1 = 'https://wellfound.com/jobs/3012345-frontend-engineer?utm_source=email&utm_medium=alert';
  assert.equal(normalizeAlertUrl(u1, 'wellfound'), wf.normalizeJobUrl(u1));
  const u2 = 'https://www.instahyre.com/job-298765-frontend-engineer-at-acme-bangalore/?utm_source=alert';
  assert.equal(normalizeAlertUrl(u2, 'instahyre'), ih.normalizeJobUrl(u2));
  const r = importJobs([{ title: 'Frontend Engineer', company: 'Acme', url: u2 }, { title: 'X', company: 'Y', url: 'https://www.instahyre.com/about/' }], { source: 'email-alert', via: 'instahyre' });
  assert.equal(r.jobs.length, ih.isPlatformJobUrl(ih.normalizeJobUrl(u2)) ? 1 : 0);
  assert.ok(r.errors.some((e) => /instahyre job URL/.test(e.error)));
});

test('email-alert job folds into an existing ATS record', () => {
  const ats = { ...makeJob({ title: 'Frontend Engineer', company: 'Acme', location: 'Bengaluru, India', source: 'greenhouse', sourceId: '1', url: 'https://boards.greenhouse.io/acme/jobs/1' }), track: 'fe', eligibility: 'green', eligibilityReason: 'x' };
  const alert = { ...makeJob({ title: 'Frontend Engineer', company: 'Acme Pvt Ltd', location: 'Bengaluru', source: 'email-alert', sourceId: 'u', url: 'https://www.naukri.com/job-listings-x' }), via: 'naukri', track: 'fe', eligibility: 'green', eligibilityReason: 'x' };
  const { store } = mergeJobs({ version: 1, jobs: {} }, [ats, alert], { now: '2026-10-19T00:00:00Z' });
  assert.equal(Object.keys(store.jobs).length, 1);
  assert.deepEqual(store.jobs[ats.key].alsoSeenOn, ['email-alert']);
});

// ---------- review round ----------
test('workday: no detail requests without wantDetail; requests serialised per pod', async () => {
  const page = json('workday-jobs.json');
  let inflight = 0;
  let peak = 0;
  const m = mockFetch(async (url) => {
    inflight++; peak = Math.max(peak, inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    return url.endsWith('/jobs') ? Response.json({ total: 4, jobPostings: page.jobPostings }) : Response.json(json('workday-detail.json'));
  });
  try {
    const other = { name: 'Other', url: 'https://other.wd5.myworkdayjobs.com/Careers' };
    const [a, b] = await Promise.all([
      wd.fetchJobs(NV, { searchTerms: ['A', 'B'], gapMs: 0, robots: async () => true }),
      wd.fetchJobs(other, { searchTerms: ['A', 'B'], gapMs: 0, robots: async () => true }),
    ]);
    assert.equal(a.length, 4);
    assert.equal(b.length, 4);
    assert.ok(m.calls.every((c) => c.method === 'POST'), 'no detail GETs');
    assert.equal(peak, 1, 'one request in flight on pod wd5 across companies');
  } finally { m.restore(); }
});

test('workday/successfactors results never miss-expire; they expire by age', async () => {
  const { mergeJobs: merge, expiresByAge } = await import('../src/scrape/merge.js');
  const fe = { ...makeJob({ title: 'Frontend Engineer', company: 'NVIDIA', location: 'India, Pune', source: 'workday', sourceId: '/job/a', url: 'https://nvidia.wd5.myworkdayjobs.com/S/job/a' }), track: 'fe' };
  const fde = { ...makeJob({ title: 'Forward Deployed Engineer', company: 'NVIDIA', location: 'India, Pune', source: 'workday', sourceId: '/job/b', url: 'https://nvidia.wd5.myworkdayjobs.com/S/job/b' }), track: 'fde' };
  let { store } = merge({ version: 1, jobs: {} }, [fe, fde], { now: '2026-10-01T00:00:00Z' });
  // two `--track fe` runs only see the fe job
  const partial = [{ company: 'NVIDIA', source: 'workday', seenKeys: new Set([fe.key]), missExpiry: false }];
  ({ store } = merge(store, [fe], { now: '2026-10-02T00:00:00Z', scraped: partial }));
  ({ store } = merge(store, [fe], { now: '2026-10-03T00:00:00Z', scraped: partial }));
  assert.equal(store.jobs[fde.key].status, 'new', 'not expired by misses');
  ({ store } = merge(store, [fe], { now: '2026-11-15T00:00:00Z', scraped: partial, boardExpireDays: 28 }));
  assert.equal(store.jobs[fde.key].status, 'expired', 'expired by age');
  assert.equal(expiresByAge({ source: 'careers', via: 'workday' }), true);
  assert.equal(expiresByAge({ source: 'careers', via: 'greenhouse' }), false);
});

test('http: userinfo URLs and reserved keka labels are not API hosts', () => {
  assert.equal(isApiUrl('https://user:pw@nvidia.wd5.myworkdayjobs.com/x'), false);
  assert.equal(isApiUrl('https://user@api.ashbyhq.com/x'), false);
  for (const l of ['www', 'login', 'app', 'api', 'help', 'support', 'status', 'developer', 'blog']) assert.equal(isApiUrl(`https://${l}.keka.com/careers/`), false, l);
  assert.equal(keka.parseKekaUrl('https://login.keka.com/careers/'), null);
});

test('keka: robots checked first; redirects off the tenant origin refused', async () => {
  const c = { name: 'Jupiter', url: 'https://jupiter.keka.com/careers/' };
  await assert.rejects(keka.fetchJobs(c, { robots: async () => false }), /robots/);
  const m = mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://other.keka.com/careers/' } }));
  try { await assert.rejects(keka.fetchJobs(c, { robots: async () => true }), /refusing redirect off/); } finally { m.restore(); }
});

test('url-based ATS entries reject IP, localhost, internal and credentialed hosts', () => {
  for (const u of ['https://127.0.0.1/jobs/Careers', 'https://localhost/jobs/Careers', 'https://careers.internal/jobs/Careers', 'https://intranet/jobs/Careers', 'https://u:p@careers.acme.com/jobs/Careers', 'https://careers.acme.com:8443/jobs/Careers', 'https://[::1]/jobs/Careers']) {
    assert.ok(validateAtsUrl('zohorecruit', u).error, u);
    assert.ok(validateAtsUrl('successfactors', u).error, u);
  }
  assert.equal(validateAtsUrl('successfactors', 'https://careers.acme.com').error, undefined);
});

test('geo: India/US code checks are per location segment', () => {
  assert.deepEqual(detectCountries('Pune, IN or Indianapolis, IN').sort(), ['IN', 'US']);
  assert.deepEqual(detectCountries('Indianapolis, IN; Bengaluru, India').sort(), ['IN', 'US']);
  assert.deepEqual(detectCountries('Chennai, TN | Nashville, TN').sort(), ['IN', 'US']);
});

test('email-alert host vetting: fixed registrable domains; --via other needs a public host', () => {
  const rows = (urls, via) => importJobs(urls.map((url, i) => ({ title: `T${i}`, company: 'C', url })), { source: 'email-alert', via });
  const indeed = rows(['https://indeed.evil.com/viewjob?jk=1', 'https://www.indeed.com.evil.io/x', 'https://in.indeed.com/viewjob?jk=2', 'https://www.indeed.co.uk/viewjob?jk=3', 'https://a.b.indeed.com/x'], 'indeed');
  assert.deepEqual(indeed.jobs.map((j) => new URL(j.url).hostname), ['in.indeed.com', 'www.indeed.co.uk']);
  const gd = rows(['https://glassdoor.evil.com/job', 'https://www.glassdoor.co.in/job-listing/x'], 'glassdoor');
  assert.deepEqual(gd.jobs.map((j) => new URL(j.url).hostname), ['www.glassdoor.co.in']);
  const other = rows(['https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x', 'https://intranet/x', 'https://jobs.corp/x', 'https://jobs.acme.io/1'], 'other');
  assert.deepEqual(other.jobs.map((j) => new URL(j.url).hostname), ['jobs.acme.io']);
});

test('jobs:import resolves relative paths against the project root', async () => {
  const { importPathAllowed } = await import('../src/scrape/importer.js');
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'rel.json'), '[]');
  const r = importPathAllowed('data/rel.json');
  assert.equal(r.ok, true);
  assert.equal(r.path, fs.realpathSync(path.join(ROOT, 'data', 'rel.json')));
});

test('robots.txt is fetched once per origin', async () => {
  const { robotsAllows, clearRobotsCache } = await import('../src/scrape/robots.js');
  clearRobotsCache();
  const m = mockFetch(async () => new Response('User-agent: *\nDisallow: /private', { status: 200 }));
  try {
    // safeGet resolves DNS for real; use a literal public IP host to stay offline.
    const base = 'https://93.184.216.34';
    assert.equal(await robotsAllows(`${base}/a`), true);
    assert.equal(await robotsAllows(`${base}/private/x`), false);
    assert.equal(await robotsAllows(`${base}/b`), true);
    assert.equal(m.calls.filter((c) => c.url.endsWith('/robots.txt')).length, 1);
  } finally { m.restore(); clearRobotsCache(); }
});

test('company:detect --url uses the url-based ATS module (no crash without injected sources)', async () => {
  const { primeRobotsCache, clearRobotsCache } = await import('../src/scrape/robots.js');
  primeRobotsCache('https://acme.wd1.myworkdayjobs.com', 'User-agent: *\nAllow: /');
  const m = mockFetch(() => Response.json({ total: 7, jobPostings: [{ title: 'A', externalPath: '/job/x/A_1' }] }));
  try {
    const r = await classifyCareersUrl('Acme', 'https://acme.wd1.myworkdayjobs.com/en-US/External', { sources: {} });
    assert.deepEqual(r.found, [{ ats: 'workday', slug: 'acme', url: 'https://acme.wd1.myworkdayjobs.com/External', jobs: 7, confidence: 'high' }]);
  } finally { m.restore(); clearRobotsCache(); }
});
