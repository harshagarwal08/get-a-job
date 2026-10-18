// Record of successful `careers:check` runs (data/cache/careers-checks.json), so that
// company:check careers / companies:add --ats careers never crawl on their own.
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON } from '../lib/store.js';

export const CHECK_TTL = 7 * 86400 * 1000;
const file = () => path.join(paths.dataDir, 'cache', 'careers-checks.json');
const norm = (url) => { try { return new URL(url).href; } catch { return String(url ?? ''); } };

function load() {
  try { return readJSON(file(), {}) ?? {}; } catch { return {}; }
}

/** Store a successful check. */
export function recordCareersCheck(url, { jobs, method }, now = Date.now()) {
  const all = load();
  for (const [k, v] of Object.entries(all)) if (!(now - Date.parse(v.checkedAt) < CHECK_TTL)) delete all[k];
  all[norm(url)] = { checkedAt: new Date(now).toISOString(), jobs, method: method ?? null };
  writeJSON(file(), all);
}

/** A successful check of this URL within 7 days, or null. */
export function recentCareersCheck(url, now = Date.now()) {
  const r = load()[norm(url)];
  if (!r) return null;
  const age = now - Date.parse(r.checkedAt);
  return age >= 0 && age < CHECK_TTL && r.jobs > 0 ? r : null;
}
