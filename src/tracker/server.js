// Local tracker server: 127.0.0.1 only, JSON API + static UI. No external requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { computeStats } from './stats.js';
import { FORMATS, exportApplications } from './export.js';
import { readJSON } from '../lib/store.js';

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

export function createTrackerServer({ store = createStore(), port = 4317, meta = {} } = {}) {
  const applicationsDir = path.join(store.root, 'data', 'applications');
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

    if (resource === 'applications') {
      if (!id) {
        if (method === 'GET') {
          const t = store.load();
          return send(res, 200, { updatedAt: t.updatedAt ?? null, applications: t.applications });
        }
        if (method === 'POST') {
          const { note, fields } = splitBody(body);
          return send(res, 201, store.add(fields, { note: typeof note === 'string' && note.trim() ? note : undefined }));
        }
      } else if (action === 'undo' && method === 'POST') {
        return send(res, 200, store.undo(id));
      } else if (!action) {
        if (method === 'GET') return send(res, 200, store.get(id));
        if (method === 'PATCH') {
          const { note, fields } = splitBody(body);
          return send(res, 200, store.update(id, fields, { note }));
        }
        if (method === 'DELETE') return send(res, 200, { deleted: store.remove(id).id });
      }
      throw new HttpError(405, 'method not allowed');
    }

    if (resource === 'jobs') {
      if (!id && method === 'GET') {
        const key = url.searchParams.get('key');
        if (key) return send(res, 200, store.getJob(key));
        const appByKey = new Map(store.list().filter((a) => a.jobKey).map((a) => [a.jobKey, a.id]));
        const j = store.loadJobs();
        const jobs = Object.values(j.jobs).map(({ description, ...rest }) => ({ ...rest, applicationId: appByKey.get(rest.key) ?? null }));
        return send(res, 200, { updatedAt: j.updatedAt ?? null, jobs });
      }
      if (id && !action && method === 'PATCH') {
        if (!body || typeof body.status !== 'string') throw new HttpError(400, 'body must be {status}');
        return send(res, 200, store.setJobStatus(id, body.status));
      }
      if (id && action === 'track' && method === 'POST') {
        const { note, ...fields } = body ?? {};
        return send(res, 201, store.trackJob(id, fields));
      }
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
      const status = err instanceof URIError ? 400 : err.status ?? 500;
      if (err instanceof URIError) err.message = 'malformed URL encoding';
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message, ...(err.data ? { existing: err.data } : {}) });
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
