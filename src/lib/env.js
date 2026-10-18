import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';

/** Provider keys read from the environment / .env. Never print, log, or persist these. */
export const KEYS = {
  serpapi: 'SERPAPI_API_KEY',
  jsearch: 'JSEARCH_RAPIDAPI_KEY',
  apify: 'APIFY_TOKEN',
};

let loaded = false;

/** Load ROOT/.env into process.env once (existing env vars win). Minimal KEY=VALUE parser. */
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  let text;
  try { text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    const q = v[0];
    if (q === '"' || q === "'") {
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s+#.*$/, '');
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** Value of a provider key ('serpapi' | 'jsearch' | 'apify'), or null. */
export function getKey(name) {
  loadEnv();
  const v = process.env[KEYS[name]];
  return v && v.trim() ? v.trim() : null;
}
