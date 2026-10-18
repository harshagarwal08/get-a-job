import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../escape.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(DIR, f), 'utf8');

/** Available template names. */
export const TEMPLATES = ['classic', 'modern'];
/** Paper sizes accepted by `--paper`. */
export const PAPERS = { letter: 'Letter', a4: 'A4' };

const isKeyValue = (bullets) => bullets.length > 0 && bullets.every((b) => b.html.startsWith('<strong>'));

function contactHtml(contact) {
  return contact.map((c) => {
    const text = escapeHtml(c.text);
    return c.href ? `<a href="${escapeHtml(c.href)}">${text}</a>` : `<span>${text}</span>`;
  }).join('<span class="sep"> · </span>');
}

const bulletsHtml = (bullets, cls = '') => bullets.length
  ? `<ul${cls ? ` class="${cls}"` : ''}>${bullets.map((b) => `<li>${b.html}</li>`).join('')}</ul>` : '';

function entryHtml(e) {
  const { dates, location } = e.meta ?? {};
  const org = e.org ? `<span class="org-sep">, </span><span class="org">${e.org}</span>` : '';
  const loc = location ? `<span class="loc"><span class="loc-sep"> · </span>${escapeHtml(location)}</span>` : '';
  const date = dates ? `<span class="dates">${escapeHtml(dates)}</span>` : '';
  const body = (e.body ?? []).map((p) => `<p>${p}</p>`).join('');
  return `<div class="entry"><div class="entry-head"><div class="entry-lead"><h3><span class="role">${e.title}</span>${org}</h3>${loc}</div>${date}</div>${body}${bulletsHtml(e.bullets)}${e.extra ?? ''}</div>`;
}

function sectionHtml(s) {
  const head = s.title ? `<h2>${escapeHtml(s.title)}</h2>` : '';
  const paras = s.paragraphs.map((p) => `<p>${p}</p>`).join('');
  const bullets = bulletsHtml(s.bullets, isKeyValue(s.bullets) ? 'kv' : '');
  return `<section class="sec sec-${s.id}">${head}${paras}${bullets}${s.entries.map(entryHtml).join('')}${s.extra ?? ''}</section>`;
}

/**
 * Build a complete, self-contained HTML document for a resume model.
 * @param {object} model parsed (and track-filtered) resume model
 * @param {{template?: string, paper?: 'letter'|'a4'}} [opts]
 * @returns {string}
 */
export function buildHtml(model, { template = 'classic', paper = 'letter' } = {}) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}" (use ${TEMPLATES.join(' | ')})`);
  if (!PAPERS[paper]) throw new Error(`Unknown paper "${paper}" (use letter | a4)`);
  const css = `@page { size: ${PAPERS[paper]}; margin: 0.5in 0.55in; }\n${read('base.css')}\n${read(`${template}.css`)}`;
  const headline = (model.headline ?? []).map((p) => `<p class="headline">${p}</p>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(model.name || 'Resume')}</title>
<style>
${css}
</style>
</head>
<body class="tpl-${template} paper-${paper}">
<main class="resume">
<header class="hd"><h1>${escapeHtml(model.name)}</h1>${headline}${model.contact.length ? `<p class="contact">${contactHtml(model.contact)}</p>` : ''}</header>
${model.sections.map(sectionHtml).join('\n')}
</main>
</body>
</html>
`;
}
