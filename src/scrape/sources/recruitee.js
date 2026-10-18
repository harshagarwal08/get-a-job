import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary, salaryUnit } from '../job.js';

const base = (slug) => `https://${encodeURIComponent(slug)}.recruitee.com/api/offers`;

/**
 * Normalise one Recruitee offer.
 * @param {object} o
 * @param {{name: string, slug?: string}} company
 */
export function normalizeOne(o, company) {
  const locs = (o.locations ?? []).map((l) => [l.city, l.state, l.country].filter(Boolean).join(', ')).filter(Boolean);
  const primary = o.location || locs[0] || [o.city, o.country].filter(Boolean).join(', ');
  const sal = o.salary;
  return makeJob({
    title: o.title,
    company: company.name ?? o.company_name,
    location: primary,
    locations: locs.filter((l) => l !== primary),
    countryHints: [o.country_code, ...(o.locations ?? []).map((l) => l.country_code ?? l.country)].filter(Boolean),
    workModeField: o.remote ? 'remote' : o.hybrid ? 'hybrid' : o.on_site ? 'onsite' : null,
    url: o.careers_url ?? (company.slug ? `https://${company.slug}.recruitee.com/o/${o.slug}` : null),
    applyUrl: o.careers_apply_url ?? null,
    source: 'recruitee',
    sourceId: o.slug ?? o.id,
    department: o.department,
    salary: sal ? makeSalary(sal.min, sal.max, sal.currency, salaryUnit(sal.period)) : null,
    postedAt: o.published_at ?? o.created_at,
    description: [o.description, o.requirements].filter(Boolean).map(htmlToText).join('\n\n'),
  });
}

/** Normalise a Recruitee offers payload (`{offers: [...]}`); unpublished offers are skipped. */
export function normalize(payload, company) {
  return (payload?.offers ?? []).filter((o) => !o.status || o.status === 'published').map((o) => normalizeOne(o, company));
}

/** Fetch all published offers. */
export async function fetchJobs(company, opts = {}) {
  return normalize(await getJSON(`${base(company.slug)}/`, opts.http), company);
}

/** Fetch one offer by company slug and offer slug. */
export async function fetchOne(slug, offerSlug, opts = {}) {
  const d = await getJSON(`${base(slug)}/${encodeURIComponent(offerSlug)}`, opts.http);
  return normalizeOne(d.offer ?? d, { name: opts.companyName ?? d.offer?.company_name ?? slug, slug });
}
