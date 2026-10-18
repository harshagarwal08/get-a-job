// Hard ceilings for providers (docs/CONTRACTS.md "Safety rules"), applied regardless of config.
import { cfgOf } from './common.js';

const RULES = {
  googleJobs: {
    maxQueries: { min: 1, max: 20, def: 6, int: true },
    maxRequestsPerMonth: { min: 1, max: 10000, def: 100, int: true },
  },
  apify: {
    maxItems: { min: 1, max: 500, def: 100, int: true },
    maxChargeUsd: { min: 0.01, max: 5, def: 0.5 },
    maxUsdPerMonth: { min: 0.01, max: 1000, def: 5 },
  },
  jobspy: {
    resultsWanted: { min: 1, max: 100, def: 40, int: true },
    maxQueries: { min: 1, max: 5, def: 3, int: true },
    hoursOld: { min: 1, max: 720, def: 168, int: true },
  },
};
export const MAX_APIFY_ACTORS = 3;

/**
 * Clamp a provider's numeric settings to the hard ceilings. Missing values take defaults
 * silently; non-numeric, zero, negative or out-of-range values are clamped with a warning.
 * @param {'googleJobs'|'apify'|'jobspy'} name
 * @param {unknown} raw preferences.sources[name]
 * @returns {{cfg: object, warnings: string[]}}
 */
export function clampProviderConfig(name, raw) {
  const cfg = { ...cfgOf(raw) };
  const warnings = [];
  for (const [field, r] of Object.entries(RULES[name] ?? {})) {
    const v = cfg[field];
    if (v === undefined || v === null) { cfg[field] = r.def; continue; }
    let n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`${name}.${field}=${JSON.stringify(v)} is invalid; using ${r.def}`);
      cfg[field] = r.def;
      continue;
    }
    if (r.int) n = Math.floor(n);
    const c = Math.min(r.max, Math.max(r.min, n));
    if (c !== v) warnings.push(`${name}.${field}=${JSON.stringify(v)} clamped to ${c} (allowed ${r.min}-${r.max})`);
    cfg[field] = c;
  }
  return { cfg, warnings };
}
