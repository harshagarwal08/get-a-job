import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderResume } from '../src/resume/render.js';
import { verifyPdf } from '../src/resume/verify.js';
import { launchBrowser } from '../src/resume/browser.js';

const example = path.join(path.dirname(fileURLToPath(import.meta.url)), '../examples/resume.example.md');

test('example resume renders to a 1-page Letter PDF in both templates', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchBrowser(); } catch (err) { t.skip(`Chrome unavailable: ${err.message.split('\n')[0]}`); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-resume-'));
  try {
    for (const template of ['classic', 'modern']) {
      const res = await renderResume(example, { out: path.join(dir, `${template}.pdf`), template, html: true, browser });
      assert.equal(res.pages, 1, `${template} should fit one page`);
      assert.ok(fs.existsSync(res.html));
      const v = await verifyPdf(res.pdf, { pages: 1, keywords: ['React', 'TypeScript', 'Kubernetes'] });
      assert.ok(v.ok);
      assert.ok(v.checks.every((c) => c.ok), JSON.stringify(v.checks));
      assert.deepEqual(v.keywords.map((k) => k.status), ['covered', 'covered', 'missing']);
      assert.match(v.text, /Mar 2021 - Present/);
    }
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
