// Zoho Recruit career sites: https://<tenant>.zohorecruit.com/jobs/Careers (also .in/.eu/.com.au)
// or a custom domain serving the same portal (e.g. careers.zohocorp.com/jobs/Careers).
// The portal page embeds its published openings as JSON in <input type="hidden" id="jobs">;
// robots.txt allows /jobs/. Custom domains can't be allowlisted, so requests go through
// safeFetch (public-IP guard, robots per URL, 5 MB cap). Job URL: <origin>/jobs/Careers/<id>.
import { safeGet } from '../safeFetch.js';
import { robotsAllows } from '../robots.js';
import { decodeEntities, htmlToText } from '../text.js';
import { makeJob } from '../job.js';

/** Portal URL for an entry: "<origin>/jobs/Careers". */
export function portalUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? `${u.origin}/jobs/Careers` : null;
  } catch { return null; }
}

/** Parse the hidden `jobs` input; null when the page isn't a Zoho Recruit portal. */
export function embeddedJobs(html) {
  const s = String(html ?? '');
  const m = /<input[^>]*\bvalue="([^"]*)"[^>]*\bid="jobs"/i.exec(s) ?? /<input[^>]*\bid="jobs"[^>]*\bvalue="([^"]*)"/i.exec(s);
  if (!m) return null;
  try {
    const list = JSON.parse(decodeEntities(m[1]));
    return Array.isArray(list) ? list : null;
  } catch { return null; }
}

/**
 * Normalise embedded Zoho Recruit openings (only `Publish !== false`).
 * @param {object[]} list
 * @param {{name: string, url: string}} company
 */
export function normalize(list, company) {
  const base = portalUrl(company.url);
  return (Array.isArray(list) ? list : []).filter((j) => j && j.id && (j.Posting_Title || j.Job_Opening_Name) && j.Publish !== false).map((j) => {
    const country = j.Country ?? j.Country1 ?? null;
    const location = [j.City, j.State, country].filter((x) => x && x !== '-None-').join(', ');
    return makeJob({
      title: j.Posting_Title ?? j.Job_Opening_Name,
      company: company.name,
      location: j.Remote_Job ? `Remote${location ? ` (${location})` : ''}` : location,
      countryHints: country && country !== '-None-' ? [country] : [],
      workModeField: j.Remote_Job ? 'remote' : null,
      url: base ? `${base}/${j.id}` : null,
      applyUrl: base ? `${base}/${j.id}` : null,
      source: 'zohorecruit',
      sourceId: j.id,
      department: j.Industry ?? null,
      postedAt: j.Date_Opened ?? null,
      description: htmlToText(j.Job_Description ?? ''),
    });
  });
}

async function load(url, opts) {
  const res = await safeGet(url, { robots: opts.robots ?? robotsAllows, timeout: 30000, ...(opts.safe ?? {}) });
  const list = embeddedJobs(res.text);
  if (!list) throw new Error(`${url} is not a Zoho Recruit career portal (no embedded job list)`);
  return list;
}

/** Fetch all published openings for a `{name, url}` Zoho Recruit entry (1 request). */
export async function fetchJobs(company, opts = {}) {
  const url = portalUrl(company.url);
  if (!url) throw new Error(`${company.name}: zohorecruit entries need an https "url" (…/jobs/Careers)`);
  return normalize(await load(url, opts), company);
}

/** Verify a Zoho Recruit portal URL. */
export async function check(url, opts = {}) {
  const p = portalUrl(url);
  if (!p) return { ok: false, jobs: 0, sample: [], error: 'zohorecruit needs an https portal URL (…/jobs/Careers)' };
  try {
    const jobs = normalize(await load(p, opts), { name: 'x', url: p });
    return { ok: jobs.length > 0, jobs: jobs.length, sample: jobs.map((j) => j.title).slice(0, 5), ...(jobs.length ? {} : { error: 'portal has 0 published jobs' }) };
  } catch (err) {
    return { ok: false, jobs: 0, sample: [], error: err.message };
  }
}

/** One opening by "<origin>/jobs/Careers/<id>[/...]" (reads the portal list). */
export async function fetchOne(url, opts = {}) {
  const id = /\/jobs\/Careers\/(\d+)/.exec(new URL(url).pathname)?.[1];
  if (!id) throw new Error(`not a Zoho Recruit job URL: ${url}`);
  const jobs = normalize(await load(portalUrl(url), opts), { name: opts.companyName ?? new URL(url).hostname, url });
  const job = jobs.find((j) => j.sourceId === id);
  if (!job) throw new Error(`Zoho Recruit job ${id} is no longer published`);
  return job;
}
