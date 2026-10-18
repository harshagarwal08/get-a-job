import { createHash } from 'node:crypto';
import { slugify } from './paths.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

// Deterministic dedupe key; see docs/CONTRACTS.md.
export function jobKey({ company, title, location }) {
  const hash = createHash('sha1')
    .update(`${norm(company)}|${norm(title)}|${norm(location)}`)
    .digest('hex').slice(0, 6);
  return `${slugify(company, 40) || 'unknown'}--${slugify(title, 60) || 'untitled'}--${hash}`;
}
