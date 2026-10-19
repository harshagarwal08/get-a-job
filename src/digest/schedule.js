// Daily schedule: free-source scrape + digest. Generates OS scheduler files; install/remove need explicit consent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestPaths, loadState, latestDigest } from './digest.js';

export const LABEL = 'dev.get-a-job.daily';
export const UNIT = 'get-a-job-daily';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** POSIX single-quote a string so spaces, quotes and $ survive /bin/sh. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function parseTime(t = '08:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('--time must be HH:MM (24h)');
  return { hour: Number(m[1]), minute: Number(m[2]), text: `${m[1].padStart(2, '0')}:${m[2]}` };
}

// Fallback dirs appended to the install-time PATH so `node` and `uvx` still resolve after e.g. an nvm upgrade.
const STD_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** PATH for the scheduled job: the installer's PATH (absolute, printable entries only) + standard dirs, deduped. */
export function schedulePath(envPath = process.env.PATH ?? '') {
  const dirs = String(envPath).split(':').filter((d) => d.startsWith('/') && !/[\x00-\x1f]/.test(d));
  return [...new Set([...dirs, ...STD_DIRS])].join(':');
}

/** Is there an executable `node` in one of these PATH dirs? */
export function nodeOnPath(p) {
  return String(p ?? '').split(':').filter(Boolean).some((d) => {
    try { fs.accessSync(path.join(d, 'node'), fs.constants.X_OK); return true; } catch { return false; }
  });
}

/**
 * The shell command the scheduler runs. `node` is resolved via the job's PATH at run time
 * (no versioned path baked in). Never passes --paid.
 * @param {{root: string, repo?: string, notify?: boolean}} o
 */
export function shellCommand({ root, repo = REPO, notify = false }) {
  const node = 'node';
  const bin = path.join(repo, 'bin', 'gaj.js');
  const env = path.resolve(root) !== path.resolve(repo) ? `GAJ_ROOT=${shq(root)} ` : '';
  const log = '>> "data/logs/schedule-$(date +%F).log" 2>&1';
  // Digest runs even if the scrape fails (it reports what is there); nothing runs if cd fails.
  return `cd ${shq(root)} && mkdir -p data/logs && { ${env}${node} ${shq(bin)} scrape ${log}; `
    + `${env}${node} ${shq(bin)} digest --mark${notify ? ' --notify' : ''} ${log}; }`;
}

export function plist(o) {
  const { hour, minute } = parseTime(o.time);
  const cmd = shellCommand(o);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xml(cmd)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(o.pathEnv ?? schedulePath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(o.root, 'data', 'logs', 'launchd.err.log'))}</string>
</dict>
</plist>
`;
}

// systemd: inside a double-quoted ExecStart arg, escape \ and ", and double % (specifiers) and $ (env expansion).
const sdq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
// Environment= values: specifiers (%) are expanded, $ is not.
const sdenv = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;

export function systemdUnits(o) {
  const { text } = parseTime(o.time);
  return {
    service: `[Unit]
Description=get-a-job daily scrape and digest

[Service]
Type=oneshot
Environment=${sdenv(`PATH=${o.pathEnv ?? schedulePath()}`)}
ExecStart=/bin/sh -c ${sdq(shellCommand(o))}
`,
    timer: `[Unit]
Description=Run get-a-job daily at ${text}

[Timer]
OnCalendar=*-*-* ${text}:00
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

/** crontab line (% must be escaped in crontab). */
export function cronLine(o) {
  const { hour, minute } = parseTime(o.time);
  return `${minute} ${hour} * * * ${`PATH=${shq(o.pathEnv ?? schedulePath())}; export PATH; ${shellCommand(o)}`.replace(/%/g, '\\%')}`;
}

export function schtasksCommand({ root, repo = REPO, time }) {
  const node = 'node';
  const { text } = parseTime(time);
  const bin = path.join(repo, 'bin', 'gaj.js');
  const log = '>> data\\logs\\schedule.log 2>&1';
  const tr = `cmd /c cd /d \\"${root}\\" && (if not exist data\\logs mkdir data\\logs) && ${node} \\"${bin}\\" scrape ${log} && ${node} \\"${bin}\\" digest --mark ${log}`;
  return `schtasks /Create /F /SC DAILY /ST ${text} /TN "get-a-job daily" /TR "${tr}"`;
}

const defaultRun = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
};

/** Locations + platform; everything injectable for tests. */
export function env({ platform = process.platform, home = os.homedir(), uid = process.getuid?.() ?? 0, run = defaultRun, root, pathEnv = schedulePath(), repo = REPO } = {}) {
  return {
    platform, home, uid, run, root, pathEnv, repo,
    plistPath: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    servicePath: path.join(home, '.config', 'systemd', 'user', `${UNIT}.service`),
    timerPath: path.join(home, '.config', 'systemd', 'user', `${UNIT}.timer`),
  };
}

const hasSystemctl = (e) => e.run('systemctl', ['--user', '--version']).status === 0;

/** What install would do: files to write + commands to run (or manual instructions). */
export function planInstall(e, { time = '08:00', notify = false } = {}) {
  const o = { pathEnv: e.pathEnv, root: e.root, repo: e.repo, time, notify: notify && e.platform === 'darwin' };
  if (e.platform === 'darwin') {
    return { kind: 'launchd', files: [{ path: e.plistPath, content: plist(o) }],
      commands: [['launchctl', ['bootstrap', `gui/${e.uid}`, e.plistPath]]], fallback: [['launchctl', ['load', e.plistPath]]] };
  }
  if (e.platform === 'win32') return { kind: 'manual', files: [], commands: [], manual: schtasksCommand(o) };
  if (!hasSystemctl(e)) return { kind: 'manual', files: [], commands: [], manual: `Add this line with "crontab -e":\n${cronLine(o)}` };
  const u = systemdUnits(o);
  return { kind: 'systemd', files: [{ path: e.servicePath, content: u.service }, { path: e.timerPath, content: u.timer }],
    commands: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', `${UNIT}.timer`]]] };
}

export function install(e, opts) {
  const plan = planInstall(e, opts);
  if (plan.kind === 'manual') return { ...plan, installed: false };
  fs.mkdirSync(digestPaths(e.root).logs, { recursive: true }); // launchd opens its stderr log before the job runs
  for (const f of plan.files) { fs.mkdirSync(path.dirname(f.path), { recursive: true }); fs.writeFileSync(f.path, f.content); }
  const results = [];
  if (plan.kind === 'launchd') {
    e.run('launchctl', ['bootout', `gui/${e.uid}/${LABEL}`]); // replace an older copy if loaded
    let r = e.run(...plan.commands[0]);
    results.push(r);
    if (r.status !== 0) { r = e.run(...plan.fallback[0]); results.push(r); }
    return { ...plan, installed: r.status === 0, results };
  }
  let ok = true;
  for (const c of plan.commands) { const r = e.run(...c); results.push(r); if (r.status !== 0) { ok = false; break; } }
  return { ...plan, installed: ok, results };
}

export function planRemove(e) {
  if (e.platform === 'darwin') return { kind: 'launchd', files: [e.plistPath], commands: [['launchctl', ['bootout', `gui/${e.uid}/${LABEL}`]]], fallback: [['launchctl', ['unload', e.plistPath]]] };
  if (e.platform === 'win32') return { kind: 'manual', files: [], commands: [], manual: 'schtasks /Delete /TN "get-a-job daily" /F' };
  return { kind: 'systemd', files: [e.servicePath, e.timerPath],
    commands: [['systemctl', ['--user', 'disable', '--now', `${UNIT}.timer`]], ['systemctl', ['--user', 'daemon-reload']]],
    manual: 'If you used the crontab line instead, remove it with "crontab -e".' };
}

export function remove(e) {
  const plan = planRemove(e);
  if (plan.kind === 'manual') return { ...plan, removed: false };
  if (plan.kind === 'launchd') { if (e.run(...plan.commands[0]).status !== 0) e.run(...plan.fallback[0]); }
  else e.run(...plan.commands[0]);
  let removed = false;
  for (const f of plan.files) if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed = true; }
  if (plan.kind === 'systemd') e.run(...plan.commands[1]);
  return { ...plan, removed };
}

/** Next local occurrence of HH:MM after `now`. */
export function nextRun({ hour, minute }, now = new Date()) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// PATH baked into the installed job (plist EnvironmentVariables / systemd Environment=).
function installedPath(e) {
  try {
    if (e.platform === 'darwin') {
      const m = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(fs.readFileSync(e.plistPath, 'utf8'));
      return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null;
    }
    const m = /^Environment="PATH=(.*)"$/m.exec(fs.readFileSync(e.servicePath, 'utf8'));
    return m ? m[1].replace(/%%/g, '%').replace(/\\(["\\])/g, '$1') : null;
  } catch { return null; }
}

function installedTime(e) {
  try {
    if (e.platform === 'darwin') {
      const t = fs.readFileSync(e.plistPath, 'utf8');
      const h = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(t);
      const m = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(t);
      return h && m ? { hour: Number(h[1]), minute: Number(m[1]) } : null;
    }
    const t = fs.readFileSync(e.timerPath, 'utf8');
    const m = /OnCalendar=\S+ (\d{2}):(\d{2})/.exec(t);
    return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
  } catch { return null; }
}

export function status(e, { now = new Date() } = {}) {
  const supported = e.platform === 'darwin' || e.platform === 'linux';
  const file = e.platform === 'darwin' ? e.plistPath : e.platform === 'linux' ? e.timerPath : null;
  const installed = !!(file && fs.existsSync(file));
  let loaded = null;
  if (installed && e.platform === 'darwin') loaded = e.run('launchctl', ['print', `gui/${e.uid}/${LABEL}`]).status === 0;
  if (installed && e.platform === 'linux') loaded = e.run('systemctl', ['--user', 'is-enabled', `${UNIT}.timer`]).status === 0;
  const t = installed ? installedTime(e) : null;
  const jobPath = installed ? installedPath(e) : null;
  const nodeFound = installed ? !!jobPath && nodeOnPath(jobPath) : null;
  const logs = digestPaths(e.root).logs;
  let lastLog = null;
  try {
    const f = fs.readdirSync(logs).filter((x) => /^schedule-.*\.log$/.test(x)).sort().at(-1);
    if (f) lastLog = { file: path.relative(e.root, path.join(logs, f)), modifiedAt: fs.statSync(path.join(logs, f)).mtime.toISOString() };
  } catch { /* no logs yet */ }
  const latest = latestDigest(e.root);
  return {
    platform: e.platform, supported, installed, loaded, file,
    time: t ? `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}` : null,
    nextRunAt: t ? nextRun(t, now) : null,
    nodeFound,
    warning: nodeFound === false ? 'node was not found on the schedule\'s PATH, so the daily run will fail. Re-run "gaj schedule install --yes" from a terminal where node works.' : null,
    lastLog, lastDigestAt: loadState(e.root).lastDigestAt, lastDigestDate: latest?.date ?? null,
    installCommand: 'node bin/gaj.js schedule install --time 08:00 --yes',
  };
}
