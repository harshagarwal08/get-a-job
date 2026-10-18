// Remote OK public API. Terms: link back to the job's Remote OK URL and mention Remote OK
// as the source; don't use their logo. Requires a User-Agent (we send our honest one).
import { getJSON } from '../http.js';
import { htmlToText, fixMojibake } from '../text.js';
import { remoteLocation, makeJob, makeSalary } from '../job.js';
import { cached } from '../cache.js';

const API = 'https://remoteok.com/api';
const TTL = 6 * 3600 * 1000;

/** Normalise the Remote OK array (first element is the legal notice). */
export function normalize(payload) {
  return (Array.isArray(payload) ? payload : []).filter((j) => j && j.id && j.position).map((j) => makeJob({
    title: fixMojibake(j.position),
    company: fixMojibake(j.company),
    location: remoteLocation(fixMojibake(j.location)),
    workModeField: 'remote',
    url: j.url,
    applyUrl: j.apply_url ?? j.url,
    source: 'remoteok',
    sourceId: j.id,
    salary: makeSalary(j.salary_min, j.salary_max, 'USD', 'year'),
    postedAt: j.date ?? j.epoch,
    description: `${htmlToText(fixMojibake(j.description))}\n\nSource: Remote OK (${j.url})`,
  }));
}

/** Fetch the feed once (cached 6h). */
export async function fetchJobs(opts = {}) {
  const { data } = await cached('remoteok', TTL, () => getJSON(API, { retries: 1, ...opts.http }));
  return { jobs: normalize(data) };
}
