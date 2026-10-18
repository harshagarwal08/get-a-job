import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary, salaryUnit } from '../job.js';

const API = 'https://boards-api.greenhouse.io/v1/boards';

function salaryFrom(ranges) {
  const r = Array.isArray(ranges) ? ranges[0] : null;
  if (!r) return null;
  return makeSalary(r.min_cents / 100, r.max_cents / 100, r.currency_type, salaryUnit(r.title || r.blurb));
}

/**
 * Normalise one Greenhouse job object.
 * @param {object} j raw job
 * @param {{name: string}} company
 */
export function normalizeOne(j, company) {
  const offices = (j.offices ?? []).map((o) => o.location || o.name).filter(Boolean);
  const primary = j.location?.name ?? offices[0] ?? '';
  return makeJob({
    title: j.title,
    company: company.name,
    location: primary,
    locations: offices.filter((o) => !primary.includes(o) && !o.includes(primary)),
    url: j.absolute_url,
    applyUrl: j.absolute_url,
    source: 'greenhouse',
    sourceId: j.id,
    department: j.departments?.[0]?.name,
    salary: salaryFrom(j.pay_input_ranges),
    postedAt: j.first_published ?? j.updated_at,
    description: htmlToText(j.content),
  });
}

/**
 * Normalise a Greenhouse board payload (`{jobs: [...]}`).
 * @param {{jobs: object[]}} payload
 * @param {{name: string}} company
 */
export function normalize(payload, company) {
  return (payload?.jobs ?? []).map((j) => normalizeOne(j, company));
}

/** Fetch all jobs for a company from the public board API. */
export async function fetchJobs(company, opts = {}) {
  return normalize(await getJSON(`${API}/${encodeURIComponent(company.slug)}/jobs?content=true`, opts.http), company);
}

/** Fetch a single posting by board slug and job id. */
export async function fetchOne(slug, id, opts = {}) {
  const j = await getJSON(`${API}/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(id)}?pay_transparency=true`, opts.http);
  return normalizeOne(j, { name: j.company_name || slug });
}
