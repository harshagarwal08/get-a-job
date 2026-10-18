import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary, salaryUnit } from '../job.js';

const API = 'https://api.lever.co/v0/postings';

function describe(p) {
  const parts = [p.description ? htmlToText(p.description) : p.descriptionPlain];
  for (const l of p.lists ?? []) parts.push([l.text, htmlToText(l.content)].filter(Boolean).join('\n'));
  parts.push(p.additional ? htmlToText(p.additional) : p.additionalPlain);
  return parts.map((s) => (s ?? '').trim()).filter(Boolean).join('\n\n');
}

/**
 * Normalise one Lever posting.
 * @param {object} p
 * @param {{name: string}} company
 */
export function normalizeOne(p, company) {
  const c = p.categories ?? {};
  const all = c.allLocations ?? [];
  const sr = p.salaryRange;
  return makeJob({
    title: p.text,
    company: company.name,
    location: c.location ?? all[0] ?? '',
    locations: all.filter((l) => l !== c.location),
    countryHints: p.country ? [p.country] : [],
    workModeField: p.workplaceType === 'unspecified' ? null : p.workplaceType,
    url: p.hostedUrl,
    applyUrl: p.applyUrl ?? p.hostedUrl,
    source: 'lever',
    sourceId: p.id,
    department: c.team || c.department,
    salary: sr ? makeSalary(sr.min, sr.max, sr.currency, salaryUnit(sr.interval)) : null,
    postedAt: p.createdAt,
    description: describe(p),
  });
}

/** Normalise a Lever postings array. */
export function normalize(payload, company) {
  return (Array.isArray(payload) ? payload : []).map((p) => normalizeOne(p, company));
}

/** Fetch all postings for a company. */
export async function fetchJobs(company, opts = {}) {
  return normalize(await getJSON(`${API}/${encodeURIComponent(company.slug)}?mode=json`, opts.http), company);
}

/** Fetch one posting by site slug and posting id. */
export async function fetchOne(slug, id, opts = {}) {
  return normalizeOne(await getJSON(`${API}/${encodeURIComponent(slug)}/${encodeURIComponent(id)}?mode=json`, opts.http), { name: opts.companyName ?? slug });
}
