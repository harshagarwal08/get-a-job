// Polite, safe HTTP for the careers crawler: safeGet (private-IP guard, manual redirects,
// 5 MB cap) + robots.txt per URL (cached per origin, RFC 9309 error handling) + >=1s between
// requests to a host (shared across concurrent crawls, applied on every redirect hop) + an
// overall deadline.
import { safeGet } from '../safeFetch.js';
import { BROWSER_HEADERS } from '../http.js';
import { parseRobots, isAllowed } from '../robots.js';

export const HOST_GAP_MS = 1000;
export const COMPANY_TIMEOUT_MS = 90_000;
const DISALLOW_ALL = [{ allow: false, path: '/' }];

/** host -> next free slot (ms). Module-level so concurrent crawls share the per-host gap. */
const SHARED_HOST_SLOTS = new Map();

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class DeadlineError extends Error {
  constructor() { super('careers crawl hit its time budget'); this.code = 'DEADLINE'; }
}

/**
 * robots.txt rules from a fetch outcome (RFC 9309 §2.3.1): 2xx → parse; 4xx → no rules;
 * 5xx or network failure → disallow everything.
 */
export function robotsRulesFor(outcome) {
  if (outcome.text !== undefined) return /<html/i.test(outcome.text.slice(0, 500)) ? [] : parseRobots(outcome.text);
  const status = outcome.error?.status;
  if (status >= 400 && status < 500) return [];
  return DISALLOW_ALL;
}

/**
 * @param {object} [o]
 * @param {Function} [o.fetchImpl] fetch (tests)
 * @param {Function} [o.lookup] DNS lookup (tests)
 * @param {(ms: number) => Promise<void>} [o.sleep]
 * @param {() => number} [o.now]
 * @param {number} [o.timeoutMs] total budget
 * @param {number} [o.gapMs] min gap per host
 * @param {Map<string, number>} [o.hostSlots] per-host slot map (default: shared module-level map)
 */
export function createFetcher({ fetchImpl, lookup, sleep = realSleep, now = Date.now, timeoutMs = COMPANY_TIMEOUT_MS, gapMs = HOST_GAP_MS, hostSlots = SHARED_HOST_SLOTS } = {}) {
  const deadline = now() + timeoutMs;
  const robotsCache = new Map();
  const net = { ...(fetchImpl ? { fetchImpl } : {}), ...(lookup ? { lookup } : {}) };
  const stats = { requests: 0 };

  const remaining = () => deadline - now();

  /** Reserve the next slot for `host` (synchronously, so concurrent callers queue) and wait for it. */
  async function polite(host) {
    const t = now();
    const slot = Math.max(t, hostSlots.get(host) ?? -Infinity);
    if (slot - t >= remaining()) throw new DeadlineError();
    hostSlots.set(host, slot + gapMs);
    if (slot > t) await sleep(slot - t);
    if (remaining() <= 0) throw new DeadlineError();
    stats.requests++;
  }

  async function rulesFor(origin) {
    if (!robotsCache.has(origin)) {
      robotsCache.set(origin, (async () => {
        await polite(new URL(origin).host);
        try {
          const r = await safeGet(`${origin}/robots.txt`, { ...net, robots: null, timeout: Math.max(1000, Math.min(10_000, remaining())), maxBytes: 512 * 1024 });
          return robotsRulesFor({ text: r.text });
        } catch (e) {
          if (/refusing|resolve/i.test(e.message)) throw e; // private host / DNS: surface the real reason
          return robotsRulesFor({ error: e });
        }
      })());
    }
    return robotsCache.get(origin);
  }

  /** robots.txt decision for a URL (cached per origin). */
  async function robotsOk(url) {
    const u = new URL(url);
    return isAllowed(await rulesFor(u.origin), u.pathname + u.search);
  }

  /**
   * GET a page. Throws on robots disallow (code ROBOTS), private hosts, HTTP errors, deadline.
   * @returns {Promise<{url: string, status: number, contentType: string, text: string, truncated: boolean}>}
   */
  async function get(url) {
    if (remaining() <= 0) throw new DeadlineError();
    if (!(await robotsOk(url))) {
      const err = new Error(`robots.txt disallows ${url}`);
      err.code = 'ROBOTS';
      throw err;
    }
    await polite(new URL(url).host);
    let first = true;
    // safeGet calls this before every hop: re-check robots, and keep the per-host gap on redirects
    const hopCheck = async (hop) => {
      if (first) { first = false; return true; }
      const ok = await robotsOk(hop);
      if (ok) await polite(new URL(hop).host);
      return ok;
    };
    return safeGet(url, { ...net, headers: BROWSER_HEADERS, robots: hopCheck, timeout: Math.max(1000, Math.min(15_000, remaining())) });
  }

  return { get, robotsOk, remaining, stats, net };
}
