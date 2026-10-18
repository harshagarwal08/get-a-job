// LinkedIn guest job search (opt-in via preferences.sources.linkedin).
//
// Uses LinkedIn's unauthenticated "jobs-guest" endpoints that back the public job
// search pages. This is meant for light personal use only: LinkedIn's User Agreement
// restricts automated access, results can change or be blocked at any time, and you
// are responsible for how you use it. We send an honest User-Agent, fetch a few pages
// at most, run sequentially with pauses, and never log in or touch member data.

import { getText } from '../http.js';
import { htmlToText, decodeEntities } from '../text.js';
import { makeJob } from '../job.js';

const SEARCH = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const POSTING = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const MAX_PAGES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) => decodeEntities(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const grab = (html, re) => { const m = re.exec(html); return m ? clean(m[1]) : ''; };

/**
 * Parse one search-result card. Returns null if the card is malformed.
 * @param {string} card HTML of one <li> card
 */
export function parseCard(card) {
  const id = /urn:li:jobPosting:(\d+)/.exec(card)?.[1] ?? /\/jobs\/view\/[^"?]*?-?(\d{6,})/.exec(card)?.[1];
  const title = grab(card, /<h3[^>]*base-search-card__title[^>]*>([\s\S]*?)<\/h3>/);
  const company = grab(card, /<h4[^>]*base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/);
  if (!id || !title || !company) return null;
  return {
    id,
    title,
    company,
    location: grab(card, /<span[^>]*job-search-card__location[^>]*>([\s\S]*?)<\/span>/),
    postedAt: /<time[^>]*datetime="([^"]+)"/.exec(card)?.[1] ?? null,
    salary: grab(card, /<span[^>]*job-search-card__salary-info[^>]*>([\s\S]*?)<\/span>/) || null,
  };
}

/**
 * Normalise a guest search results HTML page into jobs (no descriptions yet).
 * Each card is parsed independently so one bad card can't break the page.
 * @param {string} html
 * @returns {object[]}
 */
export function normalize(html) {
  const cards = String(html ?? '').split(/<li[\s>]/).slice(1);
  const jobs = [];
  for (const card of cards) {
    let c;
    try { c = parseCard(card); } catch { c = null; }
    if (!c) continue;
    const url = `https://www.linkedin.com/jobs/view/${c.id}/`;
    jobs.push(makeJob({
      title: c.title, company: c.company, location: c.location, url, applyUrl: url,
      source: 'linkedin', sourceId: c.id, postedAt: c.postedAt, description: '',
    }));
  }
  return jobs;
}

/**
 * Parse a guest job-posting page into {title, company, location, description, criteria}.
 * @param {string} html
 */
export function parsePosting(html) {
  const s = String(html ?? '');
  const markup = /<div[^>]*show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*(<button|<\/section|<\/div>)/.exec(s)?.[1] ?? '';
  const criteria = [...s.matchAll(/<span[^>]*description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)].map((m) => clean(m[1]));
  return {
    title: grab(s, /<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/) || grab(s, /<h1[^>]*>([\s\S]*?)<\/h1>/),
    company: grab(s, /<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/),
    location: grab(s, /<span[^>]*topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/),
    description: htmlToText(markup),
    criteria,
  };
}

/**
 * Search LinkedIn guest jobs.
 * @param {{keywords: string, location: string}} query
 * @param {{days?: number, limit?: number, pause?: number, http?: object}} [opts]
 */
export async function fetchJobs(query, opts = {}) {
  const { days = 14, limit = 50, pause = 1500 } = opts;
  const out = [];
  for (let start = 0, pages = 0; start < limit && pages < MAX_PAGES; pages++) {
    const qs = new URLSearchParams({ keywords: query.keywords, location: query.location ?? '', f_TPR: `r${Math.round(days * 86400)}`, start: String(start) });
    const html = await getText(`${SEARCH}?${qs}`, opts.http);
    const page = normalize(html);
    out.push(...page);
    if (!page.length) break;
    start += page.length;
    await sleep(pause);
  }
  return out.slice(0, limit);
}

/** Fetch the full posting for a LinkedIn job id. */
export async function fetchOne(id, opts = {}) {
  const p = parsePosting(await getText(`${POSTING}/${encodeURIComponent(id)}`, opts.http));
  const url = `https://www.linkedin.com/jobs/view/${id}/`;
  return makeJob({ ...p, url, applyUrl: url, source: 'linkedin', sourceId: id, description: p.description });
}
