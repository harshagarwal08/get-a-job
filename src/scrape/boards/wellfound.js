// Wellfound (ex-AngelList Talent): email-alert parsing only, no scraper.
// Investigated 2026-10-19: role/location SEO pages (/role/l/<role>/<city>) are robots-allowed and
// served without login (Next.js __NEXT_DATA__ with an Apollo cache of listings), but the Terms
// forbid copying Content "through the use of automated or non-automated harvesting, collection or
// scraping", /search and /jobs?jobId= are robots-disallowed, and the site sits behind Cloudflare
// (+ bot management). So jobs come from the user's own Wellfound alert emails (`/email-alerts`).
import { parseAlertBody, unwrapRedirect, stripTracking, unslug } from './alertEmail.js';

export const PLATFORM = 'wellfound';
export const SCRAPER = false;

const HOST_RE = /^(www\.)?(wellfound\.com|angel\.co|angellist\.com)$/i;
const JOB_PATH_RE = /^\/(?:company\/([^/]+)\/)?jobs\/(\d+)(?:-([a-z0-9-]+))?\/?$/i;

/**
 * Canonical Wellfound job URL: https host `wellfound.com` (angel.co → wellfound.com), no
 * tracking params or fragment; `/jobs?jobId=N` → `/jobs/N`. Redirect wrappers carrying the
 * real URL in a param (`?url=`) are unwrapped. Non-job URLs only lose tracking params.
 * @param {string} url
 * @returns {string|null} null if not an http(s) URL
 */
export function normalizeJobUrl(url) {
  const clean = stripTracking(unwrapRedirect(String(url ?? '').trim()));
  if (!clean) return null;
  const u = new URL(clean);
  if (!HOST_RE.test(u.hostname)) return clean;
  u.hostname = 'wellfound.com';
  const id = u.pathname.replace(/\/$/, '') === '/jobs' ? (u.searchParams.get('jobId') ?? u.searchParams.get('job_id')) : null;
  if (id && /^\d+$/.test(id)) return `https://wellfound.com/jobs/${id}`;
  const m = JOB_PATH_RE.exec(u.pathname);
  if (!m) return u.href;
  return `https://wellfound.com${u.pathname.replace(/\/$/, '')}`;
}

/** Whether `url` is a Wellfound (or legacy angel.co) job posting URL. */
export function isPlatformJobUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (!/^https?:$/.test(u.protocol) || !HOST_RE.test(u.hostname)) return false;
    if (JOB_PATH_RE.test(u.pathname)) return true;
    return u.pathname.replace(/\/$/, '') === '/jobs' && /^\d+$/.test(u.searchParams.get('jobId') ?? '');
  } catch { return false; }
}

/** Title (and company, for /company/<slug>/jobs/… URLs) from the URL slug. */
export function jobFromUrl(url) {
  try {
    const m = JOB_PATH_RE.exec(new URL(url).pathname);
    if (!m) return {};
    return { title: m[3] ? unslug(m[3]) : '', company: m[1] ? unslug(m[1]) : '' };
  } catch { return {}; }
}

/**
 * Parse a Wellfound job-alert / "New match" / saved-search digest email.
 * @param {string} text plain-text (or HTML) email body
 * @returns {{title: string, company: string, location: string, url: string}[]}
 */
export function parseAlertEmail(text) {
  return parseAlertBody(text, { isJobUrl: isPlatformJobUrl, normalize: normalizeJobUrl, fromUrl: jobFromUrl });
}
