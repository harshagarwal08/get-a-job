// Runs Claude Code headless (`claude -p`) for tracker buttons: tailor, rank, cover, cold DM.
// One task at a time. Prompts are built only from validated ids (job keys, application ids),
// never from posting text, so nothing a job page says can reach the command line.
// In demo mode nothing is spawned: a short simulated run.
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nowISO } from '../lib/store.js';
import { ConflictError, ValidationError } from './store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const JOB_KEY = /^[a-z0-9-]+--[a-z0-9-]+--[0-9a-f]{6}$/;
export const APP_ID = /^app_[0-9a-f]{8}$/;
export const FUNDED_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const COVER_KINDS = ['cover', 'referral', 'recruiter', 'form'];
const LOG_LINES = 80;
const TIMEOUT_MS = 20 * 60 * 1000;

// Tools a headless run may use. Bash is limited to the gaj CLI; no network tools beyond fetch/search.
export const ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Bash(node bin/gaj.js:*)', 'Bash(mkdir -p data/:*)', 'Bash(wc:*)',
];

const NON_INTERACTIVE = 'You are running headless from the tracker UI: there is no user to answer questions. '
  + 'Never call AskUserQuestion. Where a command says to ask, take the safe default (skip optional drafts, '
  + 'never add unconfirmed facts, never use paid providers) and list what you skipped at the end. '
  + 'Never send, submit or post anything.';

/** Build the prompt for a task. Throws ValidationError on bad input. */
export function taskPrompt({ task, key, id, kind }) {
  const need = (v, re, what) => { if (typeof v !== 'string' || !re.test(v)) throw new ValidationError(`${what} is invalid`); return v; };
  switch (task) {
    case 'tailor': {
      if (key) return `/tailor ${need(key, JOB_KEY, 'job key')}\n\n${NON_INTERACTIVE}`;
      return `/tailor for the tracked application ${need(id, APP_ID, 'application id')} (find it with node bin/gaj.js track list --json; use its jobKey, or its url, or the job_posting.md in its appDir).\n\n${NON_INTERACTIVE}`;
    }
    case 'rank':
      return `/rank ${need(key, JOB_KEY, 'job key')}\n\nRank only this one job.\n\n${NON_INTERACTIVE}`;
    case 'cover': {
      if (!COVER_KINDS.includes(kind)) throw new ValidationError(`kind must be one of ${COVER_KINDS.join(', ')}`);
      return `/cover ${need(id, APP_ID, 'application id')} ${kind}\n\nThe argument is a tracker application id; find it with node bin/gaj.js track list --json.\n\n${NON_INTERACTIVE}`;
    }
    case 'outreach': {
      if (key) return `/outreach ${need(key, JOB_KEY, 'job key')}\n\n${NON_INTERACTIVE}`;
      return `/outreach ${need(id, APP_ID, 'application id')}\n\nThe argument is a tracker application id; find it with node bin/gaj.js track list --json.\n\n${NON_INTERACTIVE}`;
    }
    case 'cold-dm':
      return `/cold-dm ${need(key, FUNDED_ID, 'funded company id')}\n\n${NON_INTERACTIVE}`;
    default:
      throw new ValidationError('task must be tailor, rank, outreach, cover or cold-dm');
  }
}

/** Whether the `claude` CLI is on PATH (cached). */
let claudeOk;
export function claudeAvailable(bin = 'claude') {
  if (claudeOk === undefined) {
    const r = spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000 });
    claudeOk = !r.error && r.status === 0;
  }
  return claudeOk;
}

/** Short, human lines from a stream-json event (assistant text and tool use). */
export function eventLines(evt) {
  if (evt?.type === 'assistant') {
    return (evt.message?.content ?? []).flatMap((c) => {
      if (c.type === 'text' && c.text?.trim()) return c.text.trim().split('\n').filter((l) => l.trim()).slice(0, 6);
      if (c.type === 'tool_use') {
        const cmd = c.input?.command ?? c.input?.file_path ?? c.input?.url ?? c.input?.query ?? c.input?.pattern ?? '';
        return [`→ ${c.name}${cmd ? ` ${String(cmd).slice(0, 140)}` : ''}`];
      }
      return [];
    });
  }
  if (evt?.type === 'result') return [evt.is_error ? `✗ ${evt.result ?? 'failed'}` : '✓ done'];
  return [];
}

/**
 * @param {object} o
 * @param {string} o.root GAJ_ROOT for the child
 * @param {Function} [o.spawn] injectable for tests
 * @param {boolean} [o.demo]
 * @param {string} [o.bin] claude binary
 */
export function createAgentRunner({ root, spawn = nodeSpawn, demo = false, bin = 'claude', timeoutMs = TIMEOUT_MS, demoStepMs = 600 } = {}) {
  let seq = 0;
  let state = { id: null, running: false, task: null, startedAt: null, finishedAt: null, exitCode: null, log: [], result: null, error: null };
  const push = (lines) => {
    for (const l of lines) if (String(l).trim()) state.log.push(String(l).slice(0, 400));
    if (state.log.length > LOG_LINES) state.log = state.log.slice(-LOG_LINES);
  };
  const finish = (o) => Object.assign(state, { running: false, finishedAt: nowISO(), ...o });

  function start(input) {
    if (state.running) throw new ConflictError(`a ${state.task?.task ?? 'Claude'} task is already running`);
    const prompt = taskPrompt(input);
    if (!demo && !claudeAvailable(bin)) throw new ValidationError('Claude Code CLI ("claude") is not installed or not on PATH');
    const id = `task_${Date.now().toString(36)}_${++seq}`;
    const task = { task: input.task, key: input.key ?? null, id: input.id ?? null, kind: input.kind ?? null };
    state = { id, running: true, task, startedAt: nowISO(), finishedAt: null, exitCode: null, log: [], result: null, error: null };
    if (demo) { simulate(id); return { id }; }

    let child;
    try {
      child = spawn(bin, ['-p', prompt, '--output-format', 'stream-json', '--verbose',
        '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS.join(',')], {
        cwd: REPO_ROOT, env: { ...process.env, GAJ_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) { finish({ error: `could not start Claude: ${err.message}` }); return { id }; }
    let buf = '';
    const timer = setTimeout(() => { push(['Stopped after 20 minutes.']); child.kill('SIGTERM'); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const evt = JSON.parse(line);
          push(eventLines(evt));
          if (evt.type === 'result') state.result = typeof evt.result === 'string' ? evt.result.slice(0, 4000) : null;
        } catch { /* partial or non-JSON line */ }
      }
    });
    child.stderr?.on('data', (c) => push(String(c).split('\n').slice(-3)));
    child.on('error', (err) => { clearTimeout(timer); if (state.id === id && state.running) finish({ error: `could not start Claude: ${err.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (state.id !== id || !state.running) return;
      finish({ exitCode: code, error: code === 0 ? null : (state.log.at(-1) ?? `Claude exited with code ${code}`) });
    });
    return { id };
  }

  function simulate(id) {
    const lines = ['→ Read profile/profile.md', '→ Bash node bin/gaj.js job <key> --json', 'Drafting tailored resume…', '→ Bash node bin/gaj.js render …', '→ Bash node bin/gaj.js ats …', '✓ done'];
    let i = 0;
    const tick = () => {
      if (state.id !== id) return;
      if (i < lines.length) { push([lines[i++]]); setTimeout(tick, demoStepMs); return; }
      finish({ exitCode: 0, result: 'Demo mode: no Claude run was made.' });
    };
    setTimeout(tick, demoStepMs);
  }

  const status = () => ({ ...state, log: [...state.log], available: demo || claudeAvailable(bin) });
  return { start, status, get running() { return state.running; } };
}
