import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-funded-'));
process.env.GAJ_ROOT = ROOT;
let f;
before(async () => { f = await import('../src/funded/funded.js'); });

const NOW = new Date('2026-10-21T00:00:00Z');
const round = (o = {}) => ({ name: 'Acme AI', round: 'Series-A', amountUsd: 12e6, announcedAt: '2026-10-10', sourceUrl: 'https://news.example/acme', ...o });

test('normalizeRound cleans untrusted text and rejects bad records', () => {
  const { record } = f.normalizeRound(round({ name: 'Acme <b>AI</b>\n$(rm)', investors: ['Peak XV', '', 'x'.repeat(500)], website: 'javascript:alert(1)' }), NOW);
  assert.equal(record.name, 'Acme bAI/b (rm)');
  assert.equal(record.round, 'series-a');
  assert.equal(record.website, null);
  assert.equal(record.investors.length, 2);
  assert.equal(record.investors[1].length, 120);
  assert.match(f.normalizeRound(round({ announcedAt: '10/10/2026' }), NOW).error, /YYYY-MM-DD/);
  assert.match(f.normalizeRound(round({ announcedAt: '2026-12-01' }), NOW).error, /future/);
  assert.match(f.normalizeRound(round({ sourceUrl: 'ftp://x' }), NOW).error, /sourceUrl/);
  assert.equal(f.normalizeRound(round({ round: 'mega' }), NOW).record.round, 'unknown');
});

test('addRounds dedupes by company, keeps the newest round and the status', async () => {
  let r = await f.addRounds([round(), round({ name: 'Beta', announcedAt: '2026-09-01' }), { name: 'Bad' }], { now: NOW });
  assert.deepEqual(r.added, ['acme-ai', 'beta']);
  assert.equal(r.errors.length, 1);
  await f.setFunded('acme-ai', { status: 'contacted', note: 'DM to founder' });
  r = await f.addRounds([round({ round: 'series-b', announcedAt: '2026-10-15' }), round({ announcedAt: '2026-01-01' })], { now: NOW });
  assert.deepEqual(r.updated, ['acme-ai']);
  assert.deepEqual(r.unchanged, ['acme-ai']);
  const acme = f.listFunded().find((c) => c.id === 'acme-ai');
  assert.equal(acme.round, 'series-b');
  assert.equal(acme.status, 'contacted');
  assert.equal(acme.notes[0].text, 'DM to founder');
});

test('listFunded filters by age and status, newest first', () => {
  assert.deepEqual(f.listFunded().map((c) => c.id), ['acme-ai', 'beta']);
  assert.deepEqual(f.listFunded({ days: 30, now: NOW }).map((c) => c.id), ['acme-ai']);
  assert.deepEqual(f.listFunded({ status: 'new' }).map((c) => c.id), ['beta']);
});

test('setFunded validates status and id', async () => {
  await assert.rejects(f.setFunded('beta', { status: 'hired' }), /status must be/);
  await assert.rejects(f.setFunded('nope', { status: 'skipped' }), /no funded company/);
});
