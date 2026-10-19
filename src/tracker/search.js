// Runs `gaj scrape --json` as a child process for the tracker UI. One run at a time.
// In demo mode nothing is spawned: a short simulated run adds a few fictional jobs.
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, nowISO, withLock } from '../lib/store.js';
import { jobKey } from '../lib/jobKey.js';
import { ConflictError } from './store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const GAJ_BIN = path.join(REPO_ROOT, 'bin', 'gaj.js');
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MAX_STDOUT = 5 * 1024 * 1024;
const LOG_LINES = 50;
/** Track ids as written by /onboard; anything else is refused before it reaches argv. */
export const TRACK_ID = /^[a-z0-9][a-z0-9-]*$/;
export const TIMEOUT_MESSAGE = 'Search stopped after 10 minutes. Nothing was merged into your jobs (the scrape saves only at the end). Try one company (gaj scrape --company <slug>) or turn off some sources in Settings.';

export function scrapeArgs({ paid = false, track, days } = {}) {
  const args = [GAJ_BIN, 'scrape', '--json'];
  if (paid) args.push('--paid');
  if (track) {
    if (!TRACK_ID.test(track)) throw new Error(`invalid track id "${track}"`);
    args.push(`--track=${track}`); // = form: an id can never be read as a separate flag
  }
  if (days) args.push('--days', String(days));
  return args;
}

/**
 * @param {object} o
 * @param {string} o.root GAJ_ROOT for the child (the store's root)
 * @param {Function} [o.spawn] injectable for tests: (cmd, args, opts) => ChildProcess-like
 * @param {boolean} [o.demo] simulate instead of spawning
 * @param {string} [o.jobsFile] demo: jobs.json to add fictional jobs to
 * @param {number} [o.timeoutMs] kill the child after this long (default 10 min)
 * @param {number} [o.demoStepMs] demo: delay between simulated log lines
 */
export function createSearchRunner({ root, spawn = nodeSpawn, demo = false, jobsFile, timeoutMs = 10 * 60 * 1000, demoStepMs = 700 } = {}) {
  let seq = 0;
  let state = { id: null, running: false, startedAt: null, finishedAt: null, exitCode: null, summary: null, log: [], error: null, options: null };

  const pushLog = (text) => {
    for (const line of String(text).replace(ANSI, '').split(/\r?\n/)) {
      if (line.trim()) state.log.push(line.slice(0, 500));
    }
    if (state.log.length > LOG_LINES) state.log = state.log.slice(-LOG_LINES);
  };

  function finish({ exitCode, summary = null, error = null, timedOut = false }) {
    state.timedOut = timedOut;
    state.running = false;
    state.finishedAt = nowISO();
    state.exitCode = exitCode;
    state.summary = summary;
    state.error = error;
  }

  function start(options = {}) {
    if (state.running) throw new ConflictError('a search is already running');
    const id = `search_${Date.now().toString(36)}_${++seq}`;
    state = { id, running: true, startedAt: nowISO(), finishedAt: null, exitCode: null, summary: null, log: [], error: null, options };
    if (demo) { simulate(id, options); return { id }; }

    let child;
    try {
      child = spawn(process.execPath, scrapeArgs(options), {
        cwd: REPO_ROOT, env: { ...process.env, GAJ_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish({ exitCode: null, error: `could not start search: ${err.message}` });
      return { id };
    }
    let stdout = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; pushLog('Search took longer than 10 minutes; stopping it. Nothing was merged.'); child.kill('SIGTERM'); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (c) => { if (stdout.length < MAX_STDOUT) stdout += c; });
    child.stderr?.on('data', (c) => pushLog(c));
    child.on('error', (err) => { clearTimeout(timer); if (state.id === id && state.running) finish({ exitCode: null, error: `could not start search: ${err.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (state.id !== id || !state.running) return;
      let summary = null;
      if (!timedOut) { try { summary = JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { /* not JSON */ } }
      const lastErr = [...state.log].reverse().find((l) => /error/i.test(l)) ?? state.log.at(-1);
      const error = timedOut ? TIMEOUT_MESSAGE
        : code !== 0 ? (lastErr ? lastErr.replace(/^error:\s*/, '') : `search exited with code ${code}`) : null;
      finish({ exitCode: code, summary, error, timedOut });
    });
    return { id };
  }

  // Demo: a believable 3-4 second run that adds fictional jobs to the demo jobs.json.
  function simulate(id, { track } = {}) {
    const lines = [
      'Loading preferences and 24 companies…',
      'greenhouse: 9 companies, 212 postings',
      'lever: 6 companies, 87 postings',
      'ashby: 5 companies, 64 postings',
      'hn: "Who is hiring?" thread, 412 comments',
      'remotive: 38 postings',
      'Filtering by tracks, locations and age…',
      'Merging into data/jobs.json',
    ];
    let i = 0;
    const tick = () => {
      if (state.id !== id) return;
      if (i < lines.length) { pushLog(lines[i++]); setTimeout(tick, demoStepMs); return; }
      addDemoJobs(jobsFile, track)
        .then((summary) => finish({ exitCode: 0, summary }))
        .catch((err) => finish({ exitCode: 1, error: err.message }));
    };
    setTimeout(tick, demoStepMs);
  }

  function status() {
    return { ...state, log: [...state.log] };
  }

  return { start, status, get running() { return state.running; } };
}

const DEMO_JOBS = [
  { company: 'Zentrova', title: 'Senior Frontend Engineer', location: 'Bengaluru, India', countries: ['IN'], workMode: 'hybrid', source: 'greenhouse', track: 'fe', eligibility: 'green', eligibilityReason: 'Based in Bengaluru', quickFit: null },
  { company: 'Quorvel AI', title: 'Forward Deployed Engineer', location: 'Remote (APAC)', countries: ['IN', 'SG'], workMode: 'remote', source: 'ashby', track: 'fde', eligibility: 'green', eligibilityReason: 'Remote within APAC', quickFit: null },
  { company: 'Hollowmere', title: 'UI Engineer, Design Systems', location: 'Remote', countries: [], workMode: 'remote', source: 'hn', track: 'fe', eligibility: 'unknown', eligibilityReason: 'Remote scope not stated', quickFit: null },
];

export function addDemoJobs(jobsFile, track) {
  return withLock(jobsFile, () => addDemoJobsUnlocked(jobsFile, track));
}

function addDemoJobsUnlocked(jobsFile, track) {
  const store = readJSON(jobsFile, null) ?? { version: 1, updatedAt: null, jobs: {} };
  const now = nowISO();
  let added = 0;
  let updated = 0;
  const sources = {};
  const topNew = [];
  for (const d of DEMO_JOBS.filter((x) => !track || x.track === track)) {
    const key = jobKey(d);
    sources[d.source] ??= { jobs: 0, matched: 0, ...(d.source === 'hn' ? { board: true } : { companies: 1 }) };
    sources[d.source].jobs++;
    sources[d.source].matched++;
    if (store.jobs[key]) { store.jobs[key].lastSeen = now; updated++; continue; }
    const slug = `${d.company}-${d.title}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    store.jobs[key] = {
      key, ...d, url: `https://jobs.example.com/${slug}`, applyUrl: null, department: 'Engineering', salary: null,
      postedAt: now, firstSeen: now, lastSeen: now,
      description: `${d.company} is hiring a ${d.title} (${d.location}).\n\n(Sample posting added by the get-a-job demo search.)`,
      status: 'new', rank: null,
    };
    added++;
    topNew.push({ key, title: d.title, company: d.company, location: d.location, track: d.track });
  }
  store.updatedAt = now;
  writeJSON(jobsFile, store);
  return {
    at: now, companies: 20, sources, matched: added + updated, new: added, updated, expired: 0, skipped: 0, crossSource: 0,
    filtered: { title: 318, location: 41, age: 12 }, errors: [], usage: [], warnings: ['Demo mode: simulated search, no network requests were made'], topNew,
  };
}
