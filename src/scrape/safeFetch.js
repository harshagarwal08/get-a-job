import dns from 'node:dns';
import net from 'node:net';
import { USER_AGENT, HttpError } from './http.js';

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function v4ToInt(ip) {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function expandV6(ip) {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

/**
 * True for loopback, private, link-local, CGNAT, multicast/reserved IPv4 and
 * loopback/unspecified/link-local/ULA/multicast IPv6 (incl. IPv4-mapped).
 * @param {string} ip
 */
export function isPrivateAddress(ip) {
  const fam = net.isIP(String(ip).replace(/^\[|\]$/g, '').split('%')[0]);
  if (fam === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => (n & mask) === (base & mask));
  }
  if (fam === 6) {
    const w = expandV6(ip);
    if (w.every((x) => x === 0)) return true; // ::
    if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
    if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) { // ::ffff:a.b.c.d / ::a.b.c.d
      return isPrivateAddress(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`);
    }
    if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((w[0] & 0xff00) === 0xff00) return true; // multicast
    if (w[0] === 0x64 && w[1] === 0xff9b) return isPrivateAddress(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`); // NAT64
    return false;
  }
  return true; // not an IP: refuse
}

/**
 * Throw unless every address the hostname resolves to is public.
 * @param {string} hostname
 * @param {(host: string, opts: object) => Promise<{address: string}[]>} [lookup]
 */
export async function assertPublicHost(hostname, lookup = dns.promises.lookup) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`refusing to fetch ${hostname}: local/internal host`);
  }
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await lookup(host, { all: true, verbatim: true }); } catch (e) { throw new Error(`cannot resolve ${hostname}: ${e.code ?? e.message}`); }
  }
  if (!addrs?.length) throw new Error(`cannot resolve ${hostname}`);
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`refusing to fetch ${hostname}: it resolves to a private or local address (${bad.address})`);
}

async function readCapped(res, maxBytes) {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'), truncated };
}

/**
 * GET an arbitrary URL safely: http(s) only, every hop's host must resolve to public
 * addresses, redirects followed manually (max 5) with the robots check re-run per hop,
 * body capped at `maxBytes` (truncated, not failed).
 * @param {string} url
 * @param {object} [o]
 * @param {object} [o.headers]
 * @param {(url: string) => Promise<boolean>|null} [o.robots] robots check per hop (null = skip)
 * @param {number} [o.maxBytes]
 * @param {number} [o.timeout]
 * @param {Function} [o.lookup] DNS lookup (tests)
 * @param {Function} [o.fetchImpl] fetch implementation (tests)
 * @returns {Promise<{url: string, status: number, contentType: string, text: string, truncated: boolean}>}
 */
export async function safeGet(url, { headers = {}, robots = null, maxBytes = MAX_BODY_BYTES, timeout = 15000, lookup, fetchImpl = fetch } = {}) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`refusing to fetch ${u.protocol} URL`);
    if (u.username || u.password) throw new Error('refusing to fetch a URL with embedded credentials');
    await assertPublicHost(u.hostname, lookup);
    if (robots && !(await robots(u.href))) {
      const err = new Error(`robots.txt on ${u.host} disallows automated fetching of ${u.pathname}. Open the page in a browser and paste the job description instead.`);
      err.code = 'ROBOTS';
      throw err;
    }
    const res = await fetchImpl(u.href, { headers: { 'user-agent': USER_AGENT, ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), u).href;
      await res.body?.cancel?.().catch(() => {});
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, u.href);
    const { text, truncated } = await readCapped(res, maxBytes);
    return { url: u.href, status: res.status, contentType: res.headers.get('content-type') ?? '', text, truncated };
  }
  throw new Error(`too many redirects (more than ${MAX_REDIRECTS}) starting at ${url}`);
}
