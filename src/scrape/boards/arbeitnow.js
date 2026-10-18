// Arbeitnow public job board API (Europe-focused). Terms: free public API, "please do not
// abuse", link back appreciated (we keep each job's arbeitnow.com URL). Rate limit 50/min.
import { getJSON } from '../http.js';
import { htmlToText } from '../text.js';
import { makeJob } from '../job.js';
import { cached } from '../cache.js';

const API = 'https://www.arbeitnow.com/api/job-board-api';
const TTL = 6 * 3600 * 1000;
const PAGES = 3; // 300 jobs/page, newest first

/** Normalise an Arbeitnow page payload (`{data: [...]}`) or an array of jobs. */
export function normalize(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.data ?? []);
  return list.map((j) => {
    const job = makeJob({
      title: j.title,
      company: j.company_name,
      location: j.location ?? '',
      workModeField: j.remote ? 'remote' : null,
      url: j.url,
      applyUrl: j.url,
      source: 'arbeitnow',
      sourceId: j.slug,
      department: null,
      postedAt: j.created_at,
      description: htmlToText(j.description),
    });
    return { ...job, visa: j.visa_sponsorship === true || (j.tags ?? []).some((t) => /visa/i.test(t)) };
  });
}

/** Fetch the newest pages (cached 6h). */
export async function fetchJobs(opts = {}) {
  const { data } = await cached('arbeitnow', TTL, async () => {
    const all = [];
    for (let page = 1; page <= PAGES; page++) {
      const d = await getJSON(`${API}?page=${page}`, { retries: 1, ...opts.http });
      all.push(...(d.data ?? []));
      if (!d.links?.next) break;
    }
    return all;
  });
  return { jobs: normalize(data) };
}
