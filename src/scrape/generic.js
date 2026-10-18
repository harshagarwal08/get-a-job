import { BROWSER_HEADERS } from './http.js';
import { safeGet } from './safeFetch.js';
import { htmlToText, htmlTitle } from './text.js';
import { robotsAllows } from './robots.js';

function jsonLdPosting(html) {
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const items = [data, ...(Array.isArray(data) ? data : []), ...(data?.['@graph'] ?? [])].flat();
    const p = items.find((x) => x && (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))));
    if (p) return p;
  }
  return null;
}

function ldLocation(p) {
  const locs = [p.jobLocation].flat().filter(Boolean).map((l) => {
    const a = l.address ?? {};
    return typeof a === 'string' ? a : [a.addressLocality, a.addressRegion, a.addressCountry?.name ?? a.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean);
  if (p.jobLocationType === 'TELECOMMUTE') locs.unshift('Remote');
  return locs.join('; ') || null;
}

/**
 * Parse a generic job page: JSON-LD JobPosting if present, otherwise page text.
 * @param {string} html
 * @returns {{title: string|null, company: string|null, location: string|null, text: string}}
 */
export function parseGenericPage(html) {
  const p = jsonLdPosting(html);
  if (p?.description) {
    return {
      title: p.title ?? htmlTitle(html),
      company: p.hiringOrganization?.name ?? null,
      location: ldLocation(p),
      text: htmlToText(p.description),
    };
  }
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const main = /<main[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1] ?? /<article[^>]*>([\s\S]*?)<\/article>/i.exec(body)?.[1] ?? body;
  const stripped = main.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1\s*>/gi, '');
  return { title: htmlTitle(html), company: null, location: null, text: htmlToText(stripped) };
}

/**
 * Fetch a non-ATS page safely (public hosts only, robots.txt checked on every hop, 5 MB cap).
 * @param {string} url
 * @param {object} [opts] lookup/fetchImpl overrides for tests
 */
export async function fetchGeneric(url, opts = {}) {
  const res = await safeGet(url, { ...opts, headers: BROWSER_HEADERS, robots: (u) => robotsAllows(u, opts) });
  if (!/html|xml/i.test(res.contentType) && !/^\s*</.test(res.text)) return { title: null, company: null, location: null, text: res.text.trim(), finalUrl: res.url, truncated: res.truncated };
  return { ...parseGenericPage(res.text), finalUrl: res.url, truncated: res.truncated };
}
