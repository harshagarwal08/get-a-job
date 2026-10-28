import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tracker');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-agent-'));
process.env.GAJ_ROOT = ROOT;
fs.mkdirSync(path.join(ROOT, 'data', 'applications', 'acme-fe'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'applications', 'acme-fe', 'resume.pdf'), '%PDF');
fs.writeFileSync(path.join(ROOT, 'data', 'applications', 'acme-fe', 'ats_report.md'), '# ATS');
fs.copyFileSync(path.join(FIX, 'jobs.json'), path.join(ROOT, 'data', 'jobs.json'));
fs.writeFileSync(path.join(ROOT, 'data', 'funded.json'), JSON.stringify({ version: 1, companies: [{ id: 'mirelune-travel', name: 'Mirelune Travel', round: 'seed', announcedAt: '2026-10-10', status: 'new' }] }));
const KEY = 'mirelune-travel--frontend-platform-engineer--7b4b14';

let agent, srv, base, spawned;
// Fake `claude`: emits two stream-json events, then exits 0.
const fakeSpawn = (cmd, args) => {
  spawned = { cmd, args };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  setTimeout(() => {
    child.stdout.emit('data', `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'node bin/gaj.js job x --json' } }, { type: 'text', text: 'Tailoring now' }] } })}\n`);
    child.stdout.emit('data', `${JSON.stringify({ type: 'result', is_error: false, result: 'Resume at data/applications/x/resume.pdf' })}\n`);
    child.emit('close', 0);
  }, 10);
  return child;
};

before(async () => {
  agent = await import('../src/tracker/agent.js');
  const { createTrackerServer } = await import('../src/tracker/server.js');
  const runner = agent.createAgentRunner({ root: ROOT, spawn: fakeSpawn, bin: process.execPath });
  srv = createTrackerServer({ port: 0, agent: runner });
  ({ url: base } = await srv.listen());
});
after(() => srv.close());

const j = async (p, body, method = body ? 'POST' : 'GET') => {
  const res = await fetch(new URL(p, base), { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const waitDone = async () => { for (let i = 0; i < 50; i++) { const s = (await j('/api/agent/status')).data; if (!s.running) return s; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

test('taskPrompt accepts only validated ids', () => {
  assert.match(agent.taskPrompt({ task: 'tailor', key: KEY }), /^\/tailor mirelune-travel--frontend-platform-engineer--7b4b14\n/);
  assert.match(agent.taskPrompt({ task: 'cover', id: 'app_0123abcd', kind: 'referral' }), /^\/cover app_0123abcd referral/);
  assert.match(agent.taskPrompt({ task: 'rank', key: KEY }), /Never call AskUserQuestion/);
  assert.throws(() => agent.taskPrompt({ task: 'tailor', key: 'x; rm -rf /' }), /job key is invalid/);
  assert.throws(() => agent.taskPrompt({ task: 'cover', id: 'app_0123abcd', kind: 'tweet' }), /kind must be/);
  assert.throws(() => agent.taskPrompt({ task: 'shell' }), /task must be/);
});

test('eventLines summarises tool use and results', () => {
  assert.deepEqual(agent.eventLines({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'profile/profile.md' } }] } }), ['→ Read profile/profile.md']);
  assert.deepEqual(agent.eventLines({ type: 'result', is_error: true, result: 'boom' }), ['✗ boom']);
});

test('POST /api/agent runs claude headless with a restricted toolset', async () => {
  let r = await j('/api/agent', { task: 'tailor', key: KEY });
  assert.equal(r.status, 202);
  const s = await waitDone();
  assert.equal(s.exitCode, 0);
  assert.equal(s.result, 'Resume at data/applications/x/resume.pdf');
  assert.ok(s.log.some((l) => l.includes('→ Bash node bin/gaj.js job x --json')));
  const tools = spawned.args[spawned.args.indexOf('--allowedTools') + 1];
  assert.match(tools, /Bash\(node bin\/gaj\.js:\*\)/);
  assert.doesNotMatch(tools, /Bash(,|$)/);
  assert.equal(spawned.args[spawned.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  r = await j('/api/agent', { task: 'tailor', key: '../../etc' });
  assert.equal(r.status, 400);
});

test('job list carries descLen and funded badges; descriptions can be pasted', async () => {
  let r = await j('/api/jobs');
  const job = r.data.jobs.find((x) => x.key === KEY);
  assert.equal(job.descLen, 390);
  assert.equal(job.funded.round, 'seed');
  assert.equal(job.description, undefined);
  r = await j(`/api/jobs/${KEY}/description`, { text: 'too short' });
  assert.equal(r.status, 400);
  const text = `Responsibilities\n${'Build product features with users. '.repeat(20)}`;
  r = await j(`/api/jobs/${KEY}/description`, { text });
  assert.equal(r.status, 200);
  assert.equal(r.data.descLen, text.trim().length);
  assert.equal((await j(`/api/jobs?key=${KEY}`)).data.descriptionVia, 'pasted');
  r = await j('/api/jobs/nope--nope--000000/description', { text });
  assert.equal(r.status, 404);
});

test('application files are listed only from data/applications', async () => {
  let r = await j('/api/applications', { company: 'Acme', role: 'FE', appDir: 'data/applications/acme-fe' });
  const id = r.data.id;
  r = await j(`/api/applications/${id}/files`);
  assert.deepEqual(r.data.files.map((f) => f.name), ['ats_report.md', 'resume.pdf']);
  // An appDir outside data/applications/ is refused when saved, or lists nothing.
  r = await j('/api/applications', { company: 'Evil', role: 'X', appDir: 'data' });
  if (r.status === 201) assert.deepEqual((await j(`/api/applications/${r.data.id}/files`)).data.files, []);
  else assert.equal(r.status, 400);
});

test('outreach.json is re-validated before the UI sees it', async () => {
  fs.writeFileSync(path.join(ROOT, 'data', 'applications', 'acme-fe', 'outreach.json'), JSON.stringify({
    generatedAt: '2026-10-21T00:00:00Z',
    contacts: [
      { id: 'c1', name: 'Asha Rao', title: 'Head of Product', kind: 'hiring-manager', confidence: 'confirmed', source: 'https://acme.example/team', linkedin: 'javascript:alert(1)', email: 'not an email' },
      { id: 'c2', title: 'no name' },
    ],
    searches: [{ label: 'Find a referrer', url: 'https://www.linkedin.com/search/results/people/?keywords=Acme' }, { label: 'bad', url: 'file:///etc/passwd' }],
    messages: [{ id: 'm1', kind: 'referral', channel: 'linkedin-note', to: 'c1', text: 'Hi Asha\u0007, quick note.' }, { id: 'm2', kind: 'spam', channel: 'sms', text: 'x' }],
  }));
  let r = await j('/api/applications', { company: 'Acme2', role: 'PM', appDir: 'data/applications/acme-fe' });
  r = await j(`/api/applications/${r.data.id}/outreach`);
  assert.equal(r.data.contacts.length, 1);
  assert.equal(r.data.contacts[0].linkedin, null);
  assert.equal(r.data.contacts[0].email, null);
  assert.deepEqual(r.data.searches.map((s) => s.label), ['Find a referrer']);
  assert.equal(r.data.messages[0].text, 'Hi Asha, quick note.');
  assert.equal(r.data.messages[1].kind, 'cold');
  assert.equal(r.data.messages[1].channel, 'linkedin-dm');
  assert.match(agent.taskPrompt({ task: 'outreach', key: KEY }), /^\/outreach mirelune/);
});

test('templates fall back to the example file', async () => {
  const r = await j('/api/templates');
  assert.equal(r.status, 200);
  assert.equal(r.data.personal, false);
  assert.ok(r.data.templates.some((t) => t.kind === 'referral' && t.text.includes('{{company}}')));
});
