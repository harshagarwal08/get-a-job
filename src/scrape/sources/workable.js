import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob } from '../job.js';

const BASE = 'https://apply.workable.com/api';

const locString = (l) => [l.city, l.region ?? l.state, l.country].filter(Boolean).join(', ');

/**
 * Normalise one Workable job (widget `?details=true` shape or v2 single-job shape).
 * @param {object} j
 * @param {{name: string, slug?: string}} company
 */
export function normalizeOne(j, company) {
  const locs = (j.locations ?? []).filter((l) => !l.hidden).map(locString);
  const primary = j.location ? locString(j.location) : (locs[0] ?? locString(j));
  const hints = [...(j.locations ?? []).map((l) => l.countryCode || l.country), j.location?.countryCode, j.country].filter(Boolean);
  const description = [j.description, j.requirements, j.benefits].filter(Boolean).map(htmlToText).join('\n\n');
  const url = j.url ?? j.shortlink ?? (company.slug ? `https://apply.workable.com/${company.slug}/j/${j.shortcode}/` : null);
  return makeJob({
    title: j.title,
    company: company.name,
    location: primary,
    locations: locs.filter((l) => l !== primary),
    countryHints: hints,
    workModeField: j.workplace ?? (j.telecommuting || j.remote ? 'remote' : null),
    url,
    applyUrl: j.application_url ?? (url ? `${url.replace(/\/$/, '')}/apply` : null),
    source: 'workable',
    sourceId: j.shortcode,
    department: Array.isArray(j.department) ? j.department[0] : j.department,
    salary: null,
    postedAt: j.published_on ?? j.published ?? j.created_at,
    description,
  });
}

/** Normalise a Workable widget payload (`{name, jobs: [...]}`). */
export function normalize(payload, company) {
  return (payload?.jobs ?? []).map((j) => normalizeOne(j, company));
}

/** Fetch all jobs (with descriptions) for an account. */
export async function fetchJobs(company, opts = {}) {
  return normalize(await getJSON(`${BASE}/v1/widget/accounts/${encodeURIComponent(company.slug)}?details=true`, opts.http), company);
}

/** Fetch one job by account slug and shortcode. */
export async function fetchOne(slug, shortcode, opts = {}) {
  const j = await getJSON(`${BASE}/v2/accounts/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(shortcode)}`, opts.http);
  return normalizeOne(j, { name: opts.companyName ?? slug, slug });
}
