// CLI: gaj tracker | track add/update/list | export
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse, out, fail } from '../lib/args.js';
import { paths } from '../lib/paths.js';
import { ensureDir } from '../lib/store.js';
import { store as defaultStore, createStore, lastActivityAt, EDITABLE_FIELDS, STATUSES } from './store.js';
import { FORMATS, exportApplications } from './export.js';

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* best effort */ }
}

// --field key=value → patch entry. Supports fit.score / fit.verdict and null/empty values.
export function parseFields(list = []) {
  const patch = {};
  for (const item of list) {
    const eq = item.indexOf('=');
    if (eq < 1) throw new Error(`--field expects key=value, got "${item}"`);
    const key = item.slice(0, eq).trim();
    let value = item.slice(eq + 1);
    if (value === 'null') value = null;
    if (key === 'fit.score' || key === 'fit.verdict') {
      patch.fit = { ...(patch.fit ?? {}), [key.slice(4)]: value };
      continue;
    }
    if (!EDITABLE_FIELDS.includes(key)) throw new Error(`unknown field "${key}" (allowed: ${EDITABLE_FIELDS.join(', ')}, fit.score, fit.verdict)`);
    patch[key] = value;
  }
  return patch;
}

// Safety rule (CONTRACTS): --out must resolve inside data/, profile/, or the OS temp dir.
export function isAllowedOut(file) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  // Resolve symlinks on the nearest existing ancestor so /tmp vs /private/tmp etc. compare correctly.
  let dir = path.dirname(path.resolve(file));
  const tail = [path.basename(file)];
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) { tail.unshift(path.basename(dir)); dir = path.dirname(dir); }
  const abs = path.join(real(dir), ...tail);
  return [paths.dataDir, paths.profileDir, os.tmpdir()].some((base) => {
    const b = real(base);
    return abs.startsWith(b + path.sep);
  });
}

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
function table(apps) {
  if (!apps.length) return 'No applications. Track one with `gaj track add --company C --role R` or run /tailor.';
  const head = `${pad('ID', 12)}  ${pad('STATUS', 14)}  ${pad('COMPANY', 20)}  ${pad('ROLE', 30)}  ${pad('FIT', 4)}  NEXT`;
  const rows = apps.map((a) => `${pad(a.id, 12)}  ${pad(a.status, 14)}  ${pad(a.company, 20)}  ${pad(a.role, 30)}  ${pad(a.fit?.score ?? '', 4)}  ${a.nextAction ? `${a.nextAction}${a.nextActionDate ? ` (${a.nextActionDate})` : ''}` : ''}`);
  return [head, ...rows].join('\n');
}

const TRACK_USAGE = `gaj track add --company C --role R [--url U] [--job-key K] [--status drafted] [--track id] [--fit 72] [--verdict Good] [--resume path] [--cover path] [--channel ats] [--location L] [--work-mode m] [--app-dir path] [--deadline YYYY-MM-DD] [--notes "..."] [--upsert] [--field key=value ...] [--json]
gaj track update <id> [--status s] [--note "..."] [--next-action "..."] [--next-date YYYY-MM-DD] [--field key=value ...] [--json]
gaj track list [--status s] [--json]`;

async function trackCmd(argv) {
  const [sub, ...rest] = argv;
  const s = defaultStore();
  if (sub === 'add') {
    const a = parse(rest, {
      company: { type: 'string' }, role: { type: 'string' }, url: { type: 'string' }, 'job-key': { type: 'string' },
      status: { type: 'string' }, track: { type: 'string' }, fit: { type: 'string' }, verdict: { type: 'string' },
      resume: { type: 'string' }, cover: { type: 'string' }, channel: { type: 'string' }, location: { type: 'string' },
      deadline: { type: 'string' }, notes: { type: 'string' }, field: { type: 'string', multiple: true },
      'work-mode': { type: 'string' }, 'app-dir': { type: 'string' }, upsert: { type: 'boolean' },
    }, { allowPositionals: false });
    if (a.help) return out(null, false, TRACK_USAGE);
    if (!a.company || !a.role) fail('--company and --role are required');
    const map = { company: 'company', role: 'role', url: 'url', 'job-key': 'jobKey', status: 'status', track: 'track', resume: 'resumePath', cover: 'coverPath', channel: 'channel', location: 'location', deadline: 'deadline', notes: 'notes', 'work-mode': 'workMode', 'app-dir': 'appDir' };
    const fields = {};
    for (const [flag, key] of Object.entries(map)) if (a[flag] !== undefined) fields[key] = a[flag];
    if (a.fit !== undefined || a.verdict !== undefined) fields.fit = { score: a.fit, verdict: a.verdict };
    Object.assign(fields, parseFields(a.field));
    let res;
    try {
      res = await s.addOrUpdate(fields, { upsert: !!a.upsert });
    } catch (err) {
      if (err.name === 'ConflictError') fail(err.message);
      throw err;
    }
    return out(res.app, a.json, (x) => `${res.created ? 'Added' : 'Updated existing'} ${x.id}: ${x.company} - ${x.role} [${x.status}]`);
  }
  if (sub === 'update') {
    const a = parse(rest, {
      status: { type: 'string' }, note: { type: 'string' }, 'next-action': { type: 'string' }, 'next-date': { type: 'string' },
      field: { type: 'string', multiple: true },
    });
    if (a.help) return out(null, false, TRACK_USAGE);
    const id = a._[0];
    if (!id) fail('usage: gaj track update <id> [--status s] [--note "..."]');
    const fields = parseFields(a.field);
    if (a.status !== undefined) fields.status = a.status;
    if (a['next-action'] !== undefined) fields.nextAction = a['next-action'];
    if (a['next-date'] !== undefined) fields.nextActionDate = a['next-date'];
    const app = await s.update(id, fields, { note: a.note });
    return out(app, a.json, (x) => `Updated ${x.id}: ${x.company} - ${x.role} [${x.status}]`);
  }
  if (sub === 'list') {
    const a = parse(rest, { status: { type: 'string' } }, { allowPositionals: false });
    if (a.status && !STATUSES.includes(a.status)) fail(`status must be one of ${STATUSES.join(', ')}`);
    const apps = s.list({ status: a.status }).map((x) => ({ ...x, lastActivityAt: lastActivityAt(x) }));
    return out(apps, a.json, table);
  }
  fail(`usage:\n${TRACK_USAGE}`);
}

export const commands = {
  tracker: {
    summary: 'Start the local tracker web UI (127.0.0.1)',
    usage: 'gaj tracker [--port 4317] [--no-open] [--demo]',
    run: async (argv) => {
      const a = parse(argv, { port: { type: 'string' }, 'no-open': { type: 'boolean' }, demo: { type: 'boolean' } }, { allowPositionals: false });
      if (a.help) return out(null, false, commands.tracker.usage);
      const port = a.port === undefined ? 4317 : Number(a.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be 0-65535');
      const { createTrackerServer } = await import('./server.js');
      let s = defaultStore();
      if (a.demo) {
        const { prepareDemoRoot } = await import('./demo.js');
        const { cleanupOnExit } = await import('./demo.js');
        const root = prepareDemoRoot();
        cleanupOnExit(root);
        s = createStore({ root, trackerFile: path.join(root, 'data', 'tracker.json'), jobsFile: path.join(root, 'data', 'jobs.json') });
        console.log(`Demo mode: serving sample data from ${root} (your data/ is untouched)`);
      }
      const srv = createTrackerServer({ store: s, port, meta: { demo: !!a.demo } });
      let info;
      try {
        info = await srv.listen();
      } catch (err) {
        if (err.code === 'EADDRINUSE') fail(`port ${port} is in use. Is the tracker already running? Try --port ${port + 1}`);
        throw err;
      }
      console.log(`Tracker running at ${info.url}  (Ctrl+C to stop)`);
      if (!a['no-open']) openBrowser(info.url);
      const stop = () => { srv.close().then(() => process.exit(0)); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => {}); // run until signalled
    },
  },
  track: {
    summary: 'Add, update or list tracked applications',
    usage: TRACK_USAGE,
    run: trackCmd,
  },
  export: {
    summary: 'Export the tracker (csv, xlsx, tsv, json)',
    usage: 'gaj export [--format csv|xlsx|tsv|json] [--out path]',
    run: async (argv) => {
      const a = parse(argv, { format: { type: 'string', default: 'csv' }, out: { type: 'string' } }, { allowPositionals: false });
      if (a.help) return out(null, false, commands.export.usage);
      const f = FORMATS[a.format];
      if (!f) fail('--format must be csv, xlsx, tsv or json');
      const apps = defaultStore().list();
      const data = await exportApplications(apps, a.format);
      const file = path.resolve(a.out ?? path.join(paths.exports, `tracker-${new Date().toISOString().slice(0, 10)}.${f.ext}`));
      if (!isAllowedOut(file)) fail('--out must be inside data/, profile/ or the OS temp dir');
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, data);
      const shown = file.startsWith(paths.root + path.sep) ? path.relative(paths.root, file) : file;
      out({ file: shown, format: a.format, rows: apps.length }, a.json, (x) => `Exported ${x.rows} application(s) to ${x.file}`);
    },
  },
};
