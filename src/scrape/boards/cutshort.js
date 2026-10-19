// Cutshort (cutshort.io): email-alert parsing only, no scraper.
// Investigated 2026-10-19: /job/<slug> pages are robots-allowed and public, and sitemap_jobs.xml
// lists ~44k job URLs, but the Terms say "You may not use any automated process or service to
// access and/or use the Service" and "must not conduct any systematic or automated data collection"
// (scraping is called out as prohibited). Its public API/MCP is a paid recruiter product. So jobs
// come from the user's own Cutshort job-alert emails (`/email-alerts`).
import { parseAlertBody, unwrapRedirect, stripTracking } from './alertEmail.js';

export const PLATFORM = 'cutshort';
export const SCRAPER = false;

const HOST_RE = /^(www\.)?cutshort\.io$/i;
// /job/<Title-City-Company>-<id>, plus short view links /vj/<id> and /view/j/<id>.
const JOB_PATH_RE = /^\/(?:job\/[A-Za-z0-9%._~-]+-[A-Za-z0-9_]{6,12}|vj\/[A-Za-z0-9_-]{4,}|view\/j\/[A-Za-z0-9_-]{4,})\/?$/;

/**
 * Canonical Cutshort job URL (https://cutshort.io/job/…, no query/fragment). Redirect wrappers
 * with the real URL in a param are unwrapped; non-job URLs only lose tracking params.
 * @param {string} url
 * @returns {string|null}
 */
export function normalizeJobUrl(url) {
  const clean = stripTracking(unwrapRedirect(String(url ?? '').trim()));
  if (!clean) return null;
  const u = new URL(clean);
  if (!HOST_RE.test(u.hostname)) return clean;
  u.hostname = 'cutshort.io';
  if (!JOB_PATH_RE.test(u.pathname)) return u.href;
  return `https://cutshort.io${u.pathname.replace(/\/$/, '')}`;
}

/** Whether `url` is a Cutshort job posting URL. */
export function isPlatformJobUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    return /^https?:$/.test(u.protocol) && HOST_RE.test(u.hostname) && JOB_PATH_RE.test(u.pathname);
  } catch { return false; }
}

/** Cutshort slugs mix title, city and company without delimiters, so nothing is inferred. */
export function jobFromUrl() {
  return {};
}

/**
 * Parse a Cutshort job-alert / recommendation email.
 * @param {string} text plain-text (or HTML) email body
 * @returns {{title: string, company: string, location: string, url: string}[]}
 */
export function parseAlertEmail(text) {
  return parseAlertBody(text, { isJobUrl: isPlatformJobUrl, normalize: normalizeJobUrl, fromUrl: jobFromUrl });
}
