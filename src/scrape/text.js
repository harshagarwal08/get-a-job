const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  sbquo: '‚', bdquo: '„', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™',
  laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×', divide: '÷',
  deg: '°', plusmn: '±', para: '¶', sect: '§', shy: '', zwj: '', zwnj: '', lrm: '', rlm: '',
};

/**
 * Decode HTML entities (named subset + decimal/hex numeric).
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const BLOCK_END = /<\/(p|div|h[1-6]|ul|ol|table|tr|section|article|header|footer|blockquote|pre|dl)\s*>/gi;
const BLOCK_START = /<(p|div|h[1-6]|ul|ol|table|section|article|header|footer|blockquote|pre|dl)(\s[^>]*)?>/gi;

/**
 * Convert an HTML fragment to readable plain text, keeping paragraph and list breaks.
 * Handles entity-encoded HTML (as returned by Greenhouse `content`).
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  if (!s.trim()) return '';
  if (/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z][^>]*>/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/(<li(\s[^>]*)?>)\s*(<(p|div|span)(\s[^>]*)?>\s*)+/gi, '$1')
    .replace(/(\s*<\/(p|div|span)\s*>)+\s*<\/li\s*>/gi, '</li>')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n')
    .replace(/<li(\s[^>]*)?>/gi, '\n- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<(dt|dd)(\s[^>]*)?>/gi, '\n')
    .replace(BLOCK_START, '\n\n')
    .replace(BLOCK_END, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/ /g, ' ').replace(/\r/g, '');
  const lines = s.split('\n').map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim());
  const outLines = [];
  for (const l of lines) {
    if (l === '-' ) continue; // empty list item
    if (!l && (!outLines.length || outLines[outLines.length - 1] === '')) continue;
    // keep consecutive list items tight
    if (l.startsWith('- ') && outLines.length >= 2 && outLines[outLines.length - 1] === '' && outLines[outLines.length - 2].startsWith('- ')) outLines.pop();
    outLines.push(l);
  }
  return outLines.join('\n').trim();
}

/** Extract `<title>` / og:title from an HTML document. */
export function htmlTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const t = og?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return t ? decodeEntities(t).replace(/\s+/g, ' ').trim() : null;
}

/**
 * Repair UTF-8 text that was decoded as Latin-1 ("donât" → "don’t"). Returns the input
 * unchanged when it doesn't look double-encoded or can't be repaired cleanly.
 * @param {string} s
 */
export function fixMojibake(s) {
  const str = String(s ?? '');
  if (!/[\u00c2-\u00f4][\u0080-\u00bf]/.test(str) || /[^\u0000-\u00ff]/.test(str)) return str;
  const fixed = Buffer.from(str, 'latin1').toString('utf8');
  return fixed.includes('\ufffd') ? str : fixed;
}
