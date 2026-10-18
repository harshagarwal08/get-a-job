import { DATE_TOKEN } from './parse.js';

const DASH_RE = new RegExp(`(${DATE_TOKEN})\\s*([\\u2013\\u2014\\u2012\\u2212])\\s*(${DATE_TOKEN})`, 'gi');

/**
 * Find date ranges that use a non-ASCII dash (en/em/figure/minus) instead of "-".
 * @param {string} text
 * @returns {{match: string, dash: string, index: number}[]}
 */
export function findNonAsciiDateDashes(text) {
  return [...String(text ?? '').matchAll(DASH_RE)].map((m) => ({ match: m[0], dash: m[2], index: m.index }));
}
