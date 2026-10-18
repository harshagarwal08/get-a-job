import { getJSON, mapLimit } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary, salaryUnit } from '../job.js';

const API = 'https://api.smartrecruiters.com/v1/companies';
const PAGE = 100;
const MAX_POSTINGS = 1000;
const DETAIL_CAP = 40;

const locString = (l = {}) => l.fullLocation || [l.city, l.region, l.country?.toUpperCase()].filter(Boolean).join(', ');

function describe(ad) {
  const sections = ad?.sections ?? {};
  return ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
    .map((k) => sections[k]).filter((x) => x?.text)
    .map((x) => [x.title, htmlToText(x.text)].filter(Boolean).join('\n\n')).join('\n\n');
}

/**
 * Normalise one SmartRecruiters posting (list item or detail; detail adds jobAd/compensation).
 * @param {object} p
 * @param {{name: string, slug?: string}} company
 */
export function normalizeOne(p, company) {
  const l = p.location ?? {};
  const ident = p.company?.identifier ?? company.slug;
  const c = p.compensation;
  return makeJob({
    title: p.name,
    company: company.name ?? p.company?.name,
    location: locString(l),
    countryHints: l.country ? [l.country] : [],
    workModeField: l.remote ? 'remote' : l.hybrid ? 'hybrid' : null,
    url: p.postingUrl ?? `https://jobs.smartrecruiters.com/${encodeURIComponent(ident)}/${p.id}`,
    applyUrl: p.applyUrl ?? null,
    source: 'smartrecruiters',
    sourceId: p.id,
    department: p.department?.label ?? p.function?.label,
    salary: c ? makeSalary(c.min, c.max, c.currency, salaryUnit(c.period)) : null,
    postedAt: p.releasedDate,
    description: describe(p.jobAd),
  });
}

/** Normalise a postings list payload (`{content: [...]}`). Descriptions need fetchOne. */
export function normalize(payload, company) {
  return (payload?.content ?? []).map((p) => normalizeOne(p, company));
}

/**
 * Fetch all postings; full descriptions are fetched only for jobs where
 * `opts.wantDetail(job)` is true (max 40), since the list endpoint has none.
 * Note: SmartRecruiters answers 200 with zero postings for unknown companies.
 */
export async function fetchJobs(company, opts = {}) {
  const raw = [];
  for (let offset = 0; offset < MAX_POSTINGS; offset += PAGE) {
    const page = await getJSON(`${API}/${encodeURIComponent(company.slug)}/postings?limit=${PAGE}&offset=${offset}`, opts.http);
    raw.push(...(page.content ?? []));
    if (!page.content?.length || raw.length >= (page.totalFound ?? 0)) break;
  }
  const jobs = raw.map((p) => normalizeOne(p, company));
  const want = jobs.map((j, i) => [j, i]).filter(([j]) => opts.wantDetail?.(j)).slice(0, DETAIL_CAP);
  await mapLimit(want, 4, async ([j, i]) => {
    try { jobs[i] = { ...(await fetchOne(company.slug, j.sourceId, { ...opts, companyName: company.name })), key: j.key }; } catch { /* keep list data */ }
  });
  return jobs;
}

/** Fetch one posting with its description. */
export async function fetchOne(slug, id, opts = {}) {
  const p = await getJSON(`${API}/${encodeURIComponent(slug)}/postings/${encodeURIComponent(id)}`, opts.http);
  return normalizeOne(p, { name: opts.companyName ?? p.company?.name ?? slug, slug });
}
