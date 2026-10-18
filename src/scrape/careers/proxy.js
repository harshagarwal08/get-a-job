// In-process forward proxy for headless Chrome. Chrome is launched with
// --proxy-server pointing here (and --proxy-bypass-list=<-loopback> so even localhost goes
// through it), so EVERY connection the page opens — fetch/XHR, WebSocket, service workers,
// iframes — is resolved and checked here: the proxy resolves the host itself, refuses any
// private/loopback/link-local/ULA/mapped address (safeFetch's checks), then connects to the
// exact IP it checked, which also closes the DNS-rebinding window.
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { assertPublicHost } from '../safeFetch.js';

const IDLE_MS = 30_000;

/**
 * Resolve `host` and return one public IP, using safeFetch's assertPublicHost for the checks.
 * @param {string} host
 * @param {Function} lookup
 */
export async function resolvePublic(host, lookup = dns.promises.lookup) {
  let addrs = null;
  const capture = async (h, o) => (addrs = await lookup(h, o));
  await assertPublicHost(host, capture);
  const bare = host.replace(/^\[|\]$/g, '');
  return net.isIP(bare) ? bare : addrs[0].address;
}

/**
 * Start the proxy on 127.0.0.1 (random port).
 * @param {object} [o]
 * @param {Function} [o.lookup] DNS lookup (tests)
 * @param {(ip: string, port: number) => net.Socket} [o.dial] connect to a checked IP (tests redirect it)
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>, log: {host: string, port: number, ok: boolean, reason?: string}[]}>}
 */
export async function startProxy({ lookup = dns.promises.lookup, dial = (ip, port) => net.connect({ host: ip, port }) } = {}) {
  const log = [];
  const sockets = new Set();

  async function target(host, port) {
    const p = Number(port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port ${port}`);
    try {
      const ip = await resolvePublic(host, lookup);
      log.push({ host, port: p, ok: true });
      return { ip, port: p };
    } catch (e) {
      log.push({ host, port: p, ok: false, reason: e.message });
      throw e;
    }
  }

  const server = http.createServer(async (req, res) => {
    // plain-http request in absolute-URI form
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (u.protocol !== 'http:') { res.writeHead(400).end(); return; }
    let t;
    try { t = await target(u.hostname, u.port || 80); } catch { res.writeHead(403, { 'content-type': 'text/plain' }).end('blocked'); return; }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const up = http.request({ host: t.ip, port: t.port, method: req.method, path: u.pathname + u.search, headers, createConnection: () => dial(t.ip, t.port) }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    up.setTimeout(IDLE_MS, () => up.destroy(new Error('timeout')));
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  });

  server.on('connect', async (req, client, head) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(req.url ?? '');
    let t;
    try {
      if (!m) throw new Error('bad CONNECT target');
      t = await target(m[1], m[2]);
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const up = dial(t.ip, t.port);
    sockets.add(up);
    up.on('close', () => sockets.delete(up));
    up.setTimeout(IDLE_MS, () => up.destroy());
    up.on('error', () => { if (client.writable) client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    up.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    log,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}
