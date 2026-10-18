import fs from 'node:fs';
import path from 'node:path';
import { parse, out, fail } from '../lib/args.js';
import { renderResume } from './render.js';
import { verifyPdf, formatReport } from './verify.js';
import { parseKeywords } from './keywords.js';
import { TEMPLATES, PAPERS } from './templates/index.js';

const RENDER_USAGE = 'gaj render <resume.md> [--out file.pdf] [--template classic|modern] [--paper letter|a4] [--track id] [--html] [--json]';
const VERIFY_USAGE = 'gaj verify <file.pdf> [--pages N] [--keywords "a,b,c" | --keywords-file f] [--json]';

async function render(argv) {
  const a = parse(argv, {
    out: { type: 'string', short: 'o' }, template: { type: 'string', default: 'classic' },
    paper: { type: 'string', default: 'letter' }, track: { type: 'string' }, html: { type: 'boolean' },
  });
  if (a.help) return console.log(RENDER_USAGE);
  const input = a._[0];
  if (!input) fail(`missing <resume.md>\nusage: ${RENDER_USAGE}`);
  if (!fs.existsSync(input)) fail(`no such file: ${input}`);
  if (!TEMPLATES.includes(a.template)) fail(`unknown template "${a.template}" (${TEMPLATES.join(' | ')})`);
  if (!PAPERS[a.paper]) fail(`unknown paper "${a.paper}" (letter | a4)`);
  const res = await renderResume(path.resolve(input), { out: a.out, template: a.template, paper: a.paper, track: a.track, html: a.html });
  out(res, a.json, (r) => `Rendered ${r.pdf} (${r.pages} page${r.pages === 1 ? '' : 's'}, ${a.template}, ${a.paper}${a.track ? `, track ${a.track}` : ''})${r.html ? `\nHTML: ${r.html}` : ''}`);
}

async function verify(argv) {
  const a = parse(argv, { pages: { type: 'string' }, keywords: { type: 'string' }, 'keywords-file': { type: 'string' } });
  if (a.help) return console.log(VERIFY_USAGE);
  const file = a._[0];
  if (!file) fail(`missing <file.pdf>\nusage: ${VERIFY_USAGE}`);
  if (!fs.existsSync(file)) fail(`no such file: ${file}`);
  const maxPages = a.pages != null ? Number(a.pages) : undefined;
  if (maxPages != null && !(Number.isInteger(maxPages) && maxPages > 0)) fail('--pages must be a positive integer');
  const keywords = [
    ...parseKeywords(a.keywords),
    ...(a['keywords-file'] ? parseKeywords(fs.readFileSync(a['keywords-file'], 'utf8')) : []),
  ];
  const { text, ...res } = await verifyPdf(file, { pages: maxPages, keywords });
  out(res, a.json, formatReport);
  if (!res.ok) process.exitCode = 1;
}

/** Commands exported to bin/gaj.js (see docs/CONTRACTS.md). */
export const commands = {
  render: { summary: 'Render resume.md to PDF (classic|modern, letter|a4, optional --track)', usage: RENDER_USAGE, run: render },
  verify: { summary: 'Check a resume PDF: pages, extractable text, date dashes, keyword coverage', usage: VERIFY_USAGE, run: verify },
};
