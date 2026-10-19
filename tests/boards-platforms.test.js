import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// paths.js reads GAJ_ROOT at import time (importer imports it): set it first.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-platforms-'));
process.env.GAJ_ROOT = ROOT;
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'platforms');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

const wellfound = await import('../src/scrape/boards/wellfound.js');
const cutshort = await import('../src/scrape/boards/cutshort.js');
const instahyre = await import('../src/scrape/boards/instahyre.js');
const alert = await import('../src/scrape/boards/alertEmail.js');
const { importJobs } = await import('../src/scrape/importer.js');

const pick = (jobs) => jobs.map(({ title, company, location }) => ({ title, company, location }));

// ---------- shared helpers ----------
test('stripTracking drops utm/ref/fragment, keeps meaningful params, forces https', () => {
  assert.equal(alert.stripTracking('http://Example.com/a?utm_source=x&id=5&ref=mail#frag'), 'https://example.com/a?id=5');
  assert.equal(alert.stripTracking('mailto:a@b.c'), null);
  assert.equal(alert.stripTracking('not a url'), null);
});

test('unwrapRedirect follows url params (encoded or not), leaves opaque trackers alone', () => {
  assert.equal(alert.unwrapRedirect('https://click.x.com/t?url=https%3A%2F%2Fwellfound.com%2Fjobs%2F1-a'), 'https://wellfound.com/jobs/1-a');
  assert.equal(alert.unwrapRedirect('https://r.x.com/?u=https://cutshort.io/job/A-b-12345678'), 'https://cutshort.io/job/A-b-12345678');
  const opaque = 'https://u123.ct.sendgrid.net/ls/click?upn=abcDEF';
  assert.equal(alert.unwrapRedirect(opaque), opaque);
});

test('emailLines handles markdown links, <url> and HTML anchors', () => {
  const md = alert.emailLines('[UI Engineer](https://wellfound.com/jobs/1-ui) · Pune\nView job <https://x.io/a>.');
  assert.deepEqual(md[0].links, [{ url: 'https://wellfound.com/jobs/1-ui', anchor: 'UI Engineer' }]);
  assert.equal(md[0].text, 'UI Engineer · Pune');
  assert.deepEqual(md[1].links, [{ url: 'https://x.io/a', anchor: null }]);
  const html = alert.emailLines('<p><a href="https://a.io/x?a=1&amp;b=2"><b>Dev</b></a> &middot; Goa</p>');
  assert.deepEqual(html.find((l) => l.links.length).links, [{ url: 'https://a.io/x?a=1&b=2', anchor: 'Dev' }]);
});

test('parseCardLines recognises common card layouts', () => {
  assert.deepEqual(alert.parseCardLines(['New match: Staff Engineer at Acme']), { title: 'Staff Engineer', company: 'Acme', location: '' });
  assert.deepEqual(alert.parseCardLines(['Acme is hiring a Frontend Engineer', 'Pune · 2-4 yrs']), { title: 'Frontend Engineer', company: 'Acme', location: 'Pune' });
  assert.deepEqual(alert.parseCardLines(['Frontend Engineer | Acme | Remote']), { title: 'Frontend Engineer', company: 'Acme', location: 'Remote' });
  assert.deepEqual(alert.parseCardLines(['UI Developer', 'Acme · Bengaluru · ₹20L – ₹30L']), { title: 'UI Developer', company: 'Acme', location: 'Bengaluru' });
  assert.deepEqual(alert.parseCardLines(['Role: SDE 2', 'Company: Acme', 'Location: Noida', 'Salary: 30 LPA']), { title: 'SDE 2', company: 'Acme', location: 'Noida' });
  assert.deepEqual(alert.parseCardLines(['Senior Software Engineer - Frontend', 'Acme']), { title: 'Senior Software Engineer - Frontend', company: 'Acme', location: '' });
  assert.equal(alert.parseCardLines(['Hi Jane,', 'Unsubscribe']).title, '');
});

test('isBoilerplate / looksLikeLocation / unslug', () => {
  for (const s of ['Hi Jane,', 'View job', 'Apply now', 'Unsubscribe from these emails', 'Here are 5 new jobs for you', '3 days ago']) assert.ok(alert.isBoilerplate(s), s);
  for (const s of ['Senior Frontend Engineer', 'Acme Labs']) assert.ok(!alert.isBoilerplate(s), s);
  assert.ok(alert.looksLikeLocation('Bengaluru'));
  assert.ok(alert.looksLikeLocation('Remote (India)'));
  assert.ok(!alert.looksLikeLocation('₹20L – ₹30L'));
  assert.ok(!alert.looksLikeLocation('Acme'));
  assert.equal(alert.unslug('sde-2-react-ui'), 'SDE 2 React UI');
});

// ---------- Wellfound ----------
test('wellfound: no scraper; URL recognition and normalisation', () => {
  assert.equal(wellfound.SCRAPER, false);
  assert.equal(wellfound.fetchJobs, undefined);
  for (const u of [
    'https://wellfound.com/jobs/3123456-senior-frontend-engineer',
    'https://www.wellfound.com/company/acme/jobs/3123456-senior-frontend-engineer/',
    'https://angel.co/company/acme/jobs/99-dev',
    'https://wellfound.com/jobs?jobId=3123456',
  ]) assert.ok(wellfound.isPlatformJobUrl(u), u);
  for (const u of ['https://wellfound.com/jobs', 'https://wellfound.com/company/acme', 'https://evil.com/jobs/1-x', 'ftp://wellfound.com/jobs/1-x', 'nope']) assert.ok(!wellfound.isPlatformJobUrl(u), u);
  assert.equal(wellfound.normalizeJobUrl('http://www.wellfound.com/jobs/3123456-fe/?utm_source=a&utm_medium=email#apply'), 'https://wellfound.com/jobs/3123456-fe');
  assert.equal(wellfound.normalizeJobUrl('https://angel.co/company/acme/jobs/99-dev?ref=x'), 'https://wellfound.com/company/acme/jobs/99-dev');
  assert.equal(wellfound.normalizeJobUrl('https://wellfound.com/jobs?jobId=42&utm_source=x'), 'https://wellfound.com/jobs/42');
  assert.equal(wellfound.normalizeJobUrl('https://t.example.com/c?url=https%3A%2F%2Fwellfound.com%2Fjobs%2F7-ui%3Futm_source%3Dx'), 'https://wellfound.com/jobs/7-ui');
  assert.equal(wellfound.normalizeJobUrl('https://wellfound.com/settings?utm_source=x'), 'https://wellfound.com/settings');
  assert.equal(wellfound.normalizeJobUrl(''), null);
  assert.deepEqual(wellfound.jobFromUrl('https://wellfound.com/company/mango-labs/jobs/1-frontend-developer'), { title: 'Frontend Developer', company: 'Mango Labs' });
  assert.deepEqual(wellfound.jobFromUrl('https://wellfound.com/about'), {});
});

test('wellfound: saved-search digest (plain text)', () => {
  const jobs = wellfound.parseAlertEmail(read('wellfound-digest.txt'));
  assert.deepEqual(pick(jobs), [
    { title: 'Senior Frontend Engineer', company: 'Razorleaf', location: 'Bengaluru' },
    { title: 'Founding Engineer (React / TypeScript)', company: 'Kitebird AI', location: 'Remote (India)' },
    { title: 'Frontend Developer', company: 'Mango Labs', location: 'Bengaluru, Hybrid' },
  ]);
  assert.deepEqual(jobs.map((j) => j.url), [
    'https://wellfound.com/company/razorleaf/jobs/3123456-senior-frontend-engineer',
    'https://wellfound.com/jobs/3129870-founding-engineer-react-typescript',
    'https://wellfound.com/company/mango-labs/jobs/2988001-frontend-developer',
  ]);
});

test('wellfound: single "New match" email with key/value lines', () => {
  assert.deepEqual(wellfound.parseAlertEmail(read('wellfound-match.txt')), [{
    title: 'Staff Frontend Engineer', company: 'Northwind Health', location: 'Remote, India',
    url: 'https://wellfound.com/jobs/3200111-staff-frontend-engineer',
  }]);
});

test('wellfound: HTML digest, anchor titles, duplicate CTA link merged, redirect unwrapped', () => {
  assert.deepEqual(wellfound.parseAlertEmail(read('wellfound-digest.html')), [
    { title: 'UI Engineer', company: 'Quillpad', location: 'Pune', url: 'https://wellfound.com/jobs/3300001-ui-engineer' },
    { title: 'Frontend Engineer II', company: 'Tidewater', location: 'Remote', url: 'https://wellfound.com/jobs/3300002-frontend-engineer-ii' },
  ]);
});

// ---------- Cutshort ----------
test('cutshort: no scraper; URL recognition and normalisation', () => {
  assert.equal(cutshort.SCRAPER, false);
  for (const u of [
    'https://cutshort.io/job/Junior-React-Native-Developer-Pune-toolkraft--Fus3sFOg',
    'https://www.cutshort.io/job/Frontend-Engineer-Plumline-Zx81Kq2w/',
    'https://cutshort.io/vj/Hy7Lm2Qa',
    'https://cutshort.io/view/j/Hy7Lm2Qa',
  ]) assert.ok(cutshort.isPlatformJobUrl(u), u);
  for (const u of ['https://cutshort.io/jobs/react-jobs', 'https://cutshort.io/job/', 'https://cutshort.io/profile/x', 'https://notcutshort.io/job/A-b-12345678']) assert.ok(!cutshort.isPlatformJobUrl(u), u);
  assert.equal(cutshort.normalizeJobUrl('http://www.cutshort.io/job/Frontend-Engineer-Plumline-Zx81Kq2w/?ref=email_alert&utm_source=a'), 'https://cutshort.io/job/Frontend-Engineer-Plumline-Zx81Kq2w');
  assert.equal(cutshort.normalizeJobUrl('https://cutshort.io/jobs?ref=email&page=2'), 'https://cutshort.io/jobs?page=2');
  assert.deepEqual(cutshort.jobFromUrl('https://cutshort.io/job/A-B-12345678'), {});
});

test('cutshort: numbered job-alert email (plain text)', () => {
  const jobs = cutshort.parseAlertEmail(read('cutshort-alert.txt'));
  assert.deepEqual(pick(jobs), [
    { title: 'Senior React Developer', company: 'Fintrail', location: 'Bengaluru' },
    { title: 'Frontend Engineer', company: 'Plumline', location: 'Remote' },
    { title: 'Junior React Native Developer', company: 'Toolkraft', location: 'Pune' },
  ]);
  assert.equal(jobs[2].url, 'https://cutshort.io/job/Junior-React-Native-Developer-Pune-toolkraft--Fus3sFOg');
  assert.ok(jobs.every((j) => !/[?#]/.test(j.url)));
});

test('cutshort: HTML recommendations with anchor titles and short /vj/ links', () => {
  assert.deepEqual(cutshort.parseAlertEmail(read('cutshort-recommend.html')), [
    { title: 'Full Stack Developer', company: 'Ledgerline', location: 'Mumbai', url: 'https://cutshort.io/job/Full-Stack-Developer-Mumbai-Navi-Mumbai-Ledgerline-pQ7rT2uV' },
    { title: 'UI Engineer', company: 'Volt Rides', location: 'Bengaluru (Bangalore)', url: 'https://cutshort.io/vj/Hy7Lm2Qa' },
  ]);
});

// ---------- Instahyre ----------
test('instahyre: no scraper; URL recognition, normalisation and slug parsing', () => {
  assert.equal(instahyre.SCRAPER, false);
  for (const u of [
    'https://www.instahyre.com/job-2464-frontend-developer-at-ninemins-delhi/',
    'https://instahyre.com/job-39-android-developer-at-medlynk-',
    'https://www.instahyre.com/job/447001/senior-software-engineer',
    'https://www.instahyre.com/candidate/opportunities/?matching=true&job_id=447222',
  ]) assert.ok(instahyre.isPlatformJobUrl(u), u);
  for (const u of ['https://www.instahyre.com/candidate/opportunities/', 'https://www.instahyre.com/frontend-jobs/', 'https://www.instahyre.com/jobs-at-testbay/']) assert.ok(!instahyre.isPlatformJobUrl(u), u);
  assert.equal(instahyre.normalizeJobUrl('http://instahyre.com/job-2464-frontend-developer-at-ninemins-delhi?utm_source=email#x'), 'https://www.instahyre.com/job-2464-frontend-developer-at-ninemins-delhi/');
  assert.equal(instahyre.normalizeJobUrl('https://www.instahyre.com/candidate/opportunities/?matching=true&job_id=447222&utm_source=email'), 'https://www.instahyre.com/candidate/opportunities/?job_id=447222');
  assert.equal(instahyre.normalizeJobUrl('https://www.instahyre.com/job/447001/sse?src=mail'), 'https://www.instahyre.com/job/447001/sse');
  assert.deepEqual(instahyre.jobFromUrl('https://www.instahyre.com/job-2464-frontend-developer-at-ninemins-delhi/'), { title: 'Frontend Developer', company: 'Ninemins', location: 'Delhi' });
  assert.deepEqual(instahyre.jobFromUrl('https://www.instahyre.com/job-51-senior-java-server-engineer-at-jungle-arcade-new-delhi/'), { title: 'Senior Java Server Engineer', company: 'Jungle Arcade', location: 'New Delhi' });
  assert.deepEqual(instahyre.jobFromUrl('https://www.instahyre.com/job-39-android-developer-at-medlynk-/'), { title: 'Android Developer', company: 'Medlynk', location: '' });
  assert.deepEqual(instahyre.jobFromUrl('https://www.instahyre.com/candidate/opportunities/?job_id=1'), {});
});

test('instahyre: opportunities email incl. link-before-details card', () => {
  const jobs = instahyre.parseAlertEmail(read('instahyre-opportunities.txt'));
  assert.deepEqual(pick(jobs), [
    { title: 'Frontend Developer', company: 'Ninemins', location: 'Delhi' },
    { title: 'Senior Software Engineer - Frontend', company: 'Testbay', location: 'Pune, Bangalore' },
    { title: 'SDE 2 (React)', company: 'Bazaarly', location: 'Bangalore' },
  ]);
  assert.equal(jobs[2].url, 'https://www.instahyre.com/candidate/opportunities/?job_id=447222');
});

test('instahyre: HTML match email falls back to the URL slug when the card is boilerplate', () => {
  assert.deepEqual(instahyre.parseAlertEmail(read('instahyre-match.html')), [
    { title: 'Android Developer', company: 'Medlynk', location: '', url: 'https://www.instahyre.com/job-39-android-developer-at-medlynk-/' },
    { title: 'Senior Java Server Engineer', company: 'Jungle Arcade', location: 'Delhi', url: 'https://www.instahyre.com/job-51-senior-java-server-engineer-at-jungle-arcade-delhi/' },
  ]);
});

// ---------- cross-cutting ----------
test('parsers ignore other platforms\' links, empty and junk input', () => {
  for (const m of [wellfound, cutshort, instahyre]) {
    assert.deepEqual(m.parseAlertEmail(''), []);
    assert.deepEqual(m.parseAlertEmail(null), []);
    assert.deepEqual(m.parseAlertEmail('Hi,\nnothing here https://example.com/jobs/1-x\nUnsubscribe'), []);
  }
  assert.deepEqual(wellfound.parseAlertEmail(read('cutshort-alert.txt')), []);
  assert.deepEqual(cutshort.parseAlertEmail(read('instahyre-opportunities.txt')), []);
});

test('parsed entries are valid jobs:import input', () => {
  const entries = [
    ...wellfound.parseAlertEmail(read('wellfound-digest.txt')),
    ...cutshort.parseAlertEmail(read('cutshort-alert.txt')),
    ...instahyre.parseAlertEmail(read('instahyre-opportunities.txt')),
  ];
  const res = importJobs(entries, { source: 'manual' });
  assert.equal(res.errors.length, 0);
  assert.equal(res.jobs.length, entries.length);
});
