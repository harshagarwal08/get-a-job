export const USER_AGENT = 'get-a-job-cli/0.1 (+https://github.com/harshagarwal08/get-a-job)';
export const BROWSER_HEADERS = {
  'user-agent': `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 ${USER_AGENT}`,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SECRET_PARAMS = /([?&](?:api_key|apikey|key|token|access_token|auth|x-rapidapi-key)=)[^&#\s]*/gi;

/** Strip secret-looking query parameter values from a URL (or any string containing URLs). */
export function redactUrl(s) {
  return String(s ?? '').replace(SECRET_PARAMS, '$1[redacted]');
}

/**
 * Redact secret query params and any of the given secret values from a string.
 * @param {string} s
 * @param {string[]} [secrets]
 */
export function redact(s, secrets = []) {
  let out = redactUrl(s);
  for (const k of secrets) if (k && k.length >= 4) out = out.split(k).join('[redacted]');
  return out;
}

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${redactUrl(url)}`);
    this.status = status;
    this.url = redactUrl(url);
  }
}

// Hosts `request()` may talk to (ATS + board APIs, LinkedIn guest, yc-oss). Every
// redirect hop is re-checked; arbitrary URLs go through safeFetch.js instead.
const API_HOSTS = [
  /^boards-api(\.eu)?\.greenhouse\.io$/, /^api(\.eu)?\.lever\.co$/, /^api\.ashbyhq\.com$/, /^apply\.workable\.com$/,
  /^api\.smartrecruiters\.com$/, /^[a-z0-9-]+\.recruitee\.com$/, /^hn\.algolia\.com$/, /^(www\.)?arbeitnow\.com$/,
  /^(www\.)?remotive\.com$/, /^(www\.)?remoteok\.com$/, /^([a-z0-9-]+\.)?linkedin\.com$/, /^yc-oss\.github\.io$/,
  /^jsearch\.p\.rapidapi\.com$/, /^serpapi\.com$/, /^api\.apify\.com$/,
];
const MAX_REDIRECTS = 5;

/** Whether `request()` is allowed to contact this URL (https + known API host). */
// Suffix patterns for multi-tenant ATS hosts: "*.<suffix>" with exactly `labels` tenant labels.
// e.g. Workday "<tenant>.wd5.myworkdayjobs.com" = 2 labels before "myworkdayjobs.com".
const API_HOST_SUFFIXES = [
  { suffix: 'myworkdayjobs.com', labels: 2, shape: [/^[a-z0-9][a-z0-9-]{0,62}$/, /^wd\d{1,3}$/] },
  { suffix: 'keka.com', labels: 1, exclude: new Set(['www', 'login', 'app', 'api', 'help', 'support', 'status', 'developer', 'developers', 'blog', 'docs', 'cdn', 'mail']) },
];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether `host` is "<labels>.<suffix>" with the exact number of well-formed DNS labels.
 * Rejects lookalikes ("evilmyworkdayjobs.com", "x.myworkdayjobs.com.evil.com"), IPs and
 * extra or empty labels.
 * @param {string} host lowercase hostname
 * @param {{suffix: string, labels: number, shape?: RegExp[]}} rule
 */
export function hostMatchesSuffix(host, { suffix, labels, shape, exclude }) {
  const h = String(host ?? '').toLowerCase();
  if (!h.endsWith(`.${suffix}`)) return false;
  const parts = h.slice(0, -(suffix.length + 1)).split('.');
  if (parts.length !== labels || !parts.every((p) => LABEL.test(p))) return false;
  if (exclude?.has(parts[0])) return false;
  return !shape || shape.every((re, i) => re.test(parts[i]));
}

export function isApiUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.port || u.username || u.password) return false;
    return API_HOSTS.some((re) => re.test(host)) || API_HOST_SUFFIXES.some((r) => hostMatchesSuffix(host, r));
  } catch { return false; }
}

class HostError extends Error {}

// Headers that carry credentials; dropped whenever a redirect leaves the original origin.
const AUTH_HEADERS = ['authorization', 'x-rapidapi-key', 'x-rapidapi-host', 'x-api-key', 'api-key', 'cookie', 'proxy-authorization'];

/** Copy of `headers` without credential headers (case-insensitive). */
export function stripAuthHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !AUTH_HEADERS.includes(k.toLowerCase()) && !/token|secret|key$/i.test(k)));
}

async function fetchManual(url, { onAttempt, noRedirect, sameOrigin, ...init }) {
  let current = url;
  const origin = new URL(url).origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isApiUrl(current)) throw new HostError(`refusing to contact ${redactUrl(current)}: not a known job-board API host`);
    await onAttempt?.(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    await res.body?.cancel?.().catch(() => {});
    if (noRedirect) throw new HostError(`unexpected redirect from ${redactUrl(current)} (redirects are disabled for this call)`);
    current = new URL(loc, current).href;
    if (sameOrigin && new URL(current).origin !== origin) throw new HostError(`refusing redirect off ${origin} to ${redactUrl(current)}`);
    // Never forward credentials to another origin.
    if (new URL(current).origin !== origin) init = { ...init, headers: stripAuthHeaders(init.headers) };
    // Only 307/308 keep the method and body; everything else becomes a GET.
    if (res.status !== 307 && res.status !== 308) init = { ...init, method: 'GET', body: undefined };
  }
  throw new HostError(`too many redirects starting at ${redactUrl(url)}`);
}

/**
 * Request a known API host (see API_HOSTS) with timeout, manual redirects (each hop re-checked)
 * and exponential-backoff retries on network errors, 429 and 5xx. Error messages never
 * contain secret query params or any value listed in `opts.secrets`.
 * @param {string} url
 * `onAttempt(url)` runs before every HTTP attempt (retries and redirect hops included); throw an
 * error with `noRetry: true` from it to stop (used for paid-provider budgets). Credential headers are
 * dropped when a redirect changes origin; `noRedirect` refuses redirects outright.
 * @param {{headers?: object, timeout?: number, retries?: number, backoff?: number, method?: string, body?: string, secrets?: string[], onAttempt?: (url: string) => void|Promise<void>, noRedirect?: boolean}} [opts]
 * @returns {Promise<Response>} a successful (2xx) response
 */
export async function request(url, opts = {}) {
  try {
    return await requestInner(url, opts);
  } catch (err) {
    const secrets = opts.secrets ?? [];
    const safe = Object.assign(new Error(redact(err.message, secrets)), { status: err.status, name: err.name, code: err.code, noRetry: err.noRetry });
    if (err instanceof HttpError || err instanceof HostError) Object.setPrototypeOf(safe, Object.getPrototypeOf(err));
    throw safe;
  }
}

async function requestInner(url, { headers = {}, timeout = 15000, retries = 4, backoff = 500, method = 'GET', body, onAttempt, noRedirect, sameOrigin } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchManual(url, {
        method,
        body,
        onAttempt,
        noRedirect,
        sameOrigin,
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) throw new HttpError(res.status, url);
      lastErr = new HttpError(res.status, url);
      const retryAfter = Number(res.headers.get('retry-after'));
      if (attempt < retries) await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : backoff * 2 ** attempt);
    } catch (err) {
      if (err.noRetry || err instanceof HostError || (err instanceof HttpError && err.status !== 429 && err.status < 500)) throw err;
      lastErr = err.name === 'TimeoutError' ? new Error(`Timed out after ${timeout / 1000}s: ${redactUrl(url)}`) : err;
      if (attempt < retries) await sleep(backoff * 2 ** attempt);
    }
  }
  throw lastErr;
}

/** GET and parse JSON. */
export async function getJSON(url, opts) {
  const res = await request(url, { ...opts, headers: { accept: 'application/json', ...opts?.headers } });
  return res.json();
}

/** GET and return body text. */
export async function getText(url, opts) {
  return (await request(url, opts)).text();
}

/**
 * Run `fn` over items with at most `limit` in flight. Results keep input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, i: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
