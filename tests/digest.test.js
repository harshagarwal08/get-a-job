import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'tracker');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-digest-'));
process.env.GAJ_ROOT = ROOT;

let d, sch;
before(async () => {
  d = await import('../src/digest/digest.js');
  sch = await import('../src/digest/schedule.js');
});

const freshRoot = () => {
  const r = fs.mkdtempSync(path.join(ROOT, 'r-'));
  fs.mkdirSync(path.join(r, 'data'), { recursive: true });
  fs.mkdirSync(path.join(r, 'profile'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'jobs.json'), path.join(r, 'data', 'jobs.json'));
  fs.copyFileSync(path.join(FIX, 'preferences.json'), path.join(r, 'profile', 'preferences.json'));
  return r;
};
const job = (o) => ({ key: o.key ?? `k-${Math.random()}`, title: 'FE', company: 'Co', status: 'new', eligibility: 'green', firstSeen: '2026-10-10T00:00:00.000Z', track: 'fe', ...o });

test('selectJobs: open statuses only, strictly after since, bounded by until', () => {
  const store = { jobs: Object.fromEntries([
    job({ key: 'a' }), job({ key: 'b', status: 'ranked' }), job({ key: 'c', status: 'skipped' }), job({ key: 'd', status: 'expired' }),
    job({ key: 'e', status: 'tracked' }), job({ key: 'f', firstSeen: '2026-10-01T00:00:00.000Z' }), job({ key: 'g', firstSeen: '2026-10-20T00:00:00.000Z' }),
  ].map((j) => [j.key, j])) };
  assert.deepEqual(d.selectJobs(store, '2026-10-05T00:00:00Z').map((j) => j.key).sort(), ['a', 'b', 'g']);
  assert.deepEqual(d.selectJobs(store, '2026-10-05T00:00:00Z', '2026-10-15T00:00:00Z').map((j) => j.key).sort(), ['a', 'b']);
  assert.ok(!d.selectJobs(store, '2026-10-10T00:00:00.000Z').some((j) => j.key === 'a'), 'strictly after since');
});

test('resolveSince precedence', () => {
  const now = Date.parse('2026-10-19T10:00:00Z');
  assert.equal(d.resolveSince({ since: '2026-10-01', now }), '2026-10-01T00:00:00.000Z');
  assert.equal(d.resolveSince({ hours: 6, now }), '2026-10-19T04:00:00.000Z');
  assert.equal(d.resolveSince({ state: { lastDigestAt: '2026-10-18T08:00:00.000Z' }, now }), '2026-10-18T08:00:00.000Z');
  assert.equal(d.resolveSince({ now }), '2026-10-18T10:00:00.000Z');
  assert.throws(() => d.resolveSince({ since: 'nope' }), /ISO/);
  assert.throws(() => d.resolveSince({ hours: -1 }), /positive/);
});

test('buildDigest groups by track order, green then unknown, orange summarised', () => {
  const jobs = [
    job({ key: '1', track: 'fde', rank: { score: 60, verdict: 'Good' } }),
    job({ key: '2', track: 'fe', eligibility: 'unknown', rank: { score: 90, verdict: 'Strong' } }),
    job({ key: '3', track: 'fe', rank: { score: 70, verdict: 'Good' } }),
    job({ key: '4', track: 'fe', quickFit: 'high' }),
    job({ key: '5', track: 'fe', eligibility: 'orange', eligibilityReason: 'Relocation needed' }),
    job({ key: '6', track: 'fe', eligibility: 'orange', eligibilityReason: 'Relocation needed' }),
    job({ key: '7', track: 'fe', eligibility: 'orange', eligibilityReason: 'US only' }),
    job({ key: '8', track: null }),
  ];
  const dg = d.buildDigest(jobs, { since: '2026-10-01T00:00:00Z', tracks: [{ id: 'fe', name: 'Frontend' }, { id: 'fde', name: 'FDE' }] });
  assert.deepEqual(dg.tracks.map((t) => t.id), ['fe', 'fde', null]);
  const fe = dg.tracks[0];
  assert.deepEqual(fe.green.map((j) => j.key), ['3', '4']);
  assert.deepEqual(fe.unknown.map((j) => j.key), ['2']);
  assert.equal(fe.orange.count, 3);
  assert.deepEqual(fe.orange.reasons[0], { reason: 'Relocation needed', count: 2 });
  assert.deepEqual(dg.counts, { total: 8, green: 4, orange: 3, unknown: 1 });
  assert.equal(dg.tracks[2].name, 'No track');
});

test('markdown: escapes untrusted text, safe links, meta header, empty state', () => {
  const dg = d.buildDigest([job({ title: 'Eng **<script>** [x](javascript:1)', company: 'A|B', url: 'javascript:alert(1)', via: 'linkedin', rank: { score: 80, verdict: 'Strong' } }),
    job({ title: 'Ok', url: 'https://ex.com/a', source: 'greenhouse' })], { since: '2026-10-01T00:00:00Z', now: Date.parse('2026-10-12T00:00:00Z') });
  const md = d.renderMarkdown(dg, { now: Date.parse('2026-10-12T00:00:00Z') });
  assert.ok(!md.includes('<script>'));
  assert.ok(md.includes('\\*\\*'));
  assert.ok(!/[^\\]\]\(javascript:/.test(md), 'no live javascript: link');
  assert.ok(md.includes('\\[x\\]'), 'brackets escaped');
  assert.ok(md.includes('[posting](https://ex.com/a)'));
  assert.ok(md.includes('via linkedin') && md.includes('via greenhouse'));
  assert.ok(md.includes('80 Strong'));
  assert.deepEqual(d.parseDigestMeta(md).counts, dg.counts);
  const empty = d.renderMarkdown(d.buildDigest([], { since: '2026-10-01T00:00:00Z' }));
  assert.match(empty, /No new matching jobs/);
  assert.match(empty, /\/discover/);
});

test('runDigest writes file (suffix when taken), --mark updates state, --out guard', () => {
  const r = freshRoot();
  const now = Date.parse('2026-10-16T10:00:00Z');
  const a = d.runDigest(r, { hours: 72, now });
  assert.ok(a.file.endsWith('.md') && fs.existsSync(a.file));
  assert.ok(a.digest.counts.total > 0);
  assert.equal(d.loadState(r).lastDigestAt, null);
  const b = d.runDigest(r, { hours: 72, now, mark: true });
  assert.notEqual(a.file, b.file);
  assert.match(path.basename(b.file), /^\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  assert.equal(d.loadState(r).lastDigestAt, new Date(now).toISOString());
  const c = d.runDigest(r, { now });
  assert.equal(c.digest.since, new Date(now).toISOString(), 'defaults to lastDigestAt');
  assert.equal(c.digest.counts.total, 0);
  assert.ok(d.latestDigest(r).text.includes('No new matching jobs'));
  assert.throws(() => d.runDigest(r, { hours: 1, out: path.join(HERE, 'nope.md') }), /--out/);
  const ok = d.runDigest(r, { hours: 1, out: path.join(r, 'data', 'x', 'd.md') });
  assert.ok(fs.existsSync(ok.file));
});

test('CLI digest --json --mark', () => {
  const r = freshRoot();
  const res = spawnSync(process.execPath, [path.join(HERE, '..', 'bin', 'gaj.js'), 'digest', '--hours', '100000', '--mark', '--json'], { env: { ...process.env, GAJ_ROOT: r }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(out.counts.total > 0);
  assert.match(out.file, /^data[\\/]digests[\\/]/);
  assert.ok(d.loadState(r).lastDigestAt);
});

const PATHENV = "/Users/Jane Doe/.nvm/versions/node/v22.1.0/bin:/opt/homebrew/bin:/usr/bin:/bin";
const REPO = "/Users/Jane Doe/it's here/get-a-job";

test('shell command: quoting survives spaces/quotes, never --paid', () => {
  const cmd = sch.shellCommand({ root: REPO, repo: REPO });
  assert.ok(!cmd.includes('--paid'));
  assert.ok(cmd.includes(`node ${sch.shq(path.join(REPO, 'bin', 'gaj.js'))} scrape`), 'node resolved by name via PATH');
  assert.ok(!cmd.includes(process.execPath) && !cmd.includes('.nvm'), 'no versioned node path baked in');
  assert.ok(cmd.startsWith(`cd '/Users/Jane Doe/it'\\''s here/get-a-job' && mkdir -p data/logs && {`));
  assert.ok(!cmd.includes('GAJ_ROOT'));
  // Run the quoting through a real shell (echo instead of the actual binaries).
  const probe = `printf '%s\\n' ${sch.shq(REPO)} ${sch.shq(PATHENV)}`;
  assert.equal(execFileSync('/bin/sh', ['-c', probe], { encoding: 'utf8' }), `${REPO}\n${PATHENV}\n`);
  const other = sch.shellCommand({ root: '/data root', repo: REPO, notify: true });
  assert.ok(other.includes("GAJ_ROOT='/data root'"));
  assert.ok(other.includes('digest --mark --notify'));
});

test('plist: XML-escaped command, calendar interval, label', () => {
  const xml = sch.plist({ pathEnv: `${PATHENV}:/odd&<dir>`, root: REPO, repo: REPO, time: '7:05' });
  assert.ok(xml.includes(`<key>PATH</key>\n    <string>${PATHENV}:/odd&amp;&lt;dir&gt;</string>`));
  assert.match(xml, /<string>dev\.get-a-job\.daily<\/string>/);
  assert.match(xml, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
  assert.match(xml, /<key>Minute<\/key>\s*<integer>5<\/integer>/);
  assert.ok(xml.includes('&amp;&amp;') && xml.includes('&gt;&gt;'));
  assert.ok(!/<string>[^<]*&&/.test(xml), 'raw && must be escaped');
  const cmd = /<string>-c<\/string>\s*<string>([^<]*)<\/string>/.exec(xml)[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  assert.equal(cmd, sch.shellCommand({ root: REPO, repo: REPO }));
  assert.throws(() => sch.plist({ root: REPO, time: '25:00' }), /HH:MM/);
});

test('systemd units escape % and $; cron escapes %; schtasks text', () => {
  const u = sch.systemdUnits({ pathEnv: '/a%b:/usr/bin', root: REPO, repo: REPO, time: '08:00' });
  assert.ok(u.service.includes('Environment="PATH=/a%%b:/usr/bin"\n'));
  assert.match(u.timer, /OnCalendar=\*-\*-\* 08:00:00/);
  assert.match(u.timer, /Persistent=true/);
  assert.ok(u.service.includes('$$(date +%%F)'));
  assert.ok(u.service.includes('ExecStart=/bin/sh -c "cd '));
  assert.ok(!/[^%]%F/.test(u.service.replace(/%%F/g, '')));
  const cron = sch.cronLine({ pathEnv: PATHENV, root: REPO, repo: REPO, time: '06:30' });
  assert.ok(cron.startsWith(`30 6 * * * PATH=${sch.shq(PATHENV)}; export PATH; cd `));
  assert.ok(cron.includes('\\%F'));
  const win = sch.schtasksCommand({ root: 'C:\\gaj', repo: 'C:\\gaj', time: '08:00' });
  assert.match(win, /^schtasks \/Create \/F \/SC DAILY \/ST 08:00 /);
  assert.ok(!win.includes('--paid'));
});

test('install/remove/status with injected runner and home', () => {
  const home = fs.mkdtempSync(path.join(ROOT, 'home-'));
  const r = freshRoot();
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: cmd === 'launchctl' && args[0] === 'bootout' ? 3 : 0, stdout: '', stderr: '' }; };
  const e = sch.env({ platform: 'darwin', home, uid: 501, run, root: r, pathEnv: PATHENV, repo: REPO });
  assert.equal(sch.status(e).installed, false);
  const res = sch.install(e, { time: '08:15' });
  assert.equal(res.installed, true);
  assert.ok(fs.existsSync(e.plistPath));
  assert.deepEqual(calls.find((c) => c[1] === 'bootstrap'), ['launchctl', 'bootstrap', 'gui/501', e.plistPath]);
  const st = sch.status(e, { now: new Date(2026, 9, 19, 9, 0) });
  assert.equal(st.installed, true);
  assert.equal(st.time, '08:15');
  assert.equal(new Date(st.nextRunAt).getDate(), 20);
  sch.remove(e);
  assert.ok(!fs.existsSync(e.plistPath));
  assert.ok(calls.some((c) => c[1] === 'unload'), 'falls back to unload when bootout fails');

  const linux = sch.env({ platform: 'linux', home, uid: 1000, run: () => ({ status: 0, stdout: '', stderr: '' }), root: r, pathEnv: PATHENV, repo: REPO });
  const lr = sch.install(linux, {});
  assert.equal(lr.kind, 'systemd');
  assert.ok(fs.existsSync(linux.timerPath) && fs.existsSync(linux.servicePath));
  assert.equal(sch.status(linux).time, '08:00');
  sch.remove(linux);
  assert.ok(!fs.existsSync(linux.timerPath));

  const noSystemd = sch.env({ platform: 'linux', home, run: () => ({ status: -1, stdout: '', stderr: '' }), root: r, pathEnv: PATHENV, repo: REPO });
  const plan = sch.planInstall(noSystemd, {});
  assert.equal(plan.kind, 'manual');
  assert.match(plan.manual, /crontab -e/);
  assert.equal(sch.planInstall(sch.env({ platform: 'win32', home, run, root: r }), {}).kind, 'manual');
});

test('CLI schedule install without --yes is a dry run', () => {
  const r = freshRoot();
  const home = fs.mkdtempSync(path.join(ROOT, 'h-'));
  const res = spawnSync(process.execPath, [path.join(HERE, '..', 'bin', 'gaj.js'), 'schedule', 'install', '--time', '09:00'], { env: { ...process.env, GAJ_ROOT: r, HOME: home }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Re-run with --yes|Do this yourself/);
  assert.ok(!fs.existsSync(path.join(home, 'Library')) && !fs.existsSync(path.join(home, '.config')));
});

test('CLI digest --mark-only: marks exactly generatedAt, writes no file', () => {
  const r = freshRoot();
  const gaj = (...a) => spawnSync(process.execPath, [path.join(HERE, '..', 'bin', 'gaj.js'), 'digest', ...a], { env: { ...process.env, GAJ_ROOT: r }, encoding: 'utf8' });
  const shown = JSON.parse(gaj('--hours', '100000', '--json', '--out', path.join(r, 'data', 'tmp.md')).stdout);
  assert.equal(d.loadState(r).lastDigestAt, null, 'showing does not mark');
  const res = gaj('--mark-only', '--at', shown.generatedAt, '--json');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).lastDigestAt, shown.generatedAt);
  assert.equal(d.loadState(r).lastDigestAt, shown.generatedAt);
  assert.ok(!fs.existsSync(path.join(r, 'data', 'digests')), 'no digest file written');
  assert.equal(gaj('--mark-only').status, 0);
  assert.ok(new Date(d.loadState(r).lastDigestAt) > new Date(shown.generatedAt), 'defaults to now');
  for (const bad of [['--mark-only', '--at', 'yesterday'], ['--mark-only', '--at', '2999-01-01T00:00:00Z'], ['--at', shown.generatedAt], ['--mark-only', '--mark']]) {
    assert.notEqual(gaj(...bad).status, 0, bad.join(' '));
  }
});

test('schedule PATH: install-time PATH + std dirs; status flags a missing node; logs dir created', () => {
  assert.equal(sch.schedulePath('/a/bin:relative:/a/bin:/usr/bin:/bad\ndir'), '/a/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin:/usr/sbin:/sbin');
  const home = fs.mkdtempSync(path.join(ROOT, 'hp-'));
  const r = freshRoot();
  const bin = fs.mkdtempSync(path.join(ROOT, 'bin-'));
  const run = () => ({ status: 0, stdout: '', stderr: '' });
  const noNode = sch.env({ platform: 'darwin', home, uid: 501, run, root: r, pathEnv: bin, repo: REPO });
  sch.install(noNode, {});
  assert.ok(fs.existsSync(path.join(r, 'data', 'logs')), 'data/logs created at install');
  let st = sch.status(noNode);
  assert.equal(st.nodeFound, false);
  assert.match(st.warning, /node was not found/);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  st = sch.status(noNode);
  assert.equal(st.nodeFound, true);
  assert.equal(st.warning, null);
  sch.remove(noNode);
  const linux = sch.env({ platform: 'linux', home, uid: 1000, run, root: r, pathEnv: `${bin}:/x"y`, repo: REPO });
  sch.install(linux, {});
  assert.equal(sch.status(linux).nodeFound, true, 'reads Environment=PATH back from the unit');
  sch.remove(linux);
  assert.equal(sch.status(linux).nodeFound, null, 'not installed');
});
