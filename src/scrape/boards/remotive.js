// Remotive public API. Terms: link back to the Remotive URL and mention Remotive as the
// source; request at most ~4 times a day (we cache for 6h and make one request).
import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { remoteLocation, makeJob, parseSalaryText } from '../job.js';
import { cached } from '../cache.js';

// category=software-dev is the documented filter. As of 2026-10 the free API ignores it and
// returns the same ~13 delayed jobs across all categories, so we still filter locally by track.
const API = 'https://remotive.com/api/remote-jobs?category=software-dev';
const TTL = 6 * 3600 * 1000;

/** Normalise a Remotive payload (`{jobs: [...]}`). All jobs are remote. */
export function normalize(payload) {
  return (payload?.jobs ?? []).map((j) => makeJob({
    title: j.title,
    company: j.company_name,
    location: remoteLocation(j.candidate_required_location),
    workModeField: 'remote',
    url: j.url,
    applyUrl: j.url,
    source: 'remotive',
    sourceId: j.id,
    department: j.category,
    salary: parseSalaryText(j.salary),
    postedAt: j.publication_date ? `${j.publication_date}Z`.replace(/Z+$/, 'Z') : null,
    description: `${htmlToText(j.description)}\n\nSource: Remotive (${j.url})`,
  }));
}

/** Fetch the software-dev feed in one request (cached 6h); tracks are matched locally. */
export async function fetchJobs(opts = {}) {
  const { data } = await cached('remotive', TTL, () => getJSON(API, { retries: 1, ...opts.http }));
  return { jobs: normalize(data) };
}
