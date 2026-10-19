import fs from 'node:fs';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON } from '../lib/store.js';
import { ATS_LIST } from './detect.js';
import { URL_ATS_LIST, validateAtsUrl } from './urlAts.js';

export const REGIONS = ['india', 'us', 'eu', 'uk', 'apac', 'remote-global'];
export const STAGES = ['seed', 'series-a', 'series-b', 'series-c', 'growth', 'public', 'unknown'];
export const COMPANY_SOURCES = ['seed', 'yc', 'discover', 'manual'];
/** ATS values allowed in companies.json: the probe-able ATSs plus the careers-page crawler. */
export const COMPANY_ATS = [...ATS_LIST, ...URL_ATS_LIST, 'careers'];

/**
 * Validate and normalise a company entry. Returns `{entry}` or `{error}`.
 * @param {object} c
 */
export function validateCompany(c) {
  const name = String(c.name ?? '').trim();
  if (!name) return { error: 'name is required' };
  if (!COMPANY_ATS.includes(c.ats)) return { error: `ats must be one of ${COMPANY_ATS.join(', ')}` };
  // URL-based ATSs: the url is authoritative and must match the ATS's host shape; slug defaults from it.
  let urlAts = null;
  if (URL_ATS_LIST.includes(c.ats)) {
    urlAts = validateAtsUrl(c.ats, c.url);
    if (urlAts.error) return { error: urlAts.error };
  }
  const slug = c.slug ?? urlAts?.slug;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug ?? '')) return { error: 'slug must be letters, digits, . _ - (the board name in the careers URL)' };
  const entry = { name, ats: c.ats, slug };
  if (urlAts) entry.url = urlAts.url;
  else if (c.ats === 'careers' || c.url) {
    let u = null;
    try { u = new URL(String(c.url ?? '')); } catch { u = null; }
    if (!u || u.protocol !== 'https:') return { error: 'careers entries need --url with the https careers listing page' };
    entry.url = u.href;
  }
  const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const tags = list(c.tags);
  if (tags.length) entry.tags = [...new Set(tags)];
  const region = list(c.region);
  const badRegion = region.find((r) => !REGIONS.includes(r));
  if (badRegion) return { error: `region "${badRegion}" must be one of ${REGIONS.join(', ')}` };
  if (region.length) entry.region = [...new Set(region)];
  if (c.stage !== undefined && c.stage !== null) {
    if (!STAGES.includes(c.stage)) return { error: `stage must be one of ${STAGES.join(', ')}` };
    entry.stage = c.stage;
  }
  if (c.source !== undefined && c.source !== null) {
    if (!COMPANY_SOURCES.includes(c.source)) return { error: `source must be one of ${COMPANY_SOURCES.join(', ')}` };
    entry.source = c.source;
  }
  return { entry };
}

/**
 * Load config/companies.json. With `{create: true}`, seed it from the example (or empty) if missing.
 * @returns {{cfg: object, created: boolean, fromExample: boolean}}
 */
export function loadCompaniesFile({ create = false } = {}) {
  const cfg = readJSON(paths.companies);
  if (cfg) return { cfg, created: false, fromExample: false };
  const example = readJSON(paths.companiesExample);
  const seeded = example ? { ...example, companies: [...(example.companies ?? [])] } : { version: 1, companies: [] };
  delete seeded._comment;
  if (create) {
    writeJSON(paths.companies, seeded);
    return { cfg: seeded, created: true, fromExample: !!example };
  }
  return { cfg: seeded, created: false, fromExample: !!example };
}

/** Save config/companies.json as 2-space JSON (atomic). */
export function saveCompaniesFile(cfg) {
  writeJSON(paths.companies, cfg);
}

/**
 * Add entries, deduping by ats+slug (case-insensitive). Pure: returns a new cfg.
 * A duplicate is left untouched unless `merge` is true, in which case new tags/region are
 * unioned in and missing stage/source filled. Each duplicate reports the stored entry and
 * which fields changed. Same company name on a different ATS/slug produces a warning.
 * @param {{companies: object[]}} cfg
 * @param {object[]} entries validated entries
 * @param {{merge?: boolean}} [opts]
 * @returns {{cfg: object, added: object[], duplicates: {input: object, stored: object, changed: string[]}[], warnings: string[]}}
 */
export function addCompanies(cfg, entries, { merge = false } = {}) {
  const companies = [...(cfg.companies ?? [])];
  // URL-based ATS entries are identified by their (normalised) url; others by slug.
  const key = (c) => `${c.ats}|${String(URL_ATS_LIST.includes(c.ats) && c.url ? c.url : c.slug).toLowerCase()}`;
  const idx = new Map(companies.map((c, i) => [key(c), i]));
  const added = [];
  const duplicates = [];
  const warnings = [];
  for (const e of entries) {
    const k = key(e);
    if (idx.has(k)) {
      const i = idx.get(k);
      const cur = companies[i];
      const next = { ...cur };
      const changed = [];
      if (merge) {
        for (const f of ['tags', 'region']) {
          if (!e[f]?.length) continue;
          const union = [...new Set([...(cur[f] ?? []), ...e[f]])];
          if (union.length !== (cur[f] ?? []).length) { next[f] = union; changed.push(f); }
        }
        for (const f of ['stage', 'source']) if (e[f] && !cur[f]) { next[f] = e[f]; changed.push(f); }
        companies[i] = next;
      }
      duplicates.push({ input: e, stored: next, changed });
      continue;
    }
    const sameName = companies.find((c) => c.name.toLowerCase() === e.name.toLowerCase());
    if (sameName) warnings.push(`"${e.name}" is already listed as ${sameName.ats}/${sameName.slug}; adding ${e.ats}/${e.slug} too.`);
    idx.set(k, companies.length);
    companies.push(e);
    added.push(e);
  }
  return { cfg: { ...cfg, version: cfg.version ?? 1, companies }, added, duplicates, warnings };
}

/** Filter companies by tag and/or region (comma-separated = any). */
export function filterCompanies(list, { tag, region } = {}) {
  const any = (v) => String(v ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const tags = any(tag);
  const regions = any(region);
  return list.filter((c) => (!tags.length || tags.some((t) => (c.tags ?? []).map((x) => x.toLowerCase()).includes(t)))
    && (!regions.length || regions.some((r) => (c.region ?? []).includes(r))));
}

export const companiesFileExists = () => fs.existsSync(paths.companies);
