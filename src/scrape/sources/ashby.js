import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob, makeSalary, salaryUnit } from '../job.js';

const API = 'https://api.ashbyhq.com/posting-api/job-board';

function salaryFrom(comp) {
  const parts = [...(comp?.summaryComponents ?? []), ...(comp?.compensationTiers ?? []).flatMap((t) => t.components ?? [])];
  const s = parts.find((c) => c.compensationType === 'Salary' && (c.minValue || c.maxValue));
  return s ? makeSalary(s.minValue, s.maxValue, s.currencyCode, salaryUnit(s.interval)) : null;
}

/**
 * Normalise one Ashby job.
 * @param {object} j
 * @param {{name: string}} company
 */
export function normalizeOne(j, company) {
  const secondary = (j.secondaryLocations ?? []).map((l) => l.location ?? l).filter((l) => typeof l === 'string');
  const addrCountry = j.address?.postalAddress?.addressCountry;
  return makeJob({
    title: j.title,
    company: company.name,
    location: j.location ?? '',
    locations: secondary,
    countryHints: addrCountry ? [addrCountry] : [],
    workModeField: j.workplaceType ?? (j.isRemote ? 'remote' : null),
    url: j.jobUrl,
    applyUrl: j.applyUrl ?? j.jobUrl,
    source: 'ashby',
    sourceId: j.id,
    department: j.department || j.team,
    salary: salaryFrom(j.compensation),
    postedAt: j.publishedAt,
    description: j.descriptionHtml ? htmlToText(j.descriptionHtml) : (j.descriptionPlain ?? ''),
  });
}

/** Normalise an Ashby job-board payload (`{jobs: [...]}`); unlisted jobs are skipped. */
export function normalize(payload, company) {
  return (payload?.jobs ?? []).filter((j) => j.isListed !== false).map((j) => normalizeOne(j, company));
}

async function board(slug, opts) {
  return getJSON(`${API}/${encodeURIComponent(slug)}?includeCompensation=true`, opts.http);
}

/** Fetch all listed jobs for a company. */
export async function fetchJobs(company, opts = {}) {
  return normalize(await board(company.slug, opts), company);
}

/** Fetch one job (Ashby has no single-job endpoint, so the board is filtered by id). */
export async function fetchOne(slug, id, opts = {}) {
  const j = (await board(slug, opts)).jobs?.find((x) => x.id === id);
  if (!j) throw new Error(`Ashby job ${id} not found on board "${slug}" (it may be closed)`);
  return normalizeOne(j, { name: opts.companyName ?? slug });
}
