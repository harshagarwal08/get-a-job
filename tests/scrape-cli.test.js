import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root;

const gaj = (...args) => spawnSync(process.execPath, [path.join(REPO, 'bin', 'gaj.js'), ...args], {
  env: { ...process.env, GAJ_ROOT: root }, encoding: 'utf8',
});
const readJobs = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'jobs.json'), 'utf8'));

const base = { company: 'Acme', countries: ['IN'], workMode: 'hybrid', url: 'https://x', applyUrl: null, source: 'greenhouse',
  department: null, salary: null, firstSeen: '2026-10-01T00:00:00Z', lastSeen: '2026-10-16T00:00:00Z', track: 'fe', quickFit: null, rank: null };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-scrape-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), JSON.stringify({ version: 1, updatedAt: null, jobs: {
    'acme--old--111111': { ...base, key: 'acme--old--111111', title: 'Old Green', location: 'Bengaluru', postedAt: '2026-10-01T00:00:00Z', description: 'SECRET-DESC-1', eligibility: 'green', eligibilityReason: 'r', status: 'new' },
    'acme--new--222222': { ...base, key: 'acme--new--222222', title: 'New Orange', location: 'London', postedAt: '2026-10-15T00:00:00Z', description: 'SECRET-DESC-2', eligibility: 'orange', eligibilityReason: 'r', status: 'new' },
    'acme--ranked--333333': { ...base, key: 'acme--ranked--333333', title: 'Ranked', location: 'Pune', postedAt: '2026-09-01T00:00:00Z', description: 'd', eligibility: 'unknown', eligibilityReason: 'r', status: 'ranked', rank: { score: 70, verdict: 'Good' } },
    'acme--gone--444444': { ...base, key: 'acme--gone--444444', title: 'Gone', location: 'Pune', postedAt: null, description: 'd', eligibility: 'green', eligibilityReason: 'r', status: 'expired' },
  } }));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('scrape without preferences fails with an /onboard hint', () => {
  const r = gaj('scrape');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run \/onboard/i);
});

test('jobs lists without descriptions, sorted rank > eligibility > newest, hides expired', () => {
  const r = gaj('jobs', '--json');
  assert.equal(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.map((j) => j.key), ['acme--ranked--333333', 'acme--old--111111', 'acme--new--222222']);
  assert.ok(list.every((j) => !('description' in j)));
  const human = gaj('jobs').stdout;
  assert.doesNotMatch(human, /SECRET-DESC/);
  assert.match(human, /🟢/);
  assert.equal(JSON.parse(gaj('jobs', '--json', '--eligibility', 'orange').stdout).length, 1);
  assert.equal(JSON.parse(gaj('jobs', '--json', '--status', 'expired').stdout).length, 1);
});

test('job shows description; accepts unique key prefix', () => {
  const r = gaj('job', 'acme--old');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SECRET-DESC-1/);
  assert.equal(gaj('job', 'acme--nope').status, 1);
});

test('jobs:set updates status, quick fit and rank', () => {
  const rankFile = path.join(root, 'rank.json');
  fs.writeFileSync(rankFile, JSON.stringify({ score: 81, verdict: 'Strong',
    dimensions: { technical: 80, experience: 85, culture: 70, career: 90 },
    gates: { eligibility: 'pass', compensation: 'unknown', notice: 'pass' }, strengths: ['React'], gaps: [] }));
  let r = gaj('jobs:set', 'acme--old--111111', '--quick-fit', 'high', '--rank-file', rankFile);
  assert.equal(r.status, 0, r.stderr);
  const j = readJobs().jobs['acme--old--111111'];
  assert.equal(j.quickFit, 'high');
  assert.equal(j.rank.score, 81);
  assert.ok(j.rank.rankedAt);
  assert.equal(j.status, 'ranked');
  r = gaj('jobs:set', 'acme--old--111111', '--status', 'bogus');
  assert.equal(r.status, 1);
  fs.writeFileSync(rankFile, JSON.stringify({ score: 500, verdict: 'Strong' }));
  assert.equal(gaj('jobs:set', 'acme--old--111111', '--rank-file', rankFile).status, 1);
  fs.writeFileSync(rankFile, JSON.stringify({ score: 70, verdict: 'Strong' }));
  r = gaj('jobs:set', 'acme--old--111111', '--rank-file', rankFile);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /expected "Good"/);
});

test('jobs:set --quick-fit-file updates many jobs atomically', () => {
  const f = path.join(root, 'qf.json');
  fs.writeFileSync(f, JSON.stringify({ 'acme--new--222222': 'low', 'acme--ranked--333333': 'medium' }));
  let r = gaj('jobs:set', '--quick-fit-file', f, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).updated, 2);
  assert.equal(readJobs().jobs['acme--new--222222'].quickFit, 'low');
  fs.writeFileSync(f, JSON.stringify({ 'acme--new--222222': 'high', 'acme--missing--000000': 'high' }));
  r = gaj('jobs:set', '--quick-fit-file', f);
  assert.equal(r.status, 1);
  assert.equal(readJobs().jobs['acme--new--222222'].quickFit, 'low', 'nothing written on error');
  fs.writeFileSync(f, JSON.stringify({ 'acme--new--222222': 'great' }));
  assert.equal(gaj('jobs:set', '--quick-fit-file', f).status, 1);
});

test('job resolves aliases', () => {
  const store = readJobs();
  store.jobs['acme--ranked--333333'].aliases = ['acme--ranked-old--999999'];
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), JSON.stringify(store));
  const r = gaj('job', 'acme--ranked-old--999999', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).key, 'acme--ranked--333333');
});

test('--limit 0 is rejected; --limit 1 works', () => {
  assert.equal(gaj('jobs', '--limit', '0').status, 1);
  assert.equal(JSON.parse(gaj('jobs', '--json', '--limit', '1').stdout).length, 1);
});

test('fetch refuses private hosts and LinkedIn without opt-in (no network)', () => {
  for (const u of ['http://127.0.0.1/jobs', 'http://localhost:8080/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.1.2.3/']) {
    const r = gaj('fetch', u);
    assert.equal(r.status, 1, u);
    assert.match(r.stderr, /refusing/, u);
  }
  const r = gaj('fetch', 'https://www.linkedin.com/jobs/view/4477982333/');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /LinkedIn fetching is opt-in \(sources\.linkedin\)/);
});

test('company:check validates arguments', () => {
  assert.equal(gaj('company:check', 'bamboo', 'acme').status, 1);
  assert.equal(gaj('company:check', 'lever', '../etc').status, 1);
});

test('fetch rejects non-http input', () => {
  const r = gaj('fetch', 'ftp://x');
  assert.equal(r.status, 1);
});
