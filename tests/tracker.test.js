import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracker');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-tracker-'));
process.env.GAJ_ROOT = ROOT; // must be set before paths.js is imported

let mod, exp, stats, cli, demo;
before(async () => {
  mod = await import('../src/tracker/store.js');
  exp = await import('../src/tracker/export.js');
  stats = await import('../src/tracker/stats.js');
  cli = await import('../src/tracker/cli.js');
  demo = await import('../src/tracker/demo.js');
});

const freshStore = () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 's-'));
  return mod.createStore({ root: dir, trackerFile: path.join(dir, 'data', 'tracker.json'), jobsFile: path.join(dir, 'data', 'jobs.json') });
};

test('default store resolves to GAJ_ROOT', () => {
  assert.equal(mod.store().trackerFile, path.join(ROOT, 'data', 'tracker.json'));
});

test('add creates file, id format, defaults and history', () => {
  const s = freshStore();
  assert.deepEqual(s.list(), []);
  const a = s.add({ company: 'Acme', role: 'FE', fit: { score: 72 } });
  assert.match(a.id, /^app_[0-9a-f]{8}$/);
  assert.equal(a.status, 'drafted');
  assert.equal(a.channel, 'ats');
  assert.deepEqual(a.fit, { score: 72, verdict: 'Good' });
  assert.equal(a.history.length, 1);
  assert.equal(a.history[0].status, 'drafted');
  assert.equal(a.appliedAt, null);
  const disk = JSON.parse(fs.readFileSync(s.trackerFile, 'utf8'));
  assert.equal(disk.version, 1);
  assert.equal(disk.applications[0].id, a.id);
});

test('update appends history on status change, sets appliedAt once', () => {
  const s = freshStore();
  const a = s.add({ company: 'Acme', role: 'FE' });
  const u1 = s.update(a.id, { status: 'applied' }, { note: 'sent' });
  assert.equal(u1.history.length, 2);
  assert.deepEqual([u1.history[1].status, u1.history[1].note], ['applied', 'sent']);
  assert.ok(u1.appliedAt);
  const firstApplied = u1.appliedAt;
  const u2 = s.update(a.id, { status: 'applied', nextAction: 'Ping' });
  assert.equal(u2.history.length, 2, 'same status: no new entry');
  const u3 = s.update(a.id, { status: 'screening' });
  assert.equal(u3.appliedAt, firstApplied);
  const u4 = s.update(a.id.slice(0, 8), {}, { note: 'just a note' });
  assert.equal(u4.history.at(-1).status, 'screening');
  assert.equal(u4.history.at(-1).note, 'just a note');
  s.remove(a.id);
  assert.throws(() => s.get(a.id), /not found/);
});

test('add with applied status sets appliedAt', () => {
  const s = freshStore();
  assert.ok(s.add({ company: 'A', role: 'B', status: 'applied' }).appliedAt);
});

test('validation rejects bad enums, dates, fields', () => {
  const s = freshStore();
  assert.throws(() => s.add({ role: 'x' }), /required/);
  assert.throws(() => s.add({ company: 'A', role: 'B', status: 'nope' }), /status/);
  assert.throws(() => s.add({ company: 'A', role: 'B', channel: 'fax' }), /channel/);
  assert.throws(() => s.add({ company: 'A', role: 'B', deadline: '2026-02-30' }), /deadline/);
  assert.throws(() => s.add({ company: 'A', role: 'B', nextActionDate: '12/01/2026' }), /nextActionDate/);
  assert.throws(() => s.add({ company: 'A', role: 'B', fit: { score: 140 } }), /fit.score/);
  assert.throws(() => s.add({ company: 'A', role: 'B', fit: { score: 50, verdict: 'Meh' } }), /verdict/);
  assert.throws(() => s.add({ company: 'A', role: 'B', url: 'javascript:alert(1)' }), /url/);
  assert.throws(() => s.add({ company: 'A', role: 'B', id: 'app_x' }), /unknown field/);
  const a = s.add({ company: 'A', role: 'B', deadline: '2026-11-01', workMode: 'remote' });
  assert.throws(() => s.update(a.id, { history: [] }), /unknown field/);
  assert.equal(s.update(a.id, { deadline: '' }).deadline, null);
  assert.equal(s.update(a.id, { appliedAt: '2026-10-01' }).appliedAt, '2026-10-01T00:00:00.000Z');
});

test('--field parsing', () => {
  assert.deepEqual(cli.parseFields(['salary=INR 40L', 'fit.score=80', 'fit.verdict=strong', 'contact=null']),
    { salary: 'INR 40L', fit: { score: '80', verdict: 'strong' }, contact: null });
  assert.throws(() => cli.parseFields(['bogus=1']), /unknown field/);
  assert.throws(() => cli.parseFields(['novalue']), /key=value/);
  const s = freshStore();
  const a = s.add({ company: 'A', role: 'B' });
  assert.deepEqual(s.update(a.id, cli.parseFields(['fit.score=80', 'fit.verdict=strong'])).fit, { score: 80, verdict: 'Strong' });
});

test('jobs: list without description, status-only update, trackJob', () => {
  const s = freshStore();
  fs.mkdirSync(path.dirname(s.jobsFile), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'jobs.json'), s.jobsFile);
  const before = JSON.parse(fs.readFileSync(s.jobsFile, 'utf8'));
  const list = s.listJobs();
  assert.equal(list.length, 20);
  assert.ok(list.every((j) => !('description' in j)));
  const key = list.find((j) => j.status === 'ranked').key;
  assert.ok(s.getJob(key).description);
  s.setJobStatus(key, 'skipped');
  const after = JSON.parse(fs.readFileSync(s.jobsFile, 'utf8'));
  assert.equal(after.jobs[key].status, 'skipped');
  after.jobs[key].status = before.jobs[key].status;
  assert.deepEqual(after, before, 'only the status field changed');
  assert.throws(() => s.setJobStatus(key, 'deleted'), /job status/);
  const app = s.trackJob(key);
  assert.equal(app.jobKey, key);
  assert.equal(app.status, 'saved');
  assert.equal(app.fit.score, before.jobs[key].rank.score);
  assert.equal(s.getJob(key).status, 'tracked');
  assert.throws(() => s.trackJob(key), /already tracked/);
});

test('CSV: RFC 4180 quoting and formula-injection guard', () => {
  const apps = [{ company: 'Acme, Inc', role: 'He said "hi"', notes: 'line1\nline2', contact: '=HYPERLINK("x")', salary: '+91', location: '@home', track: '-fe', status: 'applied', fit: { score: 70, verdict: 'Good' } }];
  const csv = exp.toCSV(apps);
  assert.ok(csv.endsWith('\r\n'));
  const lines = csv.split('\r\n');
  assert.equal(lines[0].split(',').length, exp.COLUMNS.length);
  assert.ok(csv.includes('"Acme, Inc"'));
  assert.ok(csv.includes('"He said ""hi"""'));
  assert.ok(csv.includes('"line1\nline2"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes("'+91"));
  assert.ok(csv.includes("'@home"));
  assert.ok(csv.includes("'-fe"));
  assert.ok(csv.includes(',70,Good,'), 'numbers unguarded');
  assert.equal(exp.guardFormula(-5), -5);
  assert.equal(exp.guardFormula('- note'), '- note');
  assert.equal(exp.guardFormula('-5'), '-5');
  assert.equal(exp.guardFormula('-cmd'), "'-cmd");
  assert.equal(exp.guardFormula('\tx'), "'\tx");
});

test('TSV for Google Sheets', () => {
  const tsv = exp.toTSV([{ company: 'A\tB', role: 'R', notes: 'x\ny', contact: '=1+1', status: 'saved' }]);
  const [head, row] = tsv.split('\n');
  assert.equal(head.split('\t').length, exp.COLUMNS.length);
  assert.ok(row.startsWith('A B\tR\t'));
  assert.ok(tsv.includes('"x\ny"'));
  assert.ok(tsv.includes("'=1+1"));
});

test('XLSX export produces a workbook', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'tracker.json'), 'utf8'));
  const buf = await exp.toXLSX(fixture.applications);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Applications');
  assert.equal(ws.rowCount, fixture.applications.length + 1);
  assert.equal(ws.getRow(1).getCell(1).value, 'Company');
});

test('stats: furthest stage, funnel, response rate, weekly', () => {
  const now = new Date('2026-10-16T10:00:00.000Z');
  const mk = (status, hist, appliedAt = null) => ({ status, appliedAt, channel: 'ats', track: 'fe', history: hist.map(([s, at]) => ({ status: s, at })) });
  const apps = [
    mk('rejected', [['drafted', '2026-09-01T00:00:00Z'], ['applied', '2026-09-02T00:00:00Z'], ['screening', '2026-09-05T00:00:00Z'], ['interview', '2026-09-10T00:00:00Z'], ['rejected', '2026-09-20T00:00:00Z']], '2026-09-02T00:00:00Z'),
    mk('applied', [['drafted', '2026-10-10T00:00:00Z'], ['applied', '2026-10-14T00:00:00Z']], '2026-10-14T00:00:00Z'),
    mk('offer_declined', [['offer_declined', '2026-10-01T00:00:00Z']], '2026-06-01T00:00:00Z'),
    mk('drafted', [['drafted', '2026-10-15T00:00:00Z']]),
    mk('no_response', [['no_response', '2026-10-01T00:00:00Z']]),
  ];
  assert.equal(stats.furthestStage(apps[0]), 4);
  assert.equal(stats.furthestStage(apps[2]), 5);
  assert.equal(stats.furthestStage(apps[4]), 2);
  const st = stats.computeStats(apps, now);
  assert.deepEqual(st.funnel.map((f) => f.count), [5, 5, 4, 2, 2, 1, 0]);
  assert.equal(st.kpis.applied, 4);
  assert.equal(st.kpis.responseRate, 2 / 4);
  assert.equal(st.kpis.interviews, 2);
  assert.equal(st.kpis.offers, 1);
  assert.equal(st.kpis.appliedThisWeek, 1);
  assert.equal(st.kpis.active, 2);
  assert.equal(st.weekly.length, 12);
  assert.equal(st.weekly.at(-1).weekStart, '2026-10-12');
  assert.equal(st.weekly.at(-1).count, 1);
  assert.equal(st.weekly.reduce((n, w) => n + w.count, 0), 2, 'Jun 1 is outside 12 weeks; no_response has no date');
  assert.equal(st.byTrack[0].key, 'fe');
});

test('fixture stats are sane', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIX, 'tracker.json'), 'utf8'));
  const st = stats.computeStats(fixture.applications, new Date(fixture.updatedAt));
  assert.equal(st.kpis.total, 16);
  assert.ok(st.kpis.responseRate > 0 && st.kpis.responseRate < 1);
  for (let i = 1; i < st.funnel.length; i++) assert.ok(st.funnel[i].count <= st.funnel[i - 1].count);
});

test('demo root shifts dates and never touches repo data', () => {
  const root = demo.prepareDemoRoot({ now: Date.now() });
  const t = JSON.parse(fs.readFileSync(path.join(root, 'data', 'tracker.json'), 'utf8'));
  assert.ok(Math.abs(Date.now() - new Date(t.updatedAt).getTime()) < 2 * 86400000);
  assert.equal(t.applications.length, 16);
  assert.ok(root.startsWith(os.tmpdir()) || root.startsWith(fs.realpathSync(os.tmpdir())));
});

test('jobKey dedupe: conflict unless upsert', () => {
  const s = freshStore();
  const a = s.add({ company: 'A', role: 'B', jobKey: 'a--b--123456' });
  assert.throws(() => s.add({ company: 'A', role: 'B', jobKey: 'a--b--123456' }), (e) => e.name === 'ConflictError' && e.message === `already tracked as ${a.id}`);
  const { app, created } = s.addOrUpdate({ company: 'A', role: 'B', jobKey: 'a--b--123456', status: 'applied', salary: 'X' }, { upsert: true });
  assert.equal(created, false);
  assert.equal(app.id, a.id);
  assert.equal(app.salary, 'X');
  assert.equal(app.history.at(-1).status, 'applied');
  assert.equal(s.list().length, 1);
  assert.ok(s.add({ company: 'A', role: 'B' }), 'no jobKey: no dedupe');
});

test('appDir must be under data/applications/', () => {
  const s = freshStore();
  const a = s.add({ company: 'A', role: 'B', appDir: 'data/applications/a-b/' });
  assert.equal(a.appDir, 'data/applications/a-b');
  for (const bad of ['data/applications', '../x', 'data/applications/../../etc', '/etc', 'profile']) {
    assert.throws(() => s.update(a.id, { appDir: bad }), /appDir/, bad);
  }
  assert.equal(s.update(a.id, { appDir: '' }).appDir, null);
});

test('undo marks entry, restores status, clears appliedAt; stats skip it', () => {
  const s = freshStore();
  const a = s.add({ company: 'A', role: 'B', status: 'drafted' });
  s.update(a.id, { status: 'applied' });
  const u = s.undo(a.id);
  assert.equal(u.status, 'drafted');
  assert.equal(u.appliedAt, null);
  assert.equal(u.history.at(-1).undone, true);
  assert.equal(stats.furthestStage(u), 1);
  assert.equal(stats.computeStats([u]).kpis.applied, 0);
  assert.equal(mod.lastActivityAt(u), u.history[0].at);
  assert.throws(() => s.undo(a.id), /nothing to undo/);
  // applied set earlier is kept when undoing a later stage
  const b = s.add({ company: 'C', role: 'D', status: 'applied' });
  s.update(b.id, { status: 'screening' });
  const ub = s.undo(b.id);
  assert.equal(ub.status, 'applied');
  assert.ok(ub.appliedAt);
});

test('ambiguous id prefix errors', () => {
  const s = freshStore();
  fs.mkdirSync(path.dirname(s.trackerFile), { recursive: true });
  const base = { company: 'A', role: 'B', status: 'saved', history: [] };
  fs.writeFileSync(s.trackerFile, JSON.stringify({ version: 1, applications: [{ ...base, id: 'app_aaaa0001' }, { ...base, id: 'app_aaaa0002' }] }));
  assert.throws(() => s.get('app_aaaa'), /id prefix matches 2 applications/);
  assert.equal(s.get('app_aaaa0002').id, 'app_aaaa0002');
});

test('export --out allowlist', () => {
  assert.ok(cli.isAllowedOut(path.join(ROOT, 'data', 'exports', 'x.csv')));
  assert.ok(cli.isAllowedOut(path.join(ROOT, 'profile', 'x.csv')));
  assert.ok(cli.isAllowedOut(path.join(os.tmpdir(), 'x.csv')));
  // ROOT lives in the OS temp dir, so negatives use the repo itself.
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.ok(!cli.isAllowedOut(path.join(repo, 'src', 'x.csv')));
  assert.ok(!cli.isAllowedOut(path.join(repo, 'x.csv')));
  assert.ok(!cli.isAllowedOut('/etc/x.csv'));
});

test('CLI: conflict exit, upsert, list lastActivityAt, export --out guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-cli-'));
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gaj.js');
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { env: { ...process.env, GAJ_ROOT: root }, encoding: 'utf8' });
  let r = run('track', 'add', '--company', 'A', '--role', 'B', '--job-key', 'a--b--abcdef', '--work-mode', 'remote', '--app-dir', 'data/applications/a-b', '--json');
  assert.equal(r.status, 0, r.stderr);
  const id = JSON.parse(r.stdout).id;
  assert.equal(JSON.parse(r.stdout).workMode, 'remote');
  r = run('track', 'add', '--company', 'A', '--role', 'B', '--job-key', 'a--b--abcdef');
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`already tracked as ${id}`));
  r = run('track', 'add', '--company', 'A', '--role', 'B', '--job-key', 'a--b--abcdef', '--status', 'applied', '--upsert');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Updated existing/);
  r = run('track', 'list', '--json');
  const list = JSON.parse(r.stdout);
  assert.equal(list.length, 1);
  assert.equal(list[0].lastActivityAt, list[0].history.at(-1).at);
  const bad = path.join(path.dirname(bin), '..', 'src', 'should-not-exist.csv');
  r = run('export', '--format', 'csv', '--out', bad);
  assert.equal(r.status, 1);
  assert.ok(!fs.existsSync(bad));
  r = run('export', '--format', 'csv');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /data[\\/]exports[\\/]tracker-/);
  assert.ok(!r.stdout.includes(root), 'path printed relative to root');
});

test('fixtures use fictional names only', () => {
  const text = fs.readFileSync(path.join(FIX, 'tracker.json'), 'utf8') + fs.readFileSync(path.join(FIX, 'jobs.json'), 'utf8');
  for (const real of ['Razorpay', 'Stripe', 'Google', 'Amazon', 'Microsoft', 'Flipkart', 'Swiggy', 'Rahul', 'Priya', 'Ankit']) {
    assert.ok(!text.includes(real), real);
  }
});
