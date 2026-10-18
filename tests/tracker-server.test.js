import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracker');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-server-'));
process.env.GAJ_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, 'data', 'applications', 'acme-fe'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'applications', 'acme-fe', 'resume.md'), '# Resume');
fs.writeFileSync(path.join(ROOT, 'data', 'secret.txt'), 'nope');
fs.copyFileSync(path.join(FIX, 'jobs.json'), path.join(ROOT, 'data', 'jobs.json'));

let srv, base, port;
before(async () => {
  const { createTrackerServer } = await import('../src/tracker/server.js');
  srv = createTrackerServer({ port: 0 });
  ({ port, url: base } = await srv.listen());
});
after(() => srv.close());

const j = async (p, opts = {}) => {
  const res = await fetch(new URL(p, base), {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json', ...opts.headers } : opts.headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
};

// Raw request so we can forge the Host header (fetch won't).
const raw = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject);
  req.end();
});

test('applications CRUD round-trip', async () => {
  let r = await j('/api/applications');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.applications, []);
  r = await j('/api/applications', { method: 'POST', body: { company: 'Acme', role: 'FE', status: 'saved' } });
  assert.equal(r.status, 201);
  const id = r.data.id;
  r = await j(`/api/applications/${id}`, { method: 'PATCH', body: { status: 'applied', note: 'sent' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.history.at(-1).note, 'sent');
  assert.ok(r.data.appliedAt);
  r = await j(`/api/applications/${id}`, { method: 'PATCH', body: { status: 'bogus' } });
  assert.equal(r.status, 400);
  r = await j('/api/stats');
  assert.equal(r.data.kpis.applied, 1);
  r = await j('/api/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment/);
  assert.ok(r.data.includes('Acme'));
  r = await j('/api/export.xlsx');
  assert.equal(r.status, 200);
  r = await j(`/api/applications/${id}`, { method: 'DELETE' });
  assert.equal(r.data.deleted, id);
  r = await j(`/api/applications/${id}`);
  assert.equal(r.status, 404);
});

test('jobs API: list, detail, status, track', async () => {
  let r = await j('/api/jobs');
  assert.equal(r.data.jobs.length, 20);
  assert.ok(r.data.jobs.every((x) => !('description' in x)));
  const job = r.data.jobs.find((x) => x.status === 'new');
  r = await j(`/api/jobs?key=${encodeURIComponent(job.key)}`);
  assert.ok(r.data.description);
  r = await j(`/api/jobs/${encodeURIComponent(job.key)}`, { method: 'PATCH', body: { status: 'skipped' } });
  assert.equal(r.data.status, 'skipped');
  r = await j(`/api/jobs/${encodeURIComponent(job.key)}/track`, { method: 'POST', body: {} });
  assert.equal(r.status, 201);
  assert.equal(r.data.jobKey, job.key);
  r = await j(`/api/jobs/${encodeURIComponent(job.key)}/track`, { method: 'POST', body: {} });
  assert.equal(r.status, 409);
  r = await j('/api/jobs');
  assert.equal(r.data.jobs.find((x) => x.key === job.key).status, 'tracked');
  assert.ok(r.data.jobs.find((x) => x.key === job.key).applicationId);
});

test('rejects non-local Host headers (DNS rebinding)', async () => {
  assert.equal((await raw('/api/applications', { Host: 'evil.example.com' })).status, 403);
  assert.equal((await raw('/', { Host: `evil.example.com:${port}` })).status, 403);
  assert.equal((await raw('/api/applications', { Host: `localhost:${port}` })).status, 200);
});

test('rejects cross-origin and non-JSON mutations', async () => {
  let r = await j('/api/applications', { method: 'POST', body: { company: 'X', role: 'Y' }, headers: { Origin: 'http://evil.example.com' } });
  assert.equal(r.status, 403);
  const res = await fetch(new URL('/api/applications', base), { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"company":"X","role":"Y"}' });
  assert.equal(res.status, 415);
  let status;
  try { status = (await j('/api/applications', { method: 'POST', body: { company: 'X', role: 'Y', pad: 'x'.repeat(1100000) } })).status; } catch { status = 'reset'; }
  assert.ok(status === 413 || status === 'reset', `oversized body -> ${status}`);
});

test('/files serves only data/applications and blocks traversal', async () => {
  let r = await j('/files?path=data/applications/acme-fe/resume.md');
  assert.equal(r.status, 200);
  assert.equal(r.data, '# Resume');
  assert.match(r.headers.get('content-security-policy'), /sandbox/);
  for (const p of ['data/secret.txt', 'data/applications/../secret.txt', '../../../etc/passwd', '/etc/passwd', 'data/applications/%2e%2e/secret.txt', 'data/jobs.json']) {
    r = await j(`/files?path=${encodeURIComponent(p)}`);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  // symlink escaping the applications dir
  fs.symlinkSync(path.join(ROOT, 'data', 'secret.txt'), path.join(ROOT, 'data', 'applications', 'acme-fe', 'link.txt'));
  r = await j('/files?path=data/applications/acme-fe/link.txt');
  assert.equal(r.status, 403);
});

test('static UI is served with CSP', async () => {
  const r = await j('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await j('/app.js')).status, 200);
  assert.equal((await j('/../server.js')).status, 404);
});

test('undo endpoint and malformed URL encoding', async () => {
  let r = await j('/api/applications', { method: 'POST', body: { company: 'U', role: 'V', status: 'drafted' } });
  const id = r.data.id;
  await j(`/api/applications/${id}`, { method: 'PATCH', body: { status: 'applied' } });
  r = await j(`/api/applications/${id}/undo`, { method: 'POST', body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'drafted');
  assert.equal(r.data.appliedAt, null);
  r = await j(`/api/applications/${id}/undo`, { method: 'POST', body: {} });
  assert.equal(r.status, 400);
  assert.equal((await raw('/api/applications/%E0%A4%A', { Host: `127.0.0.1:${port}` })).status, 400);
  assert.equal((await raw('/%E0%A4%A', { Host: `127.0.0.1:${port}` })).status, 400);
});

test('job track conflict matches store message', async () => {
  const { data } = await j('/api/jobs');
  const job = data.jobs.find((x) => x.status === 'ranked');
  const first = await j(`/api/jobs/${encodeURIComponent(job.key)}/track`, { method: 'POST', body: {} });
  const again = await j(`/api/jobs/${encodeURIComponent(job.key)}/track`, { method: 'POST', body: {} });
  assert.equal(again.status, 409);
  assert.equal(again.data.error, `already tracked as ${first.data.id}`);
});
