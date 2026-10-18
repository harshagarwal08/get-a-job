import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON } from '../lib/store.js';

export const cacheDir = () => path.join(paths.dataDir, 'cache');
const NEGATIVE_TTL = 3600 * 1000;

const warn = (m) => process.stderr.write(`warning: ${m}\n`);
const age = (now, iso) => now - Date.parse(iso);
const fresh = (now, iso, ttl) => { const a = age(now, iso); return a >= 0 && a < ttl; };

function readEntry(file) {
  try {
    const e = readJSON(file, null);
    return e && typeof e.fetchedAt === 'string' && !Number.isNaN(Date.parse(e.fetchedAt)) && 'data' in e ? e : null;
  } catch { return null; }
}

/**
 * Cached JSON fetch. Data lives in data/cache/<name>-<YYYY-MM-DD>.json.
 * - Fresh (0 <= age < ttl) data is reused; files are scanned newest first, first valid wins.
 * - A failed fetch is remembered for 1h in <name>-failed.json so a broken source isn't hammered.
 * - On failure, stale data (if any) is returned with a warning instead of throwing.
 * @template T
 * @param {string} name e.g. "remotive"
 * @param {number} ttlMs
 * @param {() => Promise<T>} fetcher
 * @param {{now?: number, negativeTtl?: number, cacheFailure?: (err: Error) => boolean}} [opts]
 *   `cacheFailure(err) === false` rethrows that error as-is (no negative cache, no stale fallback).
 * @returns {Promise<{data: T, cached: boolean, stale?: boolean}>}
 */
export async function cached(name, ttlMs, fetcher, { now = Date.now(), negativeTtl = NEGATIVE_TTL, cacheFailure = () => true } = {}) {
  const dir = cacheDir();
  const failedFile = path.join(dir, `${name}-failed.json`);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => new RegExp(`^${name.replace(/[^a-z0-9-]/gi, '')}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort().reverse()
    : [];
  let latest = null;
  for (const f of files) { latest = readEntry(path.join(dir, f)); if (latest) break; }
  if (latest && fresh(now, latest.fetchedAt, ttlMs)) return { data: latest.data, cached: true };

  const staleOr = (reason) => {
    if (latest) {
      warn(`${name}: ${reason}; using cached data from ${latest.fetchedAt}`);
      return { data: latest.data, cached: true, stale: true };
    }
    throw new Error(`${name}: ${reason}`);
  };

  let failed = null;
  try { failed = readJSON(failedFile, null); } catch { failed = null; }
  if (failed?.at && fresh(now, failed.at, negativeTtl)) return staleOr(`last fetch failed at ${failed.at} (${failed.error}); retrying after 1h`);

  let data;
  try {
    data = await fetcher();
  } catch (err) {
    if (cacheFailure(err) === false) throw err;
    try { writeJSON(failedFile, { at: new Date(now).toISOString(), error: err.message }); } catch { /* best effort */ }
    return staleOr(`fetch failed (${err.message})`);
  }
  const fetchedAt = new Date(now).toISOString();
  const file = path.join(dir, `${name}-${fetchedAt.slice(0, 10)}.json`);
  writeJSON(file, { fetchedAt, data });
  for (const f of files) if (path.join(dir, f) !== file) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(failedFile, { force: true });
  return { data, cached: false };
}
