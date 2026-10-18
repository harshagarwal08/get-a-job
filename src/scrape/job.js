import { jobKey } from '../lib/jobKey.js';
import { detectCountries, detectWorkMode, countryCode } from './geo.js';

const toISO = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const num = typeof v === 'number' || /^\d+$/.test(String(v)) ? Number(v) : null;
  const d = new Date(num === null ? v : num < 1e11 ? num * 1000 : num); // epoch seconds or ms
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Return the URL if it is a valid http(s) URL, else null. */
export function httpUrl(u) {
  if (!u) return null;
  try {
    const p = new URL(String(u));
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch { return null; }
}

/**
 * Build a NormalizedJob (the scrape-time subset of a data/jobs.json record).
 * @param {object} f raw fields
 * @param {string} f.title
 * @param {string} f.company
 * @param {string} [f.location]
 * @param {string[]} [f.locations] extra location strings (secondary offices)
 * @param {string[]} [f.countryHints] country names/codes supplied by the ATS
 * @param {string} [f.workModeField] structured work mode from the ATS
 * @param {string} f.source
 * @returns {object}
 */
export function makeJob(f) {
  const title = String(f.title ?? '').replace(/\s+/g, ' ').trim();
  const allLocs = [f.location, ...(f.locations ?? [])].map((s) => String(s ?? '').trim()).filter(Boolean);
  const uniqLocs = [...new Set(allLocs)];
  let location = uniqLocs[0] ?? '';
  if (uniqLocs.length > 1 && !uniqLocs.slice(1).every((l) => location.includes(l))) {
    location = `${location} (+${uniqLocs.length - 1} location${uniqLocs.length > 2 ? 's' : ''})`;
  }
  const countries = new Set();
  for (const h of f.countryHints ?? []) { const cc = countryCode(h); if (cc) countries.add(cc); }
  for (const l of uniqLocs) for (const cc of detectCountries(l)) countries.add(cc);
  const job = {
    key: jobKey({ company: f.company, title, location }),
    title,
    company: f.company,
    location,
    countries: [...countries],
    workMode: detectWorkMode(f.workModeField, ...uniqLocs, title),
    url: httpUrl(f.url),
    applyUrl: httpUrl(f.applyUrl),
    source: f.source,
    sourceId: f.sourceId != null ? String(f.sourceId) : null,
    department: f.department || null,
    salary: f.salary ?? null,
    postedAt: toISO(f.postedAt),
    description: f.description ?? '',
  };
  if (uniqLocs.length > 1) job.locations = uniqLocs;
  return job;
}

const UNIT = { year: 'year', yearly: 'year', annual: 'year', month: 'month', monthly: 'month', week: 'week', day: 'day', daily: 'day', hour: 'hour', hourly: 'hour' };

/** Normalise a salary interval string ("1 YEAR", "per-year-salary", "hourly") to a unit. */
export function salaryUnit(s) {
  const m = /(year|yearly|annual|month|monthly|week|day|daily|hour|hourly)/i.exec(String(s ?? ''));
  return m ? UNIT[m[1].toLowerCase()] : 'year';
}

/** Build a salary object, or null if neither bound is a positive number. */
export function makeSalary(min, max, currency, unit) {
  const lo = Number(min) > 0 ? Number(min) : null;
  const hi = Number(max) > 0 ? Number(max) : null;
  if (lo === null && hi === null) return null;
  return { min: lo ?? hi, max: hi ?? lo, currency: currency ? String(currency).toUpperCase() : null, unit: unit ?? 'year' };
}

const MULT = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, l: 1e5, L: 1e5, lakh: 1e5, lpa: 1e5, LPA: 1e5 };
const CUR = { $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };

/**
 * Parse free-text salary like "$170k - $200k", "€75k–80k", "120,000-150,000 USD", "₹30L - ₹45L".
 * Returns null when no plausible range is found.
 * @param {string} text
 */
export function parseSalaryText(text) {
  const s = String(text ?? '');
  const re = /([$€£₹])?\s?(\d{1,3}(?:,\d{2})+,\d{3}|\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s?(k|K|m|M|lpa|LPA|lakh|L)?\b/g;
  const nums = [];
  let cur = null;
  for (const m of s.matchAll(re)) {
    if (!m[1] && !m[3] && !/\d{1,3}[,.]\d{2,3}/.test(m[2])) continue;
    // "12,00,000" (Indian grouping) and "120,000" drop commas; "3.624" (European) drops the dot
    const digits = m[2].includes(',') ? m[2].replace(/,/g, '') : m[2].replace(/\.(?=\d{3}\b)/g, '');
    const n = parseFloat(digits) * (MULT[m[3]] ?? 1);
    if (m[1]) cur = CUR[m[1]];
    nums.push(n);
    if (nums.length === 2) break;
  }
  if (!nums.length) return null;
  const code = /\b(USD|EUR|GBP|INR|CAD|AUD|SGD)\b/.exec(s)?.[1] ?? cur;
  // "€75k–80k": second number inherits the first's multiplier
  if (nums.length === 2 && nums[1] < 1000 && nums[0] >= 1000) nums[1] *= 1000;
  if (Math.max(...nums) < 1000) return null;
  const unit = /\b(hour|hr|hourly)\b/i.test(s) ? 'hour' : /\b(month|mo|monthly)\b/i.test(s) ? 'month' : 'year';
  return makeSalary(Math.min(...nums), Math.max(...nums), code, unit);
}

/** "Remote (<where>)" for remote-only boards; plain "Remote" when where is empty or just "remote". */
export function remoteLocation(where) {
  const w = String(where ?? '').trim();
  return !w || /^(remote|anywhere)$/i.test(w) ? 'Remote' : `Remote (${w})`;
}
