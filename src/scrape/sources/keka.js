// Keka Hire career portals: https://<tenant>.keka.com/careers/
// The portal page references its portal id (GUID); jobs come from the same public JSON the
// embedded widget uses: GET https://<tenant>.keka.com/careers/api/embedjobs/default/active/<guid>.
// robots.txt on *.keka.com disallows everything except /careers (which these URLs are under).
import { request, getJSON, isApiUrl } from '../http.js';
import { robotsAllows } from '../robots.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary } from '../job.js';

const HOST_RE = /^([a-z0-9][a-z0-9-]{0,62})\.keka\.com$/;
const GUID_RE = /(?:\/ats\/documents\/|embedjobs\/default\/active\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Parse "https://<tenant>.keka.com/careers/..." → {origin, tenant} or null. */
export function parseKekaUrl(url) {
  try {
    const u = new URL(url);
    const m = HOST_RE.exec(u.hostname.toLowerCase());
    return u.protocol === 'https:' && m && isApiUrl(u.origin) ? { origin: u.origin, tenant: m[1] } : null;
  } catch { return null; }
}

/** The portal GUID referenced by a Keka careers page, or null. */
export const portalId = (html) => GUID_RE.exec(String(html ?? ''))?.[1] ?? null;

/**
 * Normalise the embedjobs array.
 * @param {object[]} list
 * @param {{name: string, url: string}} company
 */
export function normalize(list, company) {
  const k = parseKekaUrl(company.url);
  return (Array.isArray(list) ? list : []).filter((j) => j?.title && j.id != null).map((j) => {
    const locs = (j.jobLocations ?? []).map((l) => [l.city ?? l.name, l.state, l.countryName].filter(Boolean).join(', ')).filter(Boolean);
    const sr = j.salaryRange ?? {};
    return makeJob({
      title: j.title,
      company: company.name,
      location: locs[0] ?? '',
      locations: locs.slice(1),
      countryHints: (j.jobLocations ?? []).map((l) => l.countryCode).filter(Boolean),
      workModeField: j.isRemote === true ? 'remote' : null,
      url: k ? `${k.origin}/careers/jobdetails/${j.id}` : null,
      applyUrl: k ? `${k.origin}/careers/jobdetails/${j.id}` : null,
      source: 'keka',
      sourceId: j.id,
      department: j.departmentName,
      salary: makeSalary(sr.min ?? sr.minSalary, sr.max ?? sr.maxSalary, sr.currency, 'year'),
      postedAt: j.publishedOn ?? null,
      description: htmlToText(j.description ?? ''),
    });
  });
}

async function load(k, opts) {
  if (!(await (opts.robots ?? robotsAllows)(`${k.origin}/careers/`))) throw new Error(`robots.txt on ${k.origin} disallows /careers/`);
  // Same-origin redirects only (unknown tenants redirect to /careers/Content/TenantNotFound.html).
  const res = await request(`${k.origin}/careers/`, { timeout: 20000, retries: 1, sameOrigin: true, ...opts.http });
  const page = await res.text();
  const id = portalId(page);
  if (!id) throw new Error(/TenantNotFound/i.test(`${res.url} ${page.slice(0, 2000)}`) ? `no Keka tenant "${k.tenant}"` : `no Keka careers portal found at ${k.origin}/careers/`);
  return getJSON(`${k.origin}/careers/api/embedjobs/default/active/${id}`, { timeout: 20000, retries: 1, noRedirect: true, ...opts.http });
}

/** Fetch all active jobs for a `{name, url}` Keka entry (2 requests). */
export async function fetchJobs(company, opts = {}) {
  const k = parseKekaUrl(company.url);
  if (!k) throw new Error(`${company.name}: keka entries need "url": "https://<tenant>.keka.com/careers/"`);
  return normalize(await load(k, opts), company);
}

/** Verify a Keka careers URL. */
export async function check(url, opts = {}) {
  const k = parseKekaUrl(url);
  if (!k) return { ok: false, jobs: 0, sample: [], error: 'not a Keka careers URL (https://<tenant>.keka.com/careers/)' };
  try {
    const list = await load(k, opts);
    return { ok: list.length > 0, jobs: list.length, sample: list.map((j) => j.title).slice(0, 5), ...(list.length ? {} : { error: 'portal has 0 active jobs' }) };
  } catch (err) {
    return { ok: false, jobs: 0, sample: [], error: err.message };
  }
}

/** One job by its "https://<tenant>.keka.com/careers/jobdetails/<id>" URL (reads the portal list). */
export async function fetchOne(url, opts = {}) {
  const k = parseKekaUrl(url);
  const id = /\/careers\/jobdetails\/(\d+)/.exec(new URL(url).pathname)?.[1];
  if (!k || !id) throw new Error(`not a Keka job URL: ${url}`);
  const jobs = normalize(await load(k, opts), { name: opts.companyName ?? k.tenant, url });
  const job = jobs.find((j) => j.sourceId === id);
  if (!job) throw new Error(`Keka job ${id} is no longer active`);
  return job;
}
