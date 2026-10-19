// ATSs whose entries are identified by a careers-site URL rather than a guessable slug.
import net from 'node:net';
import * as workday from './sources/workday.js';
import * as successfactors from './sources/successfactors.js';
import * as keka from './sources/keka.js';
import * as zohorecruit from './sources/zohorecruit.js';

export const URL_ATS = { workday, successfactors, keka, zohorecruit };
export const URL_ATS_LIST = Object.keys(URL_ATS);

const ZOHO_HOST = /(^|\.)zohorecruit\.(com|in|eu|com\.au|jp|com\.cn)$/i;
const KNOWN_ATS_HOST = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|myworkdayjobs\.com|keka\.com|zohorecruit\.[a-z.]+|icims\.com|darwinbox\.in|freshteam\.com|turbohire\.co)$/i;

/**
 * Validate a URL for a URL-based ATS and derive a slug. Returns `{url, slug}` or `{error}`.
 * @param {string} ats
 * @param {string} url
 */
/**
 * Reject hosts that can never be a public careers site: IP literals, localhost, single-label
 * and internal-only names, URLs with credentials or ports. (DNS-resolved private addresses are
 * refused again at fetch time by safeFetch.)
 * @param {URL} u
 * @returns {string|null} error
 */
export function unsafeHostReason(u) {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (u.username || u.password) return 'URLs with embedded credentials are not allowed';
  if (u.port) return 'URLs with an explicit port are not allowed';
  if (net.isIP(h)) return 'IP-address URLs are not allowed; use the careers site\'s domain';
  if (h === 'localhost' || !h.includes('.') || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return `${h} is not a public host`;
  return null;
}

export function validateAtsUrl(ats, url) {
  let u;
  try { u = new URL(String(url ?? '')); } catch { return { error: `${ats} needs --url with an https careers URL` }; }
  if (u.protocol !== 'https:') return { error: `${ats} needs an https URL` };
  const unsafe = unsafeHostReason(u);
  if (unsafe) return { error: unsafe };
  if (ats === 'workday') {
    const w = workday.parseWorkdayUrl(u.href);
    return w ? { url: w.siteUrl, slug: w.tenant } : { error: 'workday url must look like https://<tenant>.wd<N>.myworkdayjobs.com/<site>' };
  }
  if (ats === 'keka') {
    const k = keka.parseKekaUrl(u.href);
    return k ? { url: `${k.origin}/careers/`, slug: k.tenant } : { error: 'keka url must look like https://<tenant>.keka.com/careers/' };
  }
  if (ats === 'zohorecruit') {
    if (!ZOHO_HOST.test(u.hostname) && !/^\/jobs\/careers\b/i.test(u.pathname)) return { error: 'zohorecruit url must be https://<tenant>.zohorecruit.com/jobs/Careers or a custom domain …/jobs/Careers' };
    return { url: zohorecruit.portalUrl(u.href), slug: u.hostname.split('.')[0] };
  }
  if (ats === 'successfactors') {
    if (KNOWN_ATS_HOST.test(u.hostname)) return { error: `${u.hostname} belongs to another ATS, not SuccessFactors` };
    return { url: u.origin, slug: u.hostname.replace(/^(jobs|careers|career)\./, '').split('.')[0] };
  }
  return { error: `unknown url-based ats "${ats}"` };
}

/**
 * Classify a careers URL by host shape (no network): url-based ATSs only.
 * @param {string} url
 * @returns {{ats: string, slug: string, url: string}|null}
 */
export function classifyAtsUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const ats of ['workday', 'keka']) {
    const v = validateAtsUrl(ats, u.href);
    if (!v.error) return { ats, ...v };
  }
  if (ZOHO_HOST.test(u.hostname)) return { ats: 'zohorecruit', ...validateAtsUrl('zohorecruit', u.href) };
  return null;
}
