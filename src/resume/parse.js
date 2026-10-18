import { Lexer } from 'marked';
import { inlineHtml, inlineText, lexInline, mdInline, blockHtml, listItemHtml } from './markdown.js';
import { stripComments, safeHref } from './escape.js';

const TRACKS_RE = /<!--\s*tracks?\s*:\s*([\s\S]*?)\s*-->/gi;
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
/** Matches a date-ish token: "Jul 2023", "2023", "07/2023", "Present". */
export const DATE_TOKEN = `(?:${MONTH}\\s+\\d{4}|\\d{1,2}/\\d{4}|\\d{4}|present|current|now|today)`;
const DATEISH_RE = new RegExp(`(^|\\s)${DATE_TOKEN}(\\s|$)`, 'i');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s().-]{7,}$/;

const splitPipe = (s) => s.split(/\s+\|\s+/).map((x) => x.trim()).filter(Boolean);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

/** Extract track ids from `<!-- tracks: a,b -->` comments in a string. */
export function extractTracks(s) {
  const tracks = [];
  for (const m of String(s ?? '').matchAll(TRACKS_RE)) {
    for (const t of m[1].split(/[,\s]+/)) if (t) tracks.push(t.trim().toLowerCase());
  }
  return [...new Set(tracks)];
}

function bulletsFrom(list) {
  return list.items.map((item) => {
    const own = item.tokens.filter((t) => t.type === 'text').map((t) => t.raw).join(' ');
    return { html: listItemHtml(item.tokens).trim(), tracks: extractTracks(own) };
  });
}

function contactFrom(paragraph) {
  return stripComments(paragraph.text).split(/\s+[·•|]\s+|\n/).map((s) => s.trim()).filter(Boolean).map((part) => {
    const tokens = lexInline(part);
    const link = tokens.length === 1 && tokens[0].type === 'link' ? tokens[0] : null;
    const text = inlineText(tokens).trim();
    let href = link ? safeHref(link.href) : null;
    if (!href && EMAIL_RE.test(text)) href = `mailto:${text}`;
    else if (!href && PHONE_RE.test(text) && /\d{7}/.test(text.replace(/\D/g, ''))) href = `tel:${text.replace(/[^\d+]/g, '')}`;
    return href ? { text, href } : { text };
  });
}

/** True when a line reads like an entry meta line (`Dates | Location`). */
export function isMetaLine(line) {
  const s = line.trim();
  return s.length > 0 && s.length <= 120 && !/^[-*+]\s/.test(s) && (/\s\|\s/.test(s) || DATEISH_RE.test(s));
}

function metaFrom(line) {
  const parts = splitPipe(inlineText(lexInline(line)));
  if (parts.length === 1) return DATEISH_RE.test(parts[0]) ? { dates: parts[0] } : { location: parts[0] };
  const [a, b, ...rest] = parts;
  const swap = !DATEISH_RE.test(a) && DATEISH_RE.test(b);
  const meta = swap ? { dates: b, location: a } : { dates: a, location: b };
  if (rest.length) meta.location = [meta.location, ...rest].join(', ');
  return meta;
}

function entryFrom(heading) {
  const [title = '', org, extra] = splitPipe(stripComments(heading.text));
  const entry = { title: mdInline(title), org: org ? mdInline(org) : '', meta: {}, bullets: [] };
  if (extra) entry.meta.location = inlineText(lexInline(extra));
  return entry;
}

/** Add a block token to a container (section or entry). */
function addBlock(target, token, { allowMeta }) {
  if (token.type === 'space' || (token.type === 'html' && /^\s*<!--/.test(token.raw))) return;
  if (token.type === 'list') { target.bullets.push(...bulletsFrom(token)); return; }
  if (token.type === 'paragraph') {
    const lines = token.text.split('\n');
    if (allowMeta && isMetaLine(lines[0])) {
      const meta = metaFrom(lines[0]);
      target.meta = { ...meta, ...(target.meta.location && !meta.location ? { location: target.meta.location } : {}) };
      if (lines.length > 1) (target.body ??= []).push(mdInline(lines.slice(1).join('\n')));
      return;
    }
    const key = 'entries' in target ? 'paragraphs' : 'body';
    (target[key] ??= []).push(inlineHtml(token.tokens));
    return;
  }
  target.extra = (target.extra ?? '') + blockHtml([token]);
}

/**
 * Parse resume.md (format in docs/CONTRACTS.md) into a render model.
 * Text fields named `html` / `title` / `org` / `paragraphs` / `body` hold escaped, safe inline HTML;
 * `contact[].text` and `meta.*` are plain text.
 * @param {string} md
 * @returns {{name:string, contact:{text:string, href?:string}[], headline:string[],
 *   sections:{title:string, id:string, paragraphs:string[], bullets:{html:string,tracks:string[]}[],
 *   entries:{title:string, org:string, meta:{dates?:string,location?:string}, bullets:object[], body?:string[], extra?:string}[], extra?:string}[]}}
 */
export function parseResume(md) {
  const tokens = Lexer.lex(String(md ?? '').replace(/\r\n?/g, '\n'));
  const model = { name: '', contact: [], headline: [], sections: [] };
  let section = null;
  let entry = null;
  let sawContact = false;
  const ensureSection = () => section ?? (section = pushSection(''));
  const pushSection = (title) => {
    const s = { title, id: slug(title), paragraphs: [], bullets: [], entries: [] };
    model.sections.push(s);
    return s;
  };

  for (const t of tokens) {
    if (t.type === 'heading' && t.depth === 1 && !model.name) { model.name = inlineText(t.tokens).trim(); continue; }
    if (t.type === 'heading' && t.depth <= 2) {
      section = pushSection(inlineText(t.tokens).trim()); entry = null; continue;
    }
    if (t.type === 'heading' && t.depth === 3) {
      entry = entryFrom(t); ensureSection().entries.push(entry); entry._fresh = true; continue;
    }
    if (!section) {
      if (t.type === 'paragraph' && !sawContact) { model.contact = contactFrom(t); sawContact = true; continue; }
      if (t.type === 'paragraph') { model.headline.push(inlineHtml(t.tokens)); continue; }
      if (t.type === 'space' || t.type === 'html') continue;
    }
    if (entry) {
      addBlock(entry, t, { allowMeta: entry._fresh && t.type === 'paragraph' });
      if (t.type !== 'space') entry._fresh = false;
    } else addBlock(ensureSection(), t, { allowMeta: false });
  }
  for (const s of model.sections) for (const e of s.entries) delete e._fresh;
  return model;
}
