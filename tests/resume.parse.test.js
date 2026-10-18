import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResume, extractTracks, isMetaLine } from '../src/resume/parse.js';
import { filterByTrack, knownTracks } from '../src/resume/filter.js';
import { buildHtml } from '../src/resume/templates/index.js';
import { renderHtml } from '../src/resume/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const edge = fs.readFileSync(path.join(here, 'fixtures/resume/edge.md'), 'utf8');
const example = fs.readFileSync(path.join(here, '../examples/resume.example.md'), 'utf8');
const m = parseResume(edge);
const sec = (title) => m.sections.find((s) => s.title === title);

test('name, contact and headline', () => {
  assert.equal(m.name, 'Sam <Tester>');
  assert.deepEqual(m.contact[0], { text: 'sam@example.com', href: 'mailto:sam@example.com' });
  assert.equal(m.contact[1].href, 'tel:+15550102000');
  assert.deepEqual(m.contact[2], { text: 'Portfolio', href: 'https://sam.dev' });
  assert.deepEqual(m.contact[3], { text: 'bad' }, 'javascript: href dropped');
  assert.deepEqual(m.headline, ['Staff engineer, payments']);
});

test('section with paragraphs only, nested inline markdown', () => {
  const s = sec('Summary');
  assert.equal(s.paragraphs.length, 2);
  assert.equal(s.entries.length, 0);
  assert.match(s.paragraphs[0], /<strong>bold <em>and italic<\/em><\/strong>/);
  assert.match(s.paragraphs[0], /<code>code<\/code>/);
  assert.match(s.paragraphs[0], /<a href="https:\/\/example.com">link<\/a>/);
});

test('raw HTML is escaped', () => {
  const p = sec('Summary').paragraphs[1];
  assert.ok(!p.includes('<script>'));
  assert.match(p, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  const html = buildHtml(m);
  assert.ok(!/<script/i.test(html));
  assert.ok(!html.includes('javascript:'));
  assert.match(html, /<h1>Sam &lt;Tester&gt;<\/h1>/);
  assert.match(html, /<pre><code>code block &lt;b&gt;/);
});

test('entry without meta line, track comments recorded and stripped', () => {
  const [e1] = sec('Experience').entries;
  assert.equal(e1.title, 'Engineer');
  assert.equal(e1.org, '<strong>Acme</strong> Inc');
  assert.deepEqual(e1.meta, {});
  assert.deepEqual(e1.bullets.map((b) => b.tracks), [[], ['fe', 'fde'], ['fde']]);
  assert.ok(e1.bullets.every((b) => !b.html.includes('<!--')));
  assert.match(e1.bullets[2].html, /<ul><li>nested child<\/li><\/ul>/);
  assert.ok(!buildHtml(m).includes('tracks:'));
});

test('meta line with location in heading, body paragraph after meta', () => {
  const e2 = sec('Experience').entries[1];
  assert.deepEqual(e2.meta, { dates: '2020 – 2022', location: 'Remote' });
  assert.deepEqual(e2.body, ['Built things in a body paragraph.']);
  assert.equal(e2.bullets.length, 1);
});

test('skills bullets and fallback blocks', () => {
  assert.equal(sec('Skills').bullets[0].html, '<strong>Languages:</strong> TypeScript &amp; Go');
  assert.match(sec('Notes').extra, /<blockquote><p>A quote<\/p><\/blockquote>/);
  assert.ok(!sec('Notes').extra.includes('stray'));
});

test('isMetaLine and extractTracks', () => {
  assert.ok(isMetaLine('Jul 2023 - Present | Remote'));
  assert.ok(isMetaLine('2019 - 2023'));
  assert.ok(!isMetaLine('Built a thing for customers.'));
  assert.deepEqual(extractTracks('x <!-- tracks: FE,fde --> <!-- track: ml -->'), ['fe', 'fde', 'ml']);
});

const quiet = { warn: () => {} };

test('track filtering keeps untagged + matching bullets', () => {
  const ids = (model) => model.sections.find((s) => s.title === 'Experience').entries[0].bullets.map((b) => b.html);
  assert.equal(ids(filterByTrack(m)).length, 3);
  assert.deepEqual(ids(filterByTrack(m, 'fe', quiet)), ['No meta line here.', 'Tagged both']);
  assert.equal(ids(filterByTrack(m, 'FDE', quiet)).length, 3);
  assert.deepEqual(ids(filterByTrack(m, 'ml', quiet)), ['No meta line here.']);
  assert.equal(m.sections.find((s) => s.title === 'Experience').entries[0].bullets.length, 3, 'input not mutated');
});

test('example resume renders for both templates and papers', () => {
  for (const template of ['classic', 'modern']) {
    for (const paper of ['letter', 'a4']) {
      const html = renderHtml(example, { template, paper, track: 'fe', warn: () => assert.fail('fe is a known track') });
      assert.match(html, new RegExp(`size: ${paper === 'a4' ? 'A4' : 'Letter'}`));
      assert.match(html, /<h2>Experience<\/h2>/);
      assert.ok(html.includes('offline mode to the driver PWA'));
      assert.ok(!html.includes('on-site at a warehouse'), 'fde-only bullet removed for fe');
    }
  }
  assert.throws(() => renderHtml(example, { template: 'fancy' }), /Unknown template/);
});

test('unknown track warns with the known track list', () => {
  const msgs = [];
  filterByTrack(m, 'ml', { warn: (x) => msgs.push(x) });
  filterByTrack(m, 'fe', { warn: (x) => msgs.push(x) });
  assert.deepEqual(knownTracks(m), ['fde', 'fe']);
  assert.deepEqual(msgs, ["track 'ml' not found in any bullet tags; known: fde, fe"]);
});
