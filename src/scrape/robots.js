import { safeGet } from './safeFetch.js';

/**
 * Parse robots.txt into rules for the `*` group (or a group naming `agent`).
 * @param {string} txt
 * @param {string} [agent] product token, e.g. "get-a-job-cli"
 * @returns {{allow: boolean, path: string}[]}
 */
export function parseRobots(txt, agent = 'get-a-job-cli') {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(txt ?? '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && !val) continue; // empty Disallow = allow all
      cur.rules.push({ allow: key === 'allow', path: val });
    }
  }
  const a = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes('*'));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp('^' + body.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(path);
}

/**
 * Longest-match robots decision; Allow wins ties.
 * @param {{allow: boolean, path: string}[]} rules
 * @param {string} path path + query, e.g. "/jobs/123?x=1"
 * @returns {boolean}
 */
export function isAllowed(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.replace(/\$$/, '').length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

const CACHE_TTL = 10 * 60 * 1000;
const CACHE_MAX = 200;
const cache = new Map(); // origin → {at, rules}

/** Forget cached robots.txt rules (tests). */
export function clearRobotsCache() { cache.clear(); }
/** Seed the cache for an origin (tests: avoids network). */
export function primeRobotsCache(origin, txt) { cache.set(new URL(origin).origin, { at: Date.now(), rules: parseRobots(txt) }); }

/**
 * Fetch robots.txt for a URL's origin and check the path. Missing robots.txt = allowed.
 * Rules are cached per origin for 10 minutes (one robots.txt fetch per site per run, not per URL);
 * calls with injected `fetchImpl`/`lookup` (tests) bypass the cache.
 * @param {string} url
 * @param {object} [opts] passed to safeGet (lookup/fetchImpl in tests)
 * @returns {Promise<boolean>}
 */
export async function robotsAllows(url, opts = {}) {
  const u = new URL(url);
  const cacheable = !opts.fetchImpl && !opts.lookup;
  const hit = cacheable ? cache.get(u.origin) : null;
  let rules = hit && Date.now() - hit.at < CACHE_TTL ? hit.rules : null;
  if (!rules) {
    let txt = '';
    try {
      txt = (await safeGet(`${u.origin}/robots.txt`, { ...opts, robots: null, timeout: 10000, maxBytes: 512 * 1024 })).text;
    } catch {
      txt = ''; // missing or unreachable robots.txt: no rules apply
    }
    rules = parseRobots(txt);
    if (cacheable) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(u.origin, { at: Date.now(), rules });
    }
  }
  return isAllowed(rules, u.pathname + u.search);
}
