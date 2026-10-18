import fs from 'node:fs';
import { extractPdf } from './pdf.js';
import { findNonAsciiDateDashes } from './dates.js';
import { keywordCoverage } from './keywords.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?){2,4}\d{2,5}/;
const MIN_TEXT = 200;

/**
 * Verify a resume PDF: page count, extractable text, ASCII date ranges, contact literals, keyword coverage.
 * @param {string} file PDF path
 * @param {{pages?: number, keywords?: string[]}} [opts]
 * @returns {Promise<{file:string, pages:number, maxPages:number|null, ok:boolean, checks:object[], keywords:object[], text:string}>}
 */
export async function verifyPdf(file, { pages: maxPages, keywords = [] } = {}) {
  const { pages, text } = await extractPdf(fs.readFileSync(file));
  const chars = text.replace(/\s/g, '').length;
  const dashes = findNonAsciiDateDashes(text);
  const email = text.match(EMAIL_RE)?.[0];
  const phone = [...text.matchAll(new RegExp(PHONE_RE, 'g'))].map((m) => m[0]).find((m) => m.replace(/\D/g, '').length >= 10);
  const checks = [
    { id: 'pages', ok: maxPages == null || pages <= maxPages, fatal: true,
      detail: maxPages == null ? `${pages} page(s)` : `${pages} page(s), limit ${maxPages}` },
    { id: 'text', ok: chars >= MIN_TEXT, fatal: true, detail: `${chars} non-space characters extracted` },
    { id: 'date-dashes', ok: dashes.length === 0, fatal: false,
      detail: dashes.length ? `non-ASCII dash in: ${dashes.map((d) => `"${d.match}"`).join(', ')}` : 'date ranges use ASCII "-"' },
    { id: 'email', ok: Boolean(email), fatal: false, detail: email ? email : 'no email found as text' },
    { id: 'phone', ok: Boolean(phone), fatal: false, detail: phone ? phone.trim() : 'no phone number found as text' },
  ];
  const kw = keywords.length ? keywordCoverage(text, keywords) : [];
  return { file, pages, maxPages: maxPages ?? null, ok: checks.every((c) => c.ok || !c.fatal), checks, keywords: kw, text };
}

/** Human-readable markdown-ish report for a verifyPdf() result. */
export function formatReport(r) {
  const lines = [`# verify ${r.file}`, '', '| check | result | detail |', '|---|---|---|'];
  for (const c of r.checks) lines.push(`| ${c.id} | ${c.ok ? 'ok' : c.fatal ? 'FAIL' : 'warn'} | ${c.detail} |`);
  if (r.keywords.length) {
    const n = (s) => r.keywords.filter((k) => k.status === s).length;
    lines.push('', `## keywords: ${n('covered')} covered, ${n('variant')} variant, ${n('missing')} missing`, '',
      '| keyword | status | found as |', '|---|---|---|');
    for (const k of r.keywords) lines.push(`| ${k.keyword} | ${k.status} | ${k.match ?? ''} |`);
  }
  lines.push('', r.ok ? 'RESULT: pass' : 'RESULT: FAIL');
  return lines.join('\n');
}
