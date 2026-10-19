// Instahyre (instahyre.com): email-alert parsing only, no scraper.
// Investigated 2026-10-19: robots.txt allows everything and sitemap-jobs.xml (387 pages) lists
// /job-<id>-<title>-at-<company>-<city>/ URLs, but job pages are AngularJS shells (details load
// from /api/v1/… client-side, no JobPosting JSON-LD) and the Terms forbid using "manual or automated
// software, devices, or other processes to crawl or spider any part of the Platform" and to
// "harvest or scrape" any Content. So jobs come from the user's own Instahyre opportunity emails.
import { parseAlertBody, unwrapRedirect, stripTracking, unslug } from './alertEmail.js';
import { detectCountries } from '../geo.js';

export const PLATFORM = 'instahyre';
export const SCRAPER = false;

const HOST_RE = /^(www\.)?instahyre\.com$/i;
const DASH_RE = /^\/job-(\d+)(?:-([a-z0-9-]*))?\/?$/i;
const SLASH_RE = /^\/job\/(\d+)(?:\/([a-z0-9-]*))?\/?$/i;
const OPP_RE = /^\/candidate\/opportunities\/?$/i;

/**
 * Canonical Instahyre job URL: `https://www.instahyre.com/job-<id>-<slug>/` (trailing slash
 * kept, query/fragment dropped). `/candidate/opportunities/?job_id=N` keeps only `job_id`.
 * Redirect wrappers are unwrapped; non-job URLs only lose tracking params.
 * @param {string} url
 * @returns {string|null}
 */
export function normalizeJobUrl(url) {
  const clean = stripTracking(unwrapRedirect(String(url ?? '').trim()));
  if (!clean) return null;
  const u = new URL(clean);
  if (!HOST_RE.test(u.hostname)) return clean;
  u.hostname = 'www.instahyre.com';
  const d = DASH_RE.exec(u.pathname);
  if (d) return `https://www.instahyre.com/job-${d[1]}${d[2] ? `-${d[2]}` : ''}/`;
  const s = SLASH_RE.exec(u.pathname);
  if (s) return `https://www.instahyre.com/job/${s[1]}${s[2] ? `/${s[2]}` : ''}`;
  if (OPP_RE.test(u.pathname)) {
    const id = u.searchParams.get('job_id') ?? u.searchParams.get('jobId');
    if (id && /^\d+$/.test(id)) return `https://www.instahyre.com/candidate/opportunities/?job_id=${id}`;
  }
  return u.href;
}

/** Whether `url` is an Instahyre job posting (or opportunity-with-job_id) URL. */
export function isPlatformJobUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (!/^https?:$/.test(u.protocol) || !HOST_RE.test(u.hostname)) return false;
    if (DASH_RE.test(u.pathname) || SLASH_RE.test(u.pathname)) return true;
    return OPP_RE.test(u.pathname) && /^\d+$/.test(u.searchParams.get('job_id') ?? u.searchParams.get('jobId') ?? '');
  } catch { return false; }
}

/**
 * Title, company and city from `/job-<id>-<title>-at-<company>-<city>/` slugs.
 * @param {string} url
 */
export function jobFromUrl(url) {
  let slug;
  try {
    const p = new URL(url).pathname;
    slug = (DASH_RE.exec(p) ?? SLASH_RE.exec(p))?.[2];
  } catch { return {}; }
  if (!slug) return {};
  const i = slug.lastIndexOf('-at-');
  if (i < 0) return { title: unslug(slug) };
  const title = unslug(slug.slice(0, i));
  const words = slug.slice(i + 4).split('-').filter(Boolean);
  let location = '';
  for (const n of [2, 1]) {
    if (words.length > n && detectCountries(words.slice(-n).join(' ')).includes('IN')) {
      location = unslug(words.splice(-n).join('-'));
      break;
    }
  }
  return { title, company: unslug(words.join('-')), location };
}

/**
 * Parse an Instahyre opportunities / job-match email.
 * @param {string} text plain-text (or HTML) email body
 * @returns {{title: string, company: string, location: string, url: string}[]}
 */
export function parseAlertEmail(text) {
  return parseAlertBody(text, { isJobUrl: isPlatformJobUrl, normalize: normalizeJobUrl, fromUrl: jobFromUrl });
}
