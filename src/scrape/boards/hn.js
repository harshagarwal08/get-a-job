// Hacker News "Ask HN: Who is hiring?" via the public HN Algolia API.
import { getJSON } from '../http.js';
import { htmlToText, decodeEntities } from '../text.js';
import { makeJob, parseSalaryText } from '../job.js';
import { detectCountries, detectRegions } from '../geo.js';
import { cached } from '../cache.js';

const SEARCH = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';
const ITEM = 'https://hn.algolia.com/api/v1/items';
const TTL = 6 * 3600 * 1000;

const FLAG_RE = /\b(remote|onsite|on-site|on site|in[- ]office|hybrid|visa|sponsorship|interns?|internships?|full[- ]?time|part[- ]?time|contract(or)?|freelance)\b/i;
const ROLE_RE = /\b(engineers?|engineering|developers?|designers?|managers?|scientists?|leads?|architects?|swe|sre|devops|founding|analysts?|head of|cto|vp|staff|researchers?|programmers?|admins?|specialists?|consultants?|writers?|marketers?|recruiters?|fde|mts)\b/i;
const MULTI_RE = /\b(roles|positions|openings|multiple|various)\b/i;
const MAX_PART = 100;
const SALARY_RE = /([$€£₹]\s?\d|\b\d{2,3}\s?k\b|\bequity\b|\bsalary\b)/i;
const URL_RE = /^(https?:\/\/|www\.)|\.(com|io|ai|co|dev|org|net|app|xyz)(\/\S*)?$/i;
// Job-seeker template ("Location: … Remote: Yes … Willing to relocate") and key/value posts.
const KV_LINE_RE = /^(location|remote|willing to relocate|technologies|r[ée]sum[ée]|resume\/cv|cv|email|role|position|title|seeking|looking for)\s*:/i;
const MAX_COMPANY = 60;
const MAX_COMPANY_WORDS = 6;
const MAX_TITLE = 120;

/** Split a first line into fields. Pipes win; otherwise spaced dashes/bullets; or a leading "Name: rest". */
export function splitFirstLine(line) {
  const s = String(line ?? '').trim();
  const split = (re) => s.split(re).map((p) => p.trim()).filter(Boolean);
  if (s.includes('|')) return split(/\s*\|\s*/);
  const dashed = split(/\s+[—–-]\s+|\s+[•·]\s+/);
  if (dashed.length > 1) return dashed;
  const named = /^([^:]{2,60}):\s+(.+)$/.exec(s);
  return named ? [named[1].trim(), ...named[2].split(/\s*,\s*(?![^()]*\))/).map((p) => p.trim()).filter(Boolean)] : [s];
}

/**
 * Parse the first line of a "Who is hiring" comment:
 * `Company | Role(s) | Location | REMOTE | VISA | $salary | url`, in any order.
 * Returns null for lines that aren't a job post header (no separator, job-seeker or
 * key/value templates, or an implausibly long "company").
 * @param {string} line plain text
 * @returns {{company: string, roles: string[], location: string, flags: string[], salary: object|null, remote: boolean, onsite: boolean, hybrid: boolean, visa: boolean}|null}
 */
export function parseFirstLine(line) {
  if (KV_LINE_RE.test(String(line ?? '').trim())) return null;
  const parts = splitFirstLine(line);
  if (parts.length < 2) return null;
  let company = parts.shift().replace(/^company\s*:\s*/i, '');
  const locs = [];
  const roles = [];
  const flags = [];
  let salary = null;
  const paren = /\(([^)]*)\)/.exec(company);
  if (paren && (detectCountries(paren[1]).length || detectRegions(paren[1]).length || /remote|onsite|hybrid/i.test(paren[1]))) locs.push(paren[1]);
  company = company.replace(/\s*\([^)]*\)/g, '').replace(/\s+https?:\/\/\S+/, '').trim();
  if (!company || company.length > MAX_COMPANY || company.split(/\s+/).length > MAX_COMPANY_WORDS) return null;
  for (const p of parts) {
    if ((URL_RE.test(p) && !/\s/.test(p)) || p.length > MAX_PART) continue;
    const geo = detectCountries(p).length || detectRegions(p).length;
    const flag = FLAG_RE.test(p);
    if (SALARY_RE.test(p) && !ROLE_RE.test(p)) { salary = salary ?? parseSalaryText(p); continue; }
    if (flag && !ROLE_RE.test(p)) {
      flags.push(p);
      if (geo || /\(/.test(p)) locs.push(p);
      continue;
    }
    if ((ROLE_RE.test(p) || MULTI_RE.test(p)) && !(geo && p.split(/\s+/).length <= 3 && !/engineer|developer/i.test(p))) { roles.push(...splitRoles(p)); continue; }
    if (geo || /,/.test(p)) { locs.push(p); continue; }
    if (!roles.length && /^[A-Z]?[a-z]/.test(p) && p.split(/\s+/).length <= 6) roles.push(...splitRoles(p));
  }
  const all = [line, ...flags].join(' ');
  const noVisa = /\bno visa|visa(?: sponsorship)? not|without visa|unable to sponsor/i.test(all);
  return {
    company,
    roles,
    location: [...new Set(locs)].join('; '),
    flags,
    salary,
    remote: /\bremote\b/i.test(all) && !/\bno remote\b/i.test(all),
    onsite: /\b(onsite|on-site|on site|in[- ]office)\b/i.test(all),
    hybrid: /\bhybrid\b/i.test(all),
    visa: /\bvisa\b|\bsponsorship\b/i.test(all) && !noVisa,
  };
}

const ROLE_NOUN_RE = /\b(engineers?|developers?|designers?|managers?|scientists?|architects?|leads?|programmers?)\b/i;

function splitRoles(p) {
  return p.split(/\s*(?:,|;|\s\/\s)\s*/)
    // "Senior Front End Developer & Engineering Manager" → two roles when both sides name a role
    .flatMap((r) => { const [a, b] = r.split(/\s+(?:&|and)\s+/); return b && ROLE_NOUN_RE.test(a) && ROLE_NOUN_RE.test(b) ? [a, b] : [r]; })
    .map((r) => r.trim()).filter((r) => r.length > 1);
}

/**
 * Normalise an Algolia item tree for a "Who is hiring?" thread into jobs.
 * Each top-level comment = one posting.
 * @param {{id: number, children: object[]}} thread
 */
export function normalize(thread) {
  const jobs = [];
  for (const c of thread?.children ?? []) {
    if (!c?.text || c.deleted) continue;
    try {
      const html = c.text;
      const firstHtml = html.split(/<p>|\n/i)[0];
      const first = decodeEntities(firstHtml.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      const f = parseFirstLine(first);
      if (!f) continue;
      const body = htmlToText(html);
      const job = makeJob({
        title: (f.roles.join(', ') || 'Multiple roles').slice(0, MAX_TITLE),
        company: f.company,
        location: f.location || (f.remote ? 'Remote' : ''),
        workModeField: f.remote && !f.onsite && !f.hybrid ? 'remote' : f.hybrid ? 'hybrid' : f.onsite ? 'onsite' : null,
        url: `https://news.ycombinator.com/item?id=${c.id}`,
        applyUrl: `https://news.ycombinator.com/item?id=${c.id}`,
        source: 'hn',
        sourceId: c.id,
        salary: f.salary,
        postedAt: c.created_at,
        description: body,
      });
      jobs.push({ ...job, roles: f.roles, firstLine: first, matchText: body, visa: f.visa, hnThread: String(thread.id) });
    } catch { /* one odd comment never breaks the rest */ }
  }
  return jobs;
}

/** Find the latest "Ask HN: Who is hiring?" story in an Algolia search payload. */
export function latestThread(search) {
  return (search?.hits ?? []).filter((h) => /who is hiring\?/i.test(h.title ?? ''))
    .sort((a, b) => (b.created_at_i ?? 0) - (a.created_at_i ?? 0))[0] ?? null;
}

/** Fetch (cached 6h) and normalise the latest thread. Returns jobs plus the thread id. */
export async function fetchJobs(opts = {}) {
  const { data } = await cached('hn', TTL, async () => {
    const story = latestThread(await getJSON(SEARCH, { retries: 1, ...opts.http }));
    if (!story) throw new Error('no "Who is hiring?" thread found');
    return getJSON(`${ITEM}/${story.objectID}`, { retries: 1, ...opts.http });
  });
  return { jobs: normalize(data), threadId: String(data.id), title: data.title };
}
