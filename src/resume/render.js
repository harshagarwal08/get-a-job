import fs from 'node:fs';
import path from 'node:path';
import { parseResume } from './parse.js';
import { filterByTrack } from './filter.js';
import { buildHtml, PAPERS } from './templates/index.js';
import { launchBrowser } from './browser.js';
import { extractPdf } from './pdf.js';
import { resolvePdfPath } from './outpath.js';

/**
 * Markdown source → final HTML string (parse, track filter, template).
 * @param {string} md
 * @param {{template?: string, paper?: 'letter'|'a4', track?: string, warn?: (msg: string) => void}} [opts]
 */
export function renderHtml(md, { template = 'classic', paper = 'letter', track, warn } = {}) {
  return buildHtml(filterByTrack(parseResume(md), track, warn ? { warn } : {}), { template, paper });
}

/**
 * Render an HTML document to a PDF buffer with headless Chrome.
 * @param {string} html
 * @param {{paper?: 'letter'|'a4', browser?: import('puppeteer').Browser}} [opts]
 */
export async function htmlToPdf(html, { paper = 'letter', browser } = {}) {
  const own = !browser;
  const b = browser ?? await launchBrowser();
  try {
    const page = await b.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({ format: PAPERS[paper], printBackground: true, preferCSSPageSize: true });
    await page.close();
    return Buffer.from(pdf);
  } finally {
    if (own) await b.close();
  }
}

/**
 * Render resume.md to PDF (and optionally HTML next to it).
 * @param {string} input path to resume.md
 * Output must resolve inside data/, profile/ or the OS temp dir; inputs under examples/ default to the temp dir.
 * @param {{out?: string, template?: string, paper?: 'letter'|'a4', track?: string, html?: boolean, browser?: object, warn?: (msg: string) => void}} [opts]
 * @returns {Promise<{pdf: string, html?: string, pages: number}>}
 */
export async function renderResume(input, { out, template = 'classic', paper = 'letter', track, html: writeHtml = false, browser, warn } = {}) {
  const pdfPath = resolvePdfPath(input, out);
  const md = fs.readFileSync(input, 'utf8');
  const html = renderHtml(md, { template, paper, track, warn });
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  const buf = await htmlToPdf(html, { paper, browser });
  fs.writeFileSync(pdfPath, buf);
  const result = { pdf: pdfPath };
  if (writeHtml) {
    result.html = pdfPath.replace(/\.pdf$/i, '') + '.html';
    fs.writeFileSync(result.html, html);
  }
  result.pages = (await extractPdf(buf)).pages;
  return result;
}
