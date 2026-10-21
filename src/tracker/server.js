// Local tracker server: 127.0.0.1 only, JSON API + static UI. The only outbound requests are the
// ones the user clicks for: fetching a posting's own URL, running a search or a Claude task.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { computeStats } from './stats.js';
import { FORMATS, exportApplications } from './export.js';
import { readJSON, writeJSON } from '../lib/store.js';
import { validatePreferences, REMOTE_SCOPES } from '../lib/preferences.js';
import { TRACK_ID, createSearchRunner } from './search.js';
import { createAgentRunner } from './agent.js';
import { spawn } from 'node:child_process';
import { GAJ_BIN } from './search.js';
import { loadState as loadDigestState, latestDigest } from '../digest/digest.js';
import * as schedule from '../digest/schedule.js';

const EXAMPLE_PREFS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'examples', 'preferences.example.json');
const MAX_BACKUPS = 10;

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_BODY = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Pull app-level options (note) out of a body; the rest are fields.
function splitBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be a JSON object');
  const { note, ...fields } = body;
  return { note, fields };
}

export function createTrackerServer({ store = createStore(), port = 4317, meta = {}, search, agent, scheduleEnv } = {}) {
  const applicationsDir = path.join(store.root, 'data', 'applications');
  const prefsFile = path.join(store.root, 'profile', 'preferences.json');
  const backupsDir = path.join(store.root, 'data', 'backups');
  const runner = search ?? createSearchRunner({ root: store.root, demo: !!meta.demo, jobsFile: store.jobsFile });
  const agentRunner = agent ?? createAgentRunner({ root: store.root, demo: !!meta.demo });
  const fundedFile = path.join(store.root, 'data', 'funded.json');

  // Funded-startup badges: company name (lowercase) -> {round, announcedAt, status}.
  function fundedByName() {
    let db;
    try { db = readJSON(fundedFile, null); } catch { db = null; }
    const map = new Map();
    for (const c of db?.companies ?? []) map.set(String(c.name).toLowerCase(), { id: c.id, round: c.round, announcedAt: c.announcedAt, status: c.status });
    return map;
  }

  // Files in an application's folder (only under data/applications/), for the drawer.
  function appFiles(app) {
    if (!app.appDir) return [];
    let base;
    let dir;
    try { base = fs.realpathSync(applicationsDir); dir = fs.realpathSync(path.resolve(store.root, app.appDir)); } catch { return []; }
    if (!dir.startsWith(base + path.sep)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(pdf|md|txt|html|json)$/i.test(e.name))
      .map((e) => ({ name: e.name, path: path.relative(store.root, path.join(dir, e.name)).split(path.sep).join('/') }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Bulk backfill: `gaj jobs:enrich --json` as a child (it locks jobs.json and pauses between hosts).
  let enriching = false;
  function enrichAll() {
    if (meta.demo) return Promise.resolve({ tried: 0, filled: 0, failed: [], skipped: { host: 0, noUrl: 0, linkedin: 0 } });
    if (enriching) throw new HttpError(409, 'already filling job descriptions');
    enriching = true;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [GAJ_BIN, 'jobs:enrich', '--limit', '40', '--json'], { cwd: path.dirname(path.dirname(GAJ_BIN)), env: { ...process.env, GAJ_ROOT: store.root }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { err += c; });
      child.on('error', (e) => { enriching = false; reject(new HttpError(500, e.message)); });
      child.on('close', (code) => {
        enriching = false;
        try { resolve(JSON.parse(out)); } catch { reject(new HttpError(500, (err.trim().split('\n').pop() || `jobs:enrich exited ${code}`).replace(/^error:\s*/, ''))); }
      });
    });
  }

  async function fetchDescription(key) {
    const job = store.getJob(key);
    const url = [job.applyUrl, job.url].find((u) => typeof u === 'string' && /^https?:\/\//i.test(u));
    if (!url) throw new HttpError(400, 'this job has no posting URL; paste the description instead');
    const prefs = readJSON(prefsFile, null);
    const { fetchPosting } = await import('../scrape/cli.js');
    let res;
    try { res = await fetchPosting(url, { allowLinkedIn: prefs?.sources?.linkedin === true }); } catch (err) { throw new HttpError(502, err.message); }
    if (!res?.text || res.text.trim().length < 200) throw new HttpError(422, 'the page had little readable text (it may need JavaScript or a login); paste the description instead');
    return store.setJobDescription(key, res.text, { via: 'fetched' });
  }

  // Read-only view of this month's paid-provider usage (data/usage.json is written by scrape).
  function usageView(prefs) {
    const month = new Date().toISOString().slice(0, 7);
    let all = {};
    try { all = readJSON(path.join(store.root, 'data', 'usage.json'), {}) ?? {}; } catch { all = {}; }
    const m = all[month] ?? {};
    const src = prefs?.sources ?? {};
    return {
      month,
      googleJobs: { requests: m.googleJobs?.requests ?? 0, limit: src.googleJobs?.maxRequestsPerMonth ?? 100 },
      apify: { usd: m.apify?.usdCap ?? 0, limit: src.apify?.maxUsdPerMonth ?? 5 },
    };
  }

  function getPreferences() {
    let prefs = readJSON(prefsFile, null);
    const exists = prefs !== null;
    if (!exists) prefs = readJSON(EXAMPLE_PREFS, null) ?? { version: 1, tracks: [] };
    const { errors, warnings } = validatePreferences(prefs);
    return { prefs, exists, errors, warnings, remoteScopes: REMOTE_SCOPES, usage: usageView(prefs) };
  }

  function backupPreferences() {
    if (!fs.existsSync(prefsFile)) return null;
    fs.mkdirSync(backupsDir, { recursive: true });
    const name = `preferences-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    fs.copyFileSync(prefsFile, path.join(backupsDir, name));
    const old = fs.readdirSync(backupsDir).filter((f) => /^preferences-.*\.json$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) fs.rmSync(path.join(backupsDir, f), { force: true });
    return name;
  }

  function putPreferences(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body must be the preferences object');
    // Keep top-level keys the client didn't send (forward-compat with fields this UI doesn't know).
    const current = readJSON(prefsFile, null) ?? {};
    const prefs = { ...current, ...body, version: body.version ?? current.version ?? 1 };
    const { errors, warnings } = validatePreferences(prefs);
    if (errors.length) { const e = new HttpError(400, 'preferences are invalid'); e.data = { errors, warnings }; throw e; }
    backupPreferences();
    writeJSON(prefsFile, prefs);
    return { prefs, warnings, usage: usageView(prefs) };
  }

  function startSearch(body) {
    const b = body ?? {};
    if (b.paid !== undefined && typeof b.paid !== 'boolean') throw new HttpError(400, 'paid must be true or false');
    if (b.paid && b.confirmPaid !== true) throw new HttpError(400, 'paid providers need confirmPaid: true');
    const prefs = readJSON(prefsFile, null);
    if (!prefs) throw new HttpError(400, 'no profile/preferences.json yet: save your settings (or run /onboard) first');
    let track;
    if (b.track !== undefined && b.track !== null && b.track !== '') {
      if (typeof b.track !== 'string' || !TRACK_ID.test(b.track)) throw new HttpError(400, 'track must be a track id (lowercase letters, digits, dashes)');
      if (!(prefs.tracks ?? []).some((t) => t.id === b.track)) throw new HttpError(400, `unknown track "${b.track}"`);
      track = b.track;
    }
    let days;
    if (b.days !== undefined && b.days !== null && b.days !== '') {
      days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new HttpError(400, 'days must be an integer 1-365');
    }
    return runner.start({ paid: !!b.paid, track, days });
  }
  let boundPort = port;

  const allowedHost = (host) => {
    if (!host) return false;
    const h = host.toLowerCase();
    return [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(h);
  };
  const allowedOrigin = (origin) =>
    [`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`].includes(origin.toLowerCase());

  function trackMeta() {
    const prefs = readJSON(path.join(store.root, 'profile', 'preferences.json'), null);
    const tracks = Array.isArray(prefs?.tracks) ? prefs.tracks.map((t) => ({ id: String(t.id), name: String(t.name ?? t.id) })) : [];
    return { tracks, demo: !!meta.demo, name: typeof prefs?.name === 'string' ? prefs.name : null };
  }

  function serveFile(res, rel) {
    if (typeof rel !== 'string' || !rel || rel.includes('\0')) throw new HttpError(400, 'path required');
    const abs = path.resolve(store.root, rel);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch { throw new HttpError(404, 'file not found'); }
    let base;
    try { base = fs.realpathSync(applicationsDir); } catch { throw new HttpError(404, 'file not found'); }
    if (!real.startsWith(base + path.sep)) throw new HttpError(403, 'only files under data/applications/ can be opened');
    const st = fs.statSync(real);
    if (!st.isFile()) throw new HttpError(404, 'file not found');
    const ext = path.extname(real).toLowerCase();
    const type = { '.pdf': 'application/pdf', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'text/plain; charset=utf-8' }[ext];
    if (!type) throw new HttpError(415, 'unsupported file type');
    send(res, 200, fs.readFileSync(real), {
      'Content-Type': type,
      // Sandbox anything rendered from data/ so a generated HTML file can't script against the API.
      'Content-Security-Policy': 'sandbox; default-src \'none\'; style-src \'unsafe-inline\'; img-src data:',
      'Content-Disposition': `inline; filename="${path.basename(real).replace(/[^\w.-]/g, '_')}"`,
    });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const abs = path.resolve(PUBLIC_DIR, rel);
    if (!abs.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not found');
    let data;
    try { data = fs.readFileSync(abs); } catch { throw new HttpError(404, 'not found'); }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(abs)] ?? 'application/octet-stream', 'Content-Security-Policy': APP_CSP });
  }

  async function route(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const { pathname } = url;
    const method = req.method;
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (parts[0] !== 'api') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      if (pathname === '/files') return serveFile(res, url.searchParams.get('path'));
      return serveStatic(res, pathname);
    }

    const [, resource, id, action] = parts;
    const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readBody(req) : null;

    if (resource === 'meta' && method === 'GET') return send(res, 200, trackMeta());

    if (resource === 'preferences' && !id) {
      if (method === 'GET') return send(res, 200, getPreferences());
      if (method === 'PUT') return send(res, 200, putPreferences(body));
      throw new HttpError(405, 'method not allowed');
    }

    if (resource === 'digest' && method === 'GET') {
      if (!id) {
        const latest = latestDigest(store.root);
        return send(res, 200, {
          lastDigestAt: loadDigestState(store.root).lastDigestAt,
          latest: latest ? { date: latest.date, path: path.relative(store.root, latest.file).split(path.sep).join('/'), counts: latest.counts, generatedAt: latest.generatedAt } : null,
        });
      }
      if (id === 'latest') {
        const latest = latestDigest(store.root);
        if (!latest) throw new HttpError(404, 'no digest yet: run "gaj digest"');
        return send(res, 200, latest.text, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      throw new HttpError(404, 'not found');
    }

    if (resource === 'schedule' && id === 'status' && method === 'GET') {
      // Read-only: the UI never installs anything.
      return send(res, 200, schedule.status(scheduleEnv ?? schedule.env({ root: store.root })));
    }

    if (resource === 'search') {
      if (!id && method === 'POST') return send(res, 202, startSearch(body));
      if (id === 'status' && method === 'GET') return send(res, 200, runner.status());
      throw new HttpError(405, 'method not allowed');
    }

    if (resource === 'applications') {
      if (!id) {
        if (method === 'GET') {
          const t = store.load();
          return send(res, 200, { updatedAt: t.updatedAt ?? null, applications: t.applications });
        }
        if (method === 'POST') {
          const { note, fields } = splitBody(body);
          return send(res, 201, await store.add(fields, { note: typeof note === 'string' && note.trim() ? note : undefined }));
        }
      } else if (action === 'files' && method === 'GET') {
        return send(res, 200, { files: appFiles(store.get(id)) });
      } else if (action === 'undo' && method === 'POST') {
        return send(res, 200, await store.undo(id));
      } else if (!action) {
        if (method === 'GET') return send(res, 200, store.get(id));
        if (method === 'PATCH') {
          const { note, fields } = splitBody(body);
          return send(res, 200, await store.update(id, fields, { note }));
        }
        if (method === 'DELETE') return send(res, 200, { deleted: (await store.remove(id)).id });
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (resource === 'jobs') {
      if (id === 'enrich' && !action && method === 'POST') return send(res, 200, await enrichAll());
      if (!id && method === 'GET') {
        const key = url.searchParams.get('key');
        if (key) return send(res, 200, store.getJob(key));
        const appByKey = new Map(store.list().filter((a) => a.jobKey).map((a) => [a.jobKey, a]));
        const funded = fundedByName();
        const j = store.loadJobs();
        const jobs = Object.values(j.jobs).map(({ description, ...rest }) => {
          const app = appByKey.get(rest.key);
          return { ...rest, applicationId: app?.id ?? null, tailored: !!app?.resumePath, descLen: typeof description === 'string' ? description.length : 0,
            funded: funded.get(String(rest.company ?? '').toLowerCase()) ?? null };
        });
        return send(res, 200, { updatedAt: j.updatedAt ?? null, jobs });
      }
      if (id && !action && method === 'PATCH') {
        if (!body || typeof body.status !== 'string') throw new HttpError(400, 'body must be {status}');
        return send(res, 200, await store.setJobStatus(id, body.status));
      }
      if (id && action === 'description' && method === 'POST') {
        if (!body || typeof body.text !== 'string') throw new HttpError(400, 'body must be {text}');
        return send(res, 200, await store.setJobDescription(id, body.text, { via: 'pasted' }));
      }
      if (id && action === 'fetch' && method === 'POST') return send(res, 200, await fetchDescription(id));
      if (id && action === 'track' && method === 'POST') {
        const { note, ...fields } = body ?? {};
        return send(res, 201, await store.trackJob(id, fields));
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (resource === 'agent') {
      if (!id && method === 'POST') {
        const b = body ?? {};
        return send(res, 202, agentRunner.start({ task: b.task, key: b.key, id: b.id, kind: b.kind }));
      }
      if (id === 'status' && method === 'GET') return send(res, 200, agentRunner.status());
      throw new HttpError(405, 'method not allowed');
    }

    if (resource === 'stats' && method === 'GET') return send(res, 200, computeStats(store.list()));

    const m = /^export\.(csv|tsv|xlsx|json)$/.exec(resource ?? '');
    if (m && method === 'GET') {
      const f = FORMATS[m[1]];
      const out = await exportApplications(store.list(), m[1]);
      const date = new Date().toISOString().slice(0, 10);
      const headers = { 'Content-Type': f.type };
      if (url.searchParams.get('download') !== '0') headers['Content-Disposition'] = `attachment; filename="tracker-${date}.${f.ext}"`;
      return send(res, 200, Buffer.isBuffer(out) ? out : Buffer.from(out, 'utf8'), headers);
    }

    throw new HttpError(404, 'not found');
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS-rebinding guard: only answer to loopback Host headers.
      if (!allowedHost(req.headers.host)) throw new HttpError(403, 'forbidden host');
      if (!['GET', 'HEAD'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin && !allowedOrigin(origin)) throw new HttpError(403, 'forbidden origin');
        if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new HttpError(403, 'cross-site request');
        const ct = req.headers['content-type'] ?? '';
        // JSON-only bodies: a cross-site <form> can't send application/json without a CORS preflight (never granted).
        if (['POST', 'PATCH', 'PUT'].includes(req.method) && !ct.startsWith('application/json')) {
          throw new HttpError(415, 'content-type must be application/json');
        }
      }
      await route(req, res);
    } catch (err) {
      const status = err instanceof URIError ? 400 : err.status ?? (/is locked by another gaj process/.test(err.message) ? 503 : 500);
      if (err instanceof URIError) err.message = 'malformed URL encoding';
      if (status === 500) console.error(err);
      const extra = err.data ? (err instanceof HttpError ? err.data : { existing: err.data }) : {};
      if (!res.headersSent) send(res, status, { error: err.message, ...extra });
      else res.end();
    }
  });

  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        boundPort = server.address().port;
        resolve({ port: boundPort, url: `http://127.0.0.1:${boundPort}/` });
      });
    }),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
    get port() { return boundPort; },
  };
}
