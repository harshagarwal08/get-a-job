import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractJsonLd, ldToFields, detectEmbeddedAts, findLinks, isJobDetailUrl, mainContentText, pageTitle, registrableDomain, sameSite, parseAnchor,
} from '../src/scrape/careers/extract.js';
import { createFetcher, robotsRulesFor } from '../src/scrape/careers/fetcher.js';
import { createRenderer } from '../src/scrape/careers/render.js';
import { startProxy } from '../src/scrape/careers/proxy.js';
import http from 'node:http';
import net from 'node:net';
import * as careers from '../src/scrape/sources/careers.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'careers');
const fx = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const ACME = { name: 'Acme', slug: 'acme', url: 'https://careers.acme.example.com/en/' };

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

/** Fake fetch over a route table {url: html | {status, body, headers}}; records requested URLs. */
function mockNet(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    let r = routes[url];
    if (r === undefined && url.endsWith('/robots.txt')) r = { status: 404, body: '' };
    if (r === undefined) r = { status: 404, body: 'not found' };
    if (typeof r === 'string') r = { status: 200, body: r };
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) } });
  };
  return { calls, deps: { fetchImpl, lookup: publicLookup, gapMs: 0, launch: async () => { throw new Error('no browser in tests'); } } };
}

// ---------- JSON-LD ----------
test('extractJsonLd finds postings in @graph and arrays, tolerates raw newlines', () => {
  const { postings } = extractJsonLd(fx('jsonld-graph.html'));
  assert.deepEqual(postings.map((p) => p.title), ['Senior Frontend Engineer', 'Backend Engineer', 'Old Role']);
  const f = ldToFields(postings[0], 'https://acme.example.com/careers');
  assert.equal(f.location, 'Bengaluru, Karnataka, India');
  assert.equal(f.url, 'https://acme.example.com/jobs/senior-frontend-engineer-123');
  assert.equal(f.sourceId, '123');
  assert.equal(f.description, 'Build & ship UI.\n\n- React');
  assert.deepEqual(f.salary, { min: 3000000, max: 4500000, currency: 'INR', unit: 'YEAR' });
  const remote = ldToFields(postings[1]);
  assert.equal(remote.location, 'Remote (India)');
  assert.equal(remote.workModeField, 'remote');
});

test('extractJsonLd handles ItemList of JobPosting and bare ListItem urls', () => {
  const { postings, listUrls } = extractJsonLd(fx('jsonld-itemlist.html'));
  assert.equal(postings.length, 1);
  const f = ldToFields(postings[0], 'https://acme.example.com/careers');
  assert.equal(f.location, 'Pune, India');
  assert.deepEqual(f.locations, ['Mumbai, IN']);
  assert.deepEqual(listUrls, ['https://acme.example.com/jobs/ml-engineer-77']);
});

test('normalize maps JSON-LD to NormalizedJob with source careers', () => {
  const { postings } = extractJsonLd(fx('jsonld-graph.html'));
  const [j] = careers.normalize([postings[0]], { name: 'Acme' }, { pageUrl: 'https://acme.example.com/careers' });
  assert.equal(j.source, 'careers');
  assert.equal(j.company, 'Acme');
  assert.deepEqual(j.countries, ['IN']);
  assert.deepEqual(j.salary, { min: 3000000, max: 4500000, currency: 'INR', unit: 'year' });
  assert.equal(j.postedAt, '2026-10-01T00:00:00.000Z');
  assert.match(j.key, /^acme--senior-frontend-engineer--[0-9a-f]{6}$/);
});

// ---------- embedded ATS ----------
test('detectEmbeddedAts picks the most-referenced supported board', () => {
  const found = detectEmbeddedAts(fx('embedded-ats.html'));
  assert.deepEqual([found[0].ats, found[0].slug], ['greenhouse', 'acmeinc']);
  assert.ok(found[0].hits > found.find((f) => f.ats === 'lever').hits);
  assert.ok(!found.some((f) => f.ats === 'workable'), 'bare apply.workable.com is not a board');
});

test('detectEmbeddedAts recognises ashby/recruitee/workable/smartrecruiters/eu greenhouse', () => {
  const found = detectEmbeddedAts(fx('embedded-variants.html'));
  assert.deepEqual(found[0], { ats: 'ashby', slug: 'acme-labs', hits: 2 });
  const pairs = found.map((f) => `${f.ats}/${f.slug}`);
  for (const p of ['recruitee/acme', 'workable/acme-co', 'smartrecruiters/AcmeCorp1', 'greenhouse/acme-eu']) assert.ok(pairs.includes(p), p);
});

// ---------- links ----------
test('findLinks: detail heuristics, same-site filter, base href, dedupe, card parsing', () => {
  const { jobs, listings } = findLinks(fx('listing-links.html'), 'https://careers.acme.example.com/en/');
  const byUrl = Object.fromEntries(jobs.map((j) => [j.url, j]));
  assert.deepEqual(Object.keys(byUrl).sort(), [
    'https://acme.example.com/positions/4242',
    'https://careers.acme.example.com/apply?gh_jid=5555',
    'https://careers.acme.example.com/en/jobs/1002-backend-engineer?utm=x',
    'https://careers.acme.example.com/jobs/1001-senior-frontend-engineer',
    'https://www.acme.example.com/careers/product-designer-ii',
  ]);
  const fe = byUrl['https://careers.acme.example.com/jobs/1001-senior-frontend-engineer'];
  assert.equal(fe.title, 'Senior Frontend Engineer');
  assert.equal(fe.location, 'Bengaluru, India');
  assert.equal(byUrl['https://www.acme.example.com/careers/product-designer-ii'].location, 'Remote');
  assert.ok(!jobs.some((j) => j.url.includes('evil.example.org')));
  assert.ok(listings.includes('https://careers.acme.example.com/en/open-positions'));
  assert.ok(listings.includes('https://careers.acme.example.com/jobs'));
});

test('isJobDetailUrl', () => {
  for (const u of ['https://x.com/jobs/123', 'https://x.com/careers/senior-engineer', 'https://x.com/job/abc', 'https://x.com/openings/frontend-dev',
    'https://x.com/role/staff-sre', 'https://x.com/careers?gh_jid=42', 'https://jobs.x.com/senior-engineer-12345', 'https://x.com/en/jobs/abc/apply']) {
    assert.ok(isJobDetailUrl(u), u);
  }
  for (const u of ['https://x.com/jobs', 'https://x.com/jobs/', 'https://x.com/careers/teams', 'https://x.com/careers/engineering', 'https://x.com/careers/life-at-x',
    'https://x.com/jobs/search', 'https://x.com/about', 'https://x.com/careers/benefits', 'https://x.com/jobs/team/engineering']) {
    assert.ok(!isJobDetailUrl(u), u);
  }
});

test('parseAnchor skips department/employment-type segments for the title', () => {
  const a = parseAnchor('<span>Engineering</span><b>Full-time</b><h4>Staff Software Engineer</h4><i>Mumbai</i>');
  assert.equal(a.title, 'Staff Software Engineer');
  assert.equal(a.location, 'Mumbai');
});

test('registrableDomain / sameSite', () => {
  assert.equal(registrableDomain('careers.swiggy.in'), 'swiggy.in');
  assert.equal(registrableDomain('jobs.acme.co.in'), 'acme.co.in');
  assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk');
  assert.ok(sameSite('https://careers.acme.com/x', 'https://www.acme.com/y'));
  assert.ok(!sameSite('https://acme.com.evil.io/x', 'https://acme.com/y'));
});

// ---------- main content ----------
test('mainContentText strips nav/header/footer/form/script; pageTitle prefers h1', () => {
  const t = mainContentText(fx('detail-plain.html'));
  assert.equal(t, 'Senior Frontend Engineer\n\nWe are looking for a frontend engineer to build our design system.\n\n- 5+ years React\n- TypeScript');
  assert.equal(pageTitle(fx('detail-plain.html')), 'Senior Frontend Engineer');
  assert.equal(pageTitle('<title>Data Engineer | Acme</title>'), 'Data Engineer');
});

// ---------- crawl pipeline (mock network) ----------
const LISTING = 'https://careers.acme.example.com/en/';
function linkRoutes() {
  return {
    [LISTING]: fx('listing-links.html'),
    'https://careers.acme.example.com/jobs/1001-senior-frontend-engineer': fx('detail-plain.html'),
    'https://careers.acme.example.com/en/jobs/1002-backend-engineer?utm=x': '<html><main><h1>Backend Engineer</h1><p>' + 'Go services. '.repeat(40) + '</p></main></html>',
    'https://www.acme.example.com/careers/product-designer-ii': '<script type="application/ld+json">{"@type":"JobPosting","title":"Product Designer II","description":"Design","jobLocationType":"TELECOMMUTE"}</script>',
    'https://acme.example.com/positions/4242': '<html><main><h1>Support Specialist</h1><p>' + 'Help customers. '.repeat(30) + '</p></main></html>',
    'https://careers.acme.example.com/apply?gh_jid=5555': '<html><main><h1>Data Analyst</h1><p>' + 'SQL. '.repeat(80) + '</p></main></html>',
  };
}

test('fetchJobs via job links fetches details (JSON-LD or main text)', async () => {
  const { deps } = mockNet(linkRoutes());
  const jobs = await careers.fetchJobs(ACME, { deps, render: false });
  const t = Object.fromEntries(jobs.map((j) => [j.title, j]));
  assert.equal(jobs.length, 5);
  assert.equal(t['Senior Frontend Engineer'].location, 'Bengaluru, India');
  assert.match(t['Senior Frontend Engineer'].description, /design system/);
  assert.equal(t['Product Designer II'].workMode, 'remote');
  assert.equal(t['Product Designer II'].description, 'Design');
  assert.ok(jobs.every((j) => j.source === 'careers'));
});

test('detail fetches are capped and pre-filtered by track titles', async () => {
  const net = mockNet(linkRoutes());
  const tracks = [{ id: 'fe', titles: ['Frontend Engineer'] }];
  const jobs = await careers.fetchJobs(ACME, { deps: net.deps, render: false, tracks });
  const details = net.calls.filter((u) => !u.endsWith('robots.txt') && u !== LISTING);
  assert.deepEqual(details, ['https://careers.acme.example.com/jobs/1001-senior-frontend-engineer']);
  assert.equal(jobs.length, 4, 'non-matching titled links are still listed, without description');
  assert.equal(jobs.find((j) => j.title === 'Backend Engineer').description, '');

  const net2 = mockNet(linkRoutes());
  await careers.fetchJobs(ACME, { deps: net2.deps, render: false, detailCap: 2 });
  assert.equal(net2.calls.filter((u) => !u.endsWith('robots.txt') && u !== LISTING).length, 2);
});

test('DETAIL_CAP defaults to 25 detail pages', async () => {
  const items = Array.from({ length: 40 }, (_, i) => `<a href="/jobs/${1000 + i}-software-engineer">Software Engineer ${i}</a>`).join('');
  const routes = { [LISTING]: `<html><body>${items}</body></html>` };
  const net = mockNet(routes);
  const r = await careers.crawl(LISTING, { deps: net.deps, render: false });
  assert.equal(careers.DETAIL_CAP, 25);
  assert.equal(r.method, 'links');
  assert.equal(r.stats.detailFetches, 25);
  assert.equal(r.records.length, 40);
});

test('JSON-LD on the listing wins; expired postings dropped', async () => {
  const net = mockNet({ 'https://acme.example.com/careers': fx('jsonld-graph.html') });
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: net.deps, render: false });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'jsonld');
  assert.equal(r.jobs, 2);
  assert.deepEqual(r.sample, ['Senior Frontend Engineer', 'Backend Engineer']);
});

test('embedded ATS: checkCareers reports it, fetchJobs delegates to that source', async () => {
  const net = mockNet({ 'https://acme.example.com/careers': fx('embedded-ats.html') });
  const seen = [];
  const fakeGh = { fetchJobs: async (c) => { seen.push(c); return [{ title: 'Frontend Engineer', source: 'greenhouse' }]; } };
  const deps = { ...net.deps, sources: { greenhouse: fakeGh } };
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps, render: false });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'embedded-ats');
  assert.deepEqual(r.embeddedAts, { ats: 'greenhouse', slug: 'acmeinc', jobs: 1, ok: true });
  const told = [];
  const jobs = await careers.fetchJobs({ name: 'Acme', slug: 'acme', url: 'https://acme.example.com/careers' }, { deps, render: false, onEmbeddedAts: (i) => told.push(i) });
  assert.equal(jobs[0].source, 'careers', 'expiry stays keyed to the careers entry');
  assert.equal(jobs[0].via, 'greenhouse');
  assert.deepEqual(jobs.meta.delegatedTo, { ats: 'greenhouse', slug: 'acmeinc' });
  assert.ok(!Object.keys(jobs).includes('meta'), 'meta is non-enumerable');
  assert.deepEqual(told, [{ company: 'Acme', ats: 'greenhouse', slug: 'acmeinc' }]);
  assert.equal(seen.at(-1).slug, 'acmeinc');
  assert.equal(seen.at(-1).ats, 'greenhouse');
});

test('follows one listing link when the landing page has no jobs', async () => {
  const routes = {
    'https://acme.example.com/careers': '<a href="/careers/life">Life</a><a href="/careers/open-roles">See all open roles</a>',
    'https://acme.example.com/careers/open-roles': fx('spa-rendered.html'),
  };
  const net = mockNet(routes);
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: net.deps, render: false, detailCap: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.sample, ['Frontend Engineer', 'Site Reliability Engineer']);
});

test('headless fallback renders JS-only listing once and repeats steps 1-3', async () => {
  const routes = { 'https://acme.example.com/careers': fx('spa-shell.html') };
  const net = mockNet(routes);
  let renders = 0;
  const launch = async () => fakeBrowser(async (url) => { renders++; return url.endsWith('/careers') ? fx('spa-rendered.html') : '<html><main><h1>X</h1></main></html>'; });
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: { ...net.deps, launch }, detailCap: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.method, 'headless+links');
  assert.equal(r.jobs, 2);
  assert.equal(renders, 1);
  assert.deepEqual(r.results.map((j) => j.location), ['Pune, India', 'Remote']);
});

test('robots.txt disallow stops the crawl', async () => {
  const net = mockNet({ 'https://acme.example.com/robots.txt': 'User-agent: *\nDisallow: /careers', 'https://acme.example.com/careers': fx('jsonld-graph.html') });
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: net.deps, render: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /robots/);
  assert.ok(!net.calls.includes('https://acme.example.com/careers'));
});

test('robots disallow on a followed listing link is skipped, not fatal', async () => {
  const net = mockNet({
    'https://acme.example.com/robots.txt': 'User-agent: *\nDisallow: /search',
    'https://acme.example.com/careers': '<a href="/search-jobs?q=x">Search jobs</a>',
  });
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: net.deps, render: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /rendering is disabled/);
  assert.ok(r.notes.some((n) => /robots/.test(n)));
});

test('private addresses are refused', async () => {
  const net = mockNet({});
  const deps = { ...net.deps, lookup: async () => [{ address: '10.0.0.5', family: 4 }] };
  const r = await careers.checkCareers('https://intranet.example.com/careers', { deps });
  assert.equal(r.ok, false);
  assert.match(r.error, /private|local/);
  assert.equal(net.calls.length, 0);
  await assert.rejects(careers.fetchJobs({ name: 'X', slug: 'x', url: 'http://x.example.com/careers' }, { deps }), /https/);
});

test('fetcher waits >=1s between requests to the same host and respects the deadline', async () => {
  let clock = 0;
  const waits = [];
  const net = mockNet({ 'https://a.example.com/1': 'x', 'https://a.example.com/2': 'y', 'https://b.example.com/1': 'z' });
  const f = createFetcher({ ...net.deps, gapMs: 1000, now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; }, timeoutMs: 5000 });
  await f.get('https://a.example.com/1'); // robots + page => one wait
  await f.get('https://a.example.com/2');
  await f.get('https://b.example.com/1');
  assert.deepEqual(waits, [1000, 1000, 1000]);
  clock = 10_000;
  await assert.rejects(f.get('https://a.example.com/1'), /time budget/);
});

test('renderer aborts private/loopback and image requests, checks robots first', async () => {
  const handled = [];
  const net = mockNet({});
  const lookup = async (h) => [{ address: h === 'internal.example.com' ? '127.0.0.1' : '93.184.216.34', family: 4 }];
  const fetcher = createFetcher({ ...net.deps, lookup });
  const launch = async () => fakeBrowser(async () => '<html></html>', [
    { url: 'https://acme.example.com/app.js', type: 'script' },
    { url: 'http://internal.example.com/admin', type: 'xhr' },
    { url: 'http://127.0.0.1:8080/x', type: 'fetch' },
    { url: 'https://cdn.example.com/a.png', type: 'image' },
    { url: 'file:///etc/passwd', type: 'xhr' },
  ], handled);
  const r = createRenderer({ fetcher, launch, lookup });
  await r.render('https://acme.example.com/careers');
  await r.close();
  assert.deepEqual(handled.sort(), [
    'continue https://acme.example.com/app.js', 'abort http://internal.example.com/admin', 'abort http://127.0.0.1:8080/x',
    'abort https://cdn.example.com/a.png', 'abort file:///etc/passwd',
  ].sort());
  await assert.rejects(createRenderer({ fetcher, launch, lookup }).render('https://internal.example.com/careers'), /private|local/);
});

test('fetchOne parses a JSON-LD detail page', async () => {
  const net = mockNet({ 'https://acme.example.com/jobs/1': fx('jsonld-graph.html') });
  const j = await careers.fetchOne('https://acme.example.com/jobs/1', { deps: net.deps, render: false });
  assert.equal(j.title, 'Senior Frontend Engineer');
  assert.equal(j.company, 'Acme');
});

// ---------- failure semantics (no empty successes) ----------
test('fetchJobs throws when the start URL fails (5xx / robots / rendering unavailable)', async () => {
  const c = { name: 'Acme', slug: 'acme', url: 'https://acme.example.com/careers' };
  const five = mockNet({ 'https://acme.example.com/careers': { status: 503, body: 'down' } });
  await assert.rejects(careers.fetchJobs(c, { deps: five.deps, render: false }), /could not fetch .*503/);
  await assert.rejects(careers.fetchJobs(c, { deps: five.deps }), /could not fetch .*503/, 'render fallback failing too');
  const robots = mockNet({ 'https://acme.example.com/robots.txt': 'User-agent: *\nDisallow: /' });
  await assert.rejects(careers.fetchJobs(c, { deps: robots.deps }), /robots/);
  const shell = mockNet({ 'https://acme.example.com/careers': fx('spa-shell.html') });
  await assert.rejects(careers.fetchJobs(c, { deps: shell.deps }), /headless rendering failed: no browser/);
  await assert.rejects(careers.fetchJobs(c, { deps: shell.deps, render: false }), /rendering is disabled/);
  const ok = mockNet({ 'https://acme.example.com/careers': fx('spa-shell.html') });
  const launch = async () => fakeBrowser(async () => '<html><body>We have no openings right now.</body></html>');
  await assert.rejects(careers.fetchJobs(c, { deps: { ...ok.deps, launch } }), /no jobs found .*not expired/, 'zero jobs is treated as a failed crawl');
  const fine = await careers.fetchJobs(c, { deps: { ...ok.deps, launch: async () => fakeBrowser(async () => fx('spa-rendered.html')) }, detailCap: 0 });
  assert.equal(fine.length, 2);
  assert.deepEqual(fine.meta, { method: 'links', rendered: true, delegatedTo: null, notes: [] });
});

test('time budget: chosen-but-unfetched detail links are kept as plain link records', async () => {
  let clock = 0;
  const routes = linkRoutes();
  const net = mockNet(routes);
  const deps = { ...net.deps, gapMs: 1000, now: () => clock, sleep: async (ms) => { clock += ms; }, timeoutMs: 3500, hostSlots: new Map() };
  const r = await careers.crawl(LISTING, { deps, render: false });
  assert.equal(r.method, 'links');
  // all 4 titled links survive (the untitled id-only link needs its detail page for a title)
  assert.equal(r.records.length, 4);
  assert.ok(r.stats.detailFetches < 5, 'budget cut the detail loop short');
  assert.ok(r.records.filter((x) => !x.description).length >= 2);
  assert.ok(r.notes.some((n) => /time budget/.test(n)));
});

test('robots.txt: 4xx = allow, 5xx/network = disallow all (RFC 9309)', async () => {
  assert.deepEqual(robotsRulesFor({ error: { status: 404 } }), []);
  assert.deepEqual(robotsRulesFor({ error: { status: 503 } }), [{ allow: false, path: '/' }]);
  assert.deepEqual(robotsRulesFor({ error: new Error('ECONNRESET') }), [{ allow: false, path: '/' }]);
  const net = mockNet({ 'https://acme.example.com/robots.txt': { status: 500, body: '' }, 'https://acme.example.com/careers': fx('jsonld-graph.html') });
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: net.deps, render: false });
  assert.equal(r.ok, false);
  assert.match(r.error, /robots/);
});

test('listing JSON-LD urls must be same-site, else the listing url is used', async () => {
  const html = '<script type="application/ld+json">[{"@type":"JobPosting","title":"Frontend Engineer","url":"https://evil.example.org/x"},{"@type":"JobPosting","title":"Backend Engineer","url":"https://jobs.acme.example.com/9"}]</script>';
  const net = mockNet({ 'https://acme.example.com/careers': html });
  const r = await careers.checkCareers('https://acme.example.com/careers', { deps: net.deps, render: false });
  assert.deepEqual(r.results.map((j) => j.url), ['https://acme.example.com/careers', 'https://jobs.acme.example.com/9']);
});

test('per-host gap is shared across concurrent fetchers and applied on redirect hops', async () => {
  let clock = 0;
  const waits = [];
  const hostSlots = new Map();
  const routes = {
    'https://s.example.com/robots.txt': { status: 404, body: '' },
    'https://s.example.com/a': 'a', 'https://s.example.com/b': 'b',
    'https://s.example.com/r': { status: 302, body: '', headers: { location: '/a' } },
  };
  const net = mockNet(routes);
  const mk = () => createFetcher({ ...net.deps, gapMs: 1000, now: () => clock, sleep: async (ms) => { waits.push(ms); }, timeoutMs: 60_000, hostSlots });
  const f1 = mk();
  const f2 = mk();
  await Promise.all([f1.get('https://s.example.com/a'), f2.get('https://s.example.com/b')]);
  // robots(f1)@0, robots(f2)@1000, page a@2000, page b@3000 — all reserved on one shared timeline
  assert.deepEqual(waits.sort((x, y) => x - y), [1000, 2000, 3000]);
  waits.length = 0;
  hostSlots.clear();
  await mk().get('https://s.example.com/r'); // robots, /r, then the redirect hop to /a
  assert.deepEqual(waits, [1000, 2000]);
});

test('renders are serialized across crawls (one page in Chrome at a time)', async () => {
  let open = 0;
  let maxOpen = 0;
  const net = mockNet({});
  const content = async () => { open++; maxOpen = Math.max(maxOpen, open); await new Promise((r) => setTimeout(r, 20)); open--; return '<html></html>'; };
  const mkR = () => createRenderer({ fetcher: createFetcher(net.deps), lookup: publicLookup, launch: async () => fakeBrowser(content) });
  const a = mkR();
  const b = mkR();
  await Promise.all([a.render('https://x.example.com/1'), b.render('https://y.example.com/2'), a.render('https://x.example.com/3')]);
  await a.close();
  await b.close();
  assert.equal(maxOpen, 1);
});

// ---------- proxy (hermetic: upstream "public" hosts are redirected to local servers via dial) ----------
function connectVia(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: target });
    req.on('connect', (res, sock) => { sock.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
}

test('proxy refuses loopback/private/rebinding targets and tunnels only to the checked IP', async () => {
  let hits = 0;
  const sink = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const sinkPort = sink.address().port;
  const lookup = async (h) => [{ address: h === 'rebind.test' ? '127.0.0.1' : h === 'mapped.test' ? '::ffff:10.0.0.1' : '93.184.216.34', family: 4 }];
  const dialed = [];
  const proxy = await startProxy({ lookup, dial: (ip, port) => { dialed.push(`${ip}:${port}`); return net.connect({ host: '127.0.0.1', port: sinkPort }); } });
  try {
    for (const t of [`127.0.0.1:${sinkPort}`, `localhost:${sinkPort}`, `rebind.test:${sinkPort}`, `mapped.test:443`, `[::1]:${sinkPort}`, '10.1.2.3:80', '169.254.169.254:80']) {
      assert.equal(await connectVia(proxy.port, t), 403, t);
    }
    assert.equal(hits, 0);
    assert.deepEqual(dialed, []);
    assert.equal(await connectVia(proxy.port, 'public.test:443'), 200);
    assert.deepEqual(dialed, ['93.184.216.34:443'], 'connects to the IP it checked');
  } finally {
    await proxy.close();
    await new Promise((r) => sink.close(r));
  }
});

test('rendered page cannot reach a local WebSocket server (real Chrome; skipped if unavailable)', { timeout: 60_000 }, async (t) => {
  const puppeteer = (await import('puppeteer')).default;
  const { executableCandidates } = await import('../src/resume/browser.js');
  const exe = executableCandidates(puppeteer)[0];
  if (!exe) { t.skip('no Chrome'); return; }
  // local "victim": any TCP connection (WebSocket upgrade or otherwise) counts as a hit
  let hits = 0;
  const victim = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => victim.listen(0, '127.0.0.1', r));
  const wsPort = victim.address().port;
  // the "public" page, reached only through the proxy (dial redirects page.test -> this server)
  const page = `<html><body><div id="r">x</div><script>
    const tries = [];
    try { new WebSocket('ws://127.0.0.1:${wsPort}/'); tries.push('ws-api'); } catch (e) { tries.push('no-ws-api'); }
    try { new (window.RTCPeerConnection || Object)(); } catch (e) {}
    fetch('http://127.0.0.1:${wsPort}/').catch(() => {});
    fetch('http://localhost:${wsPort}/').catch(() => {});
    const f = document.createElement('iframe'); f.srcdoc = '<script>try{new parent.WebSocket("ws://127.0.0.1:${wsPort}")}catch(e){}<\/script>'; document.body.appendChild(f);
    document.getElementById('r').textContent = tries.join(',');
  </script></body></html>`;
  const origin = http.createServer((req, res) => { res.writeHead(req.url === '/robots.txt' ? 404 : 200, { 'content-type': 'text/html' }); res.end(req.url === '/robots.txt' ? '' : page); });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;
  const lookup = async (h) => [{ address: h === 'page.test' ? '93.184.216.34' : h === 'localhost' ? '127.0.0.1' : '93.184.216.35', family: 4 }];
  const dial = (ip, port) => net.connect({ host: '127.0.0.1', port: ip === '93.184.216.34' ? originPort : 9 });
  const fetcher = createFetcher({ fetchImpl: async () => new Response('', { status: 404 }), lookup, gapMs: 0 });
  const r = createRenderer({ fetcher, lookup, dial });
  try {
    const out = await r.render(`http://page.test:${originPort}/careers`);
    assert.match(out.html, /no-ws-api/, 'WebSocket API removed before page scripts');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(hits, 0, 'local server must not receive any connection');
  } finally {
    await r.close();
    await new Promise((res) => origin.close(res));
    await new Promise((res) => victim.close(res));
  }
});

// fake puppeteer browser: content(url) => html; requests are fired through the interception handler on goto
function fakeBrowser(content, requests = [], log = []) {
  return {
    async newPage() {
      let handler = null;
      let current = 'about:blank';
      const frame = {};
      const page = {
        async setUserAgent() {}, async setRequestInterception() {}, async evaluateOnNewDocument() {}, async setBypassServiceWorker() {},
        on(ev, h) { if (ev === 'request') handler = h; },
        mainFrame: () => frame,
        url: () => current,
        async goto(url) {
          current = url;
          const reqs = [{ url, type: 'document', nav: true }, ...requests];
          await Promise.all(reqs.map((q) => new Promise((resolve) => {
            const done = (what) => { if (!q.nav) log.push(`${what} ${q.url}`); resolve(); };
            handler({
              url: () => q.url, resourceType: () => q.type, isNavigationRequest: () => !!q.nav, frame: () => frame,
              isInterceptResolutionHandled: () => false, continue: () => done('continue'), abort: () => done('abort'),
            });
          })));
        },
        async content() { return content(current); },
        async close() {},
      };
      return page;
    },
    async close() {},
  };
}
