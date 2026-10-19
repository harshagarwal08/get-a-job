import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracker');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-settings-'));
process.env.GAJ_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.copyFileSync(path.join(FIX, 'jobs.json'), path.join(ROOT, 'data', 'jobs.json'));
const month = new Date().toISOString().slice(0, 7);
fs.writeFileSync(path.join(ROOT, 'data', 'usage.json'), JSON.stringify({ [month]: { googleJobs: { requests: 12, usdCap: 0 }, apify: { requests: 2, usdCap: 1.5 } } }));

let createTrackerServer, createSearchRunner, createStore, scrapeArgs;

// Fake child process: test drives stdout/stderr/close.
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = (sig) => { child.killed = sig; setImmediate(() => child.emit('close', null)); };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}

async function boot(opts = {}) {
  const srv = createTrackerServer({ port: 0, ...opts });
  const { url, port } = await srv.listen();
  const j = async (p, o = {}) => {
    const res = await fetch(new URL(p, url), {
      method: o.method ?? 'GET',
      headers: o.body !== undefined ? { 'Content-Type': 'application/json', ...o.headers } : o.headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return { srv, url, port, j };
}

const raw = (port, p, headers, method = 'GET', body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});

const prefsPath = path.join(ROOT, 'profile', 'preferences.json');
const validPrefs = () => JSON.parse(fs.readFileSync(path.join(FIX, 'preferences.json'), 'utf8'));
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let main;
let spawnFn;
before(async () => {
  ({ createTrackerServer } = await import('../src/tracker/server.js'));
  ({ createSearchRunner, scrapeArgs } = await import('../src/tracker/search.js'));
  ({ createStore } = await import('../src/tracker/store.js'));
  spawnFn = fakeSpawn();
  main = await boot({ search: createSearchRunner({ root: ROOT, spawn: spawnFn }) });
});
after(() => main.srv.close());

test('GET preferences without a file returns the example template', async () => {
  const r = await main.j('/api/preferences');
  assert.equal(r.status, 200);
  assert.equal(r.data.exists, false);
  assert.ok(Array.isArray(r.data.prefs.tracks) && r.data.prefs.tracks.length);
  assert.ok(r.data.remoteScopes.includes('global'));
  assert.deepEqual(r.data.usage.googleJobs, { requests: 12, limit: 100 });
  assert.equal(r.data.usage.apify.usd, 1.5);
});

test('PUT preferences: validation errors → 400, nothing written', async () => {
  const bad = validPrefs();
  bad.tracks = [];
  bad.location.workModes = ['moon'];
  const r = await main.j('/api/preferences', { method: 'PUT', body: bad });
  assert.equal(r.status, 400);
  assert.ok(r.data.errors.some((e) => e.startsWith('tracks')));
  assert.ok(r.data.errors.some((e) => e.startsWith('location.workModes')));
  assert.ok(!fs.existsSync(prefsPath));
});

test('PUT preferences: writes, keeps unknown keys, backs up previous (max 10)', async () => {
  fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
  fs.writeFileSync(prefsPath, JSON.stringify({ ...validPrefs(), futureField: { keep: true } }));
  const p = validPrefs();
  p.noticePeriodDays = 30;
  p.anotherUnknown = 'x';
  let r = await main.j('/api/preferences', { method: 'PUT', body: p });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const disk = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
  assert.equal(disk.noticePeriodDays, 30);
  assert.deepEqual(disk.futureField, { keep: true });
  assert.equal(disk.anotherUnknown, 'x');
  const backups = () => fs.readdirSync(path.join(ROOT, 'data', 'backups'));
  assert.equal(backups().length, 1);
  for (let i = 0; i < 12; i++) { p.noticePeriodDays = i; await main.j('/api/preferences', { method: 'PUT', body: p }); await tick(2); }
  assert.equal(backups().length, 10);
  r = await main.j('/api/preferences');
  assert.equal(r.data.exists, true);
  assert.equal(r.data.prefs.noticePeriodDays, 11);
});

test('PUT preferences: Host / Origin / content-type checks', async () => {
  const body = JSON.stringify(validPrefs());
  assert.equal((await raw(main.port, '/api/preferences', { Host: 'evil.example.com', 'Content-Type': 'application/json' }, 'PUT', body)).status, 403);
  assert.equal((await raw(main.port, '/api/preferences', { Host: `127.0.0.1:${main.port}`, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' }, 'PUT', body)).status, 403);
  assert.equal((await raw(main.port, '/api/preferences', { Host: `127.0.0.1:${main.port}`, 'Content-Type': 'text/plain' }, 'PUT', body)).status, 415);
  assert.equal((await raw(main.port, '/api/search', { Host: `127.0.0.1:${main.port}`, Origin: 'http://evil.example.com', 'Content-Type': 'application/json' }, 'POST', '{}')).status, 403);
});

test('search lifecycle with fake child; one at a time; paid needs confirmPaid', async () => {
  let r = await main.j('/api/search/status');
  assert.equal(r.data.running, false);
  r = await main.j('/api/search', { method: 'POST', body: { paid: true } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /confirmPaid/);
  r = await main.j('/api/search', { method: 'POST', body: { track: 'nope' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /unknown track/);
  for (const bad of ['--paid', 'FE', '-x', 'fe x', 'fe;rm']) {
    r = await main.j('/api/search', { method: 'POST', body: { track: bad } });
    assert.equal(r.status, 400, bad);
    assert.match(r.data.error, /track id/, bad);
  }
  assert.throws(() => scrapeArgs({ track: '--paid' }), /invalid track/);
  r = await main.j('/api/search', { method: 'POST', body: { paid: true, confirmPaid: true, track: 'fe', days: 7 } });
  assert.equal(r.status, 202);
  assert.ok(r.data.id);
  const call = spawnFn.calls.at(-1);
  assert.equal(call.cmd, process.execPath);
  assert.ok(call.args[0].endsWith(path.join('bin', 'gaj.js')));
  assert.deepEqual(call.args.slice(1), ['scrape', '--json', '--paid', '--track=fe', '--days', '7']);
  assert.equal(call.opts.env.GAJ_ROOT, ROOT);
  r = await main.j('/api/search', { method: 'POST', body: {} });
  assert.equal(r.status, 409);
  call.child.stderr.write('\x1b[32mgreenhouse\x1b[0m: 3 companies\n');
  call.child.stdout.write('{"new": 2, "updated": 1, ');
  call.child.stdout.write('"expired": 0, "skipped": 1, "sources": {}}');
  await tick();
  r = await main.j('/api/search/status');
  assert.equal(r.data.running, true);
  assert.deepEqual(r.data.log, ['greenhouse: 3 companies']);
  call.child.emit('close', 0);
  r = await main.j('/api/search/status');
  assert.equal(r.data.running, false);
  assert.equal(r.data.exitCode, 0);
  assert.equal(r.data.summary.new, 2);
  assert.equal(r.data.error, null);
  // failed run surfaces the error line
  r = await main.j('/api/search', { method: 'POST', body: {} });
  assert.equal(r.status, 202);
  const c2 = spawnFn.calls.at(-1);
  assert.deepEqual(c2.args.slice(1), ['scrape', '--json']);
  c2.child.stderr.write('error: no companies configured\n');
  await tick();
  c2.child.emit('close', 1);
  r = await main.j('/api/search/status');
  assert.equal(r.data.exitCode, 1);
  assert.equal(r.data.error, 'no companies configured');
});

test('search timeout kills the child', async () => {
  const spawn = fakeSpawn();
  const runner = createSearchRunner({ root: ROOT, spawn, timeoutMs: 20 });
  runner.start({});
  await tick(80);
  assert.equal(spawn.calls[0].child.killed, 'SIGTERM');
  const st = runner.status();
  assert.equal(st.running, false);
  assert.match(st.error, /10 minutes/);
  assert.match(st.error, /Nothing was merged/);
  assert.match(st.error, /--company/);
  assert.equal(st.timedOut, true);
  assert.equal(st.summary, null);
});

test('demo mode: simulated search adds fictional jobs, no spawn', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-demo-search-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'jobs.json'), path.join(dir, 'data', 'jobs.json'));
  fs.copyFileSync(path.join(FIX, 'preferences.json'), path.join(dir, 'profile', 'preferences.json'));
  const store = createStore({ root: dir, trackerFile: path.join(dir, 'data', 'tracker.json'), jobsFile: path.join(dir, 'data', 'jobs.json') });
  const spawn = () => { throw new Error('must not spawn in demo'); };
  const demo = await boot({ store, meta: { demo: true }, search: createSearchRunner({ root: dir, demo: true, jobsFile: store.jobsFile, demoStepMs: 2, spawn }) });
  try {
    const before = Object.keys(JSON.parse(fs.readFileSync(store.jobsFile, 'utf8')).jobs).length;
    let r = await demo.j('/api/search', { method: 'POST', body: {} });
    assert.equal(r.status, 202);
    for (let i = 0; i < 100 && (await demo.j('/api/search/status')).data.running; i++) await tick(10);
    r = await demo.j('/api/search/status');
    assert.equal(r.data.exitCode, 0);
    assert.equal(r.data.summary.new, 3);
    assert.ok(r.data.log.length > 3);
    const after = JSON.parse(fs.readFileSync(store.jobsFile, 'utf8')).jobs;
    assert.equal(Object.keys(after).length, before + 3);
    assert.ok(Object.values(after).filter((x) => x.status === 'new' && /demo search/.test(x.description)).length === 3);
  } finally { await demo.srv.close(); }
});

test('digest + schedule status API', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-digest-api-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const store = createStore({ root: dir, trackerFile: path.join(dir, 'data', 'tracker.json'), jobsFile: path.join(dir, 'data', 'jobs.json') });
  const { env } = await import('../src/digest/schedule.js');
  const calls = [];
  const scheduleEnv = env({ platform: 'darwin', home: dir, uid: 1, root: dir, run: (c, a) => { calls.push([c, ...a]); return { status: 0, stdout: '', stderr: '' }; } });
  const s = await boot({ store, scheduleEnv, search: createSearchRunner({ root: dir, spawn: fakeSpawn() }) });
  try {
    let r = await s.j('/api/digest');
    assert.deepEqual(r.data, { lastDigestAt: null, latest: null });
    assert.equal((await s.j('/api/digest/latest')).status, 404);
    fs.copyFileSync(path.join(FIX, 'jobs.json'), store.jobsFile);
    const { runDigest } = await import('../src/digest/digest.js');
    runDigest(dir, { hours: 100000, mark: true });
    r = await s.j('/api/digest');
    assert.ok(r.data.lastDigestAt);
    assert.match(r.data.latest.path, /^data\/digests\/\d{4}-\d{2}-\d{2}/);
    assert.ok(r.data.latest.counts.total > 0);
    r = await s.j('/api/digest/latest');
    assert.equal(r.status, 200);
    assert.match(r.data, /^<!-- gaj-digest/);
    r = await s.j('/api/schedule/status');
    assert.equal(r.status, 200);
    assert.equal(r.data.installed, false);
    assert.equal(r.data.installCommand, 'node bin/gaj.js schedule install --time 08:00 --yes');
    assert.ok(r.data.lastDigestDate);
    assert.deepEqual(calls, [], 'status of an uninstalled schedule runs nothing');
    assert.equal((await s.j('/api/schedule/install', { method: 'POST', body: {} })).status, 404);
  } finally { await s.srv.close(); }
});
