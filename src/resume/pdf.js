/**
 * Load a PDF (Buffer/Uint8Array) with pdfjs and return {pages, lines, text, links}.
 * `links` are the URLs of link annotations (what a click opens, not what the text shows).
 * Lines are reconstructed per page by grouping text items on similar y and sorting by x.
 * @param {Uint8Array|Buffer} data
 */
export async function extractPdf(data) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(data), verbosity: 0, isEvalSupported: false, disableFontFace: true, useSystemFonts: false,
  }).promise;
  const lines = [];
  const links = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    lines.push(...groupLines(items.filter((i) => typeof i.str === 'string' && i.str.length)));
    for (const a of await page.getAnnotations()) if (a.subtype === 'Link' && a.url) links.push(a.url);
  }
  const pages = doc.numPages;
  await doc.destroy();
  return { pages, lines, text: lines.join('\n'), links };
}

/** Group pdfjs text items into lines of text (top-to-bottom, left-to-right). */
export function groupLines(items) {
  const sorted = items
    .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width ?? 0, h: Math.abs(i.transform[3]) || 10 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows = [];
  for (const it of sorted) {
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, it.h * 0.35));
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  return rows.sort((a, b) => b.y - a.y).map(({ items: row }) => {
    row.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const it of row) {
      if (end !== null && it.x - end > it.h * 0.15 && !/\s$/.test(out) && !/^\s/.test(it.str)) out += ' ';
      out += it.str;
      end = it.x + it.w;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}
