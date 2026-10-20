import fs from 'node:fs';
import { extractPdf } from './pdf.js';
import { findNonAsciiDateDashes } from './dates.js';
import { keywordCoverage } from './keywords.js';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,5}\)?[\s.-]?){2,4}\d{2,5}/g;
const BULLET_RE = /^[•●▪◦‣∙·*–-]\s*/;
const NUMBER_WORD_RE = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|dozens?|hundreds?|thousands?|millions?|billions?)\b/i;

/** Standard section headings an ATS maps to fields (lowercase, letters/spaces only). */
export const SECTIONS = {
  experience: ['experience', 'work experience', 'professional experience', 'relevant experience', 'employment',
    'employment history', 'work history', 'career history', 'internships', 'internship', 'internship experience'],
  education: ['education', 'academic background', 'academics', 'education and training', 'qualifications'],
  skills: ['skills', 'technical skills', 'core skills', 'key skills', 'core competencies', 'competencies', 'skills and tools', 'tools'],
  summary: ['summary', 'professional summary', 'profile', 'career summary', 'objective', 'career objective', 'about'],
  projects: ['projects', 'personal projects', 'selected projects', 'key projects', 'academic projects'],
  certifications: ['certifications', 'certificates', 'licenses and certifications', 'courses'],
};

/** Phrases that describe duty or attendance instead of outcome. */
export const WEAK_PHRASES = ['responsible for', 'participating in', 'participated in', 'worked on', 'helped with',
  'helped to', 'assisted with', 'assisted in', 'involved in', 'duties included', 'tasked with', 'exposure to'];

// Letters only, so "WORK EXPERIENCE", "Work Experience:" and letter-spaced "W O R K  E X P E R I E N C E" all match.
const headingKey = (line) => line.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
const SPACED_RE = /^(?:[A-Z&] ){3,}[A-Z&]/;
const looksLikeHeading = (line) => /^[A-Z][A-Z &/-]{2,60}$/.test(line.trim()) && (SPACED_RE.test(line.trim()) || line.trim().split(/\s+/).length <= 5);
const urlKey = (u) => u.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
const DATE_RE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{4}\b|\b(?:19|20)\d{2}\s*-\s*(?:(?:19|20)\d{2}|present)\b/i;
const LABEL_RE = /^[A-Z][A-Za-z&/]*(?: [A-Za-z&/]+){0,3}:\s/; // "Tools: ...", "Tech stack: ..."
const NOT_ACHIEVEMENT = new Set(['summary', 'education', 'skills', 'certifications']);

/**
 * Bullet-like lines from work/project sections, with wrapped lines joined.
 * Templates often draw bullets as CSS markers, so glyphs are stripped, not required.
 * Entry heads (dates or "|"), "Label: values" lines and short lines are skipped.
 */
export function achievementLines(lines, heads) {
  const sectionOf = (i) => { let s; for (const [at, id] of heads) if (at <= i) s = id; else break; return s; };
  const inScope = heads.length ? (i) => !heads.some(([at]) => at === i) && !NOT_ACHIEVEMENT.has(sectionOf(i)) && i > heads[0][0] : () => true;
  const items = [];
  lines.forEach((raw, i) => {
    if (!inScope(i)) return;
    const line = raw.trim();
    const glyph = BULLET_RE.test(line);
    const body = line.replace(BULLET_RE, '');
    if (!glyph && /^[a-z(]/.test(body) && items.length && items.at(-1).open) items.at(-1).text += ` ${body}`;
    else items.push({ text: body, open: true, head: DATE_RE.test(body) || body.includes('|') || (!glyph && LABEL_RE.test(body)) });
  });
  return items.filter((it) => !it.head && it.text.split(/\s+/).length >= 6).map((it) => it.text);
}

const pts = (max, earned, detail, fix) => ({ max, earned: Math.max(0, Math.min(max, earned)), detail, ...(fix && earned < max ? { fix } : {}) });

/**
 * Score how well a resume survives an ATS parse, 0-100. Pure: works on extracted PDF text.
 * Without keywords the keyword category is skipped and the score is scaled to the rest.
 * @param {{lines: string[], pages: number, links?: string[], keywords?: string[]}} input
 */
export function scoreAts({ lines, pages, links = [], keywords = [] }) {
  const text = lines.join('\n');
  const flat = text.toLowerCase().replace(/\s+/g, '');
  const categories = {};

  // Parseability: can the ATS read it at all, and does it lose anything on the way.
  const chars = text.replace(/\s/g, '').length;
  const dashes = findNonAsciiDateDashes(text);
  const webLinks = links.filter((u) => /^https?:/i.test(u));
  const hidden = webLinks.filter((u) => !flat.includes(urlKey(u)));
  categories.parseability = {
    text: pts(10, chars >= 200 ? 10 : 0, `${chars} non-space characters extracted`,
      'text is not extractable (scanned image or outlined fonts); export a text PDF'),
    pages: pts(5, pages <= 2 ? 5 : 0, `${pages} page(s)`, 'cut to 1 page (2 only with 8+ years)'),
    dates: pts(5, dashes.length ? 2 : 5, dashes.length ? `non-ASCII dash in ${dashes.map((d) => `"${d.match}"`).join(', ')}` : 'date ranges use ASCII "-"',
      'use a plain "-" in date ranges; some parsers misread en/em dashes'),
    links: pts(5, hidden.length === 0 ? 5 : hidden.length < webLinks.length ? 2 : 0,
      webLinks.length ? `${webLinks.length - hidden.length}/${webLinks.length} link URLs visible as text` : 'no links',
      `ATS keeps only the visible text of a link; write the URL out: ${hidden.join(', ')}`),
  };

  // Contact: must be literal text.
  const email = text.match(EMAIL_RE)?.[0];
  const phone = [...text.matchAll(PHONE_RE)].map((m) => m[0]).find((m) => m.replace(/\D/g, '').length >= 10);
  const linkedinText = /linkedin\.com\/in\//i.test(text);
  const linkedinLink = links.some((u) => /linkedin\.com\/in\//i.test(u));
  categories.contact = {
    email: pts(5, email ? 5 : 0, email ?? 'no email as text', 'add the email as plain text'),
    phone: pts(5, phone ? 5 : 0, phone?.trim() ?? 'no phone as text', 'add a phone number with country code'),
    linkedin: pts(5, linkedinText ? 5 : linkedinLink ? 2 : 0,
      linkedinText ? 'LinkedIn URL in text' : linkedinLink ? 'LinkedIn only as a hidden link' : 'no LinkedIn URL',
      'write linkedin.com/in/<handle> as visible text'),
  };

  // Sections: standard headings let the ATS map content to fields.
  const found = {};
  const unknown = [];
  const spaced = [];
  const heads = []; // [lineIndex, section id | null]
  lines.forEach((line, i) => {
    const key = headingKey(line);
    const hit = Object.entries(SECTIONS).find(([, names]) => names.some((n) => n.replace(/ /g, '') === key));
    if (hit || (i > 0 && looksLikeHeading(line))) {
      if (SPACED_RE.test(line.trim())) spaced.push(line.trim());
      heads.push([i, hit?.[0] ?? null]);
    }
    if (hit) found[hit[0]] ??= line.trim();
    else if (i > 0 && looksLikeHeading(line)) unknown.push(line.trim());
  });
  categories.parseability.headings = pts(3, spaced.length ? 0 : 3,
    spaced.length ? `headings extract letter by letter: ${spaced.join(', ')}` : 'headings extract as words',
    'remove letter-spacing from headings; parsers read "E X P E R I E N C E" as single letters');
  const has = (s) => Boolean(found[s]);
  categories.sections = {
    experience: pts(8, has('experience') ? 8 : has('projects') ? 4 : 0,
      found.experience ?? (has('projects') ? 'no Experience heading (Projects only)' : 'no Experience heading'),
      `name the work section "Experience"${unknown.length ? ` (non-standard: ${unknown.join(', ')})` : ''}`),
    education: pts(5, has('education') ? 5 : 0, found.education ?? 'no Education heading', 'add an "Education" section'),
    skills: pts(5, has('skills') ? 5 : 0, found.skills ?? 'no Skills heading', 'add a "Skills" section'),
    summary: pts(2, has('summary') ? 2 : 0, found.summary ?? 'no Summary heading', 'add a 2-3 line "Summary"'),
  };

  // Content: what a recruiter skims after the ATS passes it on.
  const words = text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
  const items = achievementLines(lines, heads);
  const quantified = items.filter((b) => /\d/.test(b.replace(/\b(19|20)\d{2}\b/g, '')) || NUMBER_WORD_RE.test(b)).length;
  const ratio = items.length ? quantified / items.length : 0;
  const lower = text.toLowerCase();
  const weak = WEAK_PHRASES.filter((p) => lower.includes(p));
  categories.content = {
    length: pts(5, words >= 350 && words <= 900 ? 5 : words >= 250 && words <= 1100 ? 3 : 1, `${words} words`,
      words < 350 ? 'too thin: add outcomes, tools and scope to bullets' : 'too long: cut bullets by relevance'),
    bullets: pts(5, items.length >= 6 ? 5 : items.length >= 3 ? 3 : 0, `${items.length} achievement bullets`,
      'give each role and project 2-5 bullets of what you did'),
    metrics: pts(5, ratio >= 0.5 ? 5 : ratio >= 0.25 ? 3 : quantified ? 1 : 0, `${quantified}/${items.length} bullets have a number`,
      'add real numbers (users, %, time, money, scale) where they are true'),
    weakPhrases: pts(5, weak.length === 0 ? 5 : weak.length <= 2 ? 3 : 0, weak.length ? `found: ${weak.join(', ')}` : 'none',
      'start bullets with what you did and what changed, not duties'),
  };

  // Keywords: only meaningful against a specific posting.
  let kw = [];
  if (keywords.length) {
    kw = keywordCoverage(text, keywords);
    const covered = kw.filter((k) => k.status === 'covered').length;
    const variant = kw.filter((k) => k.status === 'variant').length;
    const missing = kw.filter((k) => k.status === 'missing').map((k) => k.keyword);
    categories.keywords = {
      match: pts(20, Math.round(((covered + variant * 0.5) / kw.length) * 20),
        `${covered} exact, ${variant} variant, ${missing.length} missing of ${kw.length}`,
        `use the posting's exact terms; missing: ${missing.join(', ')} (add only what is true)`),
    };
  }

  const all = Object.values(categories).flatMap((c) => Object.values(c));
  const max = all.reduce((s, c) => s + c.max, 0);
  const earned = all.reduce((s, c) => s + c.earned, 0);
  const score = Math.round((earned / max) * 100);
  const grade = score >= 85 ? 'strong' : score >= 70 ? 'good' : score >= 55 ? 'fair' : 'weak';
  const fixes = Object.entries(categories)
    .flatMap(([cat, checks]) => Object.entries(checks).filter(([, c]) => c.fix).map(([id, c]) => ({ check: `${cat}.${id}`, lost: c.max - c.earned, fix: c.fix })))
    .sort((a, b) => b.lost - a.lost);
  return { score, grade, keywordsScored: keywords.length > 0, categories, fixes, keywords: kw };
}

/** Read a PDF and score it. */
export async function atsPdf(file, { keywords = [] } = {}) {
  const { pages, lines, links } = await extractPdf(fs.readFileSync(file));
  return { file, ...scoreAts({ lines, pages, links, keywords }) };
}

/** Human-readable report for a scoreAts()/atsPdf() result. */
export function formatAts(r) {
  const out = [`# ATS score${r.file ? ` ${r.file}` : ''}: ${r.score}/100 (${r.grade})`, ''];
  if (!r.keywordsScored) out.push('Format-only score: no keywords given. Pass the posting\'s keywords for a job-specific score.', '');
  out.push('| check | points | detail |', '|---|---|---|');
  for (const [cat, checks] of Object.entries(r.categories)) {
    for (const [id, c] of Object.entries(checks)) out.push(`| ${cat}.${id} | ${c.earned}/${c.max} | ${c.detail} |`);
  }
  if (r.fixes.length) {
    out.push('', '## fixes (most points first)', '');
    for (const f of r.fixes) out.push(`- [+${f.lost}] ${f.check}: ${f.fix}`);
  }
  return out.join('\n');
}
