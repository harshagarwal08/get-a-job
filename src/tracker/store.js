// Tracker store: data/tracker.json (owned here) + narrow read/status-only access to data/jobs.json.
// Every operation re-reads from disk (the Claude CLI may edit files concurrently) and writes atomically.
// Mutations are async: each read-modify-write holds withLock(file) and re-reads inside the lock.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { paths } from '../lib/paths.js';
import { readJSON, writeJSON, nowISO, withLock } from '../lib/store.js';

export const STAGES = ['saved', 'drafted', 'applied', 'screening', 'interview', 'offer', 'hired'];
export const ACTIVE_STATUSES = ['saved', 'drafted', 'applied', 'screening', 'interview', 'offer'];
export const FINAL_STATUSES = ['hired', 'rejected', 'withdrawn', 'no_response', 'offer_declined'];
export const STATUSES = [...ACTIVE_STATUSES, ...FINAL_STATUSES];
export const CHANNELS = ['ats', 'referral', 'linkedin', 'email', 'recruiter', 'cold', 'other'];
export const WORK_MODES = ['remote', 'hybrid', 'onsite', 'unknown'];
export const VERDICTS = ['Strong', 'Good', 'Moderate', 'Weak', 'Poor'];
export const JOB_STATUSES = ['new', 'skipped', 'ranked', 'tracked', 'expired'];

// Fields a caller may set directly (via API body, `--field key=value`, or add flags).
export const EDITABLE_FIELDS = [
  'jobKey', 'company', 'role', 'track', 'url', 'location', 'workMode', 'status', 'channel', 'fit',
  'salary', 'contact', 'appDir', 'resumePath', 'coverPath', 'deadline', 'appliedAt', 'nextAction', 'nextActionDate', 'notes',
];

const STRING_FIELDS = ['jobKey', 'company', 'role', 'track', 'url', 'location', 'salary', 'contact', 'appDir', 'resumePath', 'coverPath', 'nextAction', 'notes'];
const NULLABLE = new Set(['jobKey', 'track', 'url', 'location', 'salary', 'contact', 'appDir', 'resumePath', 'coverPath', 'deadline', 'appliedAt', 'nextAction', 'nextActionDate', 'fit']);

export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; this.status = 400; }
}
export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'NotFoundError'; this.status = 404; }
}
export class ConflictError extends Error {
  constructor(msg, data) { super(msg); this.name = 'ConflictError'; this.status = 409; this.data = data; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export function isValidISO(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(new Date(s).getTime());
}

// Last non-undone history timestamp (quiet time for /followup), falling back to updatedAt.
export function lastActivityAt(app) {
  const live = (app.history ?? []).filter((h) => !h.undone);
  return live.length ? live[live.length - 1].at : app.updatedAt ?? null;
}

const newId = () => 'app_' + randomBytes(4).toString('hex');
const emptyTracker = () => ({ version: 1, updatedAt: nowISO(), applications: [] });

// Validate + normalise a partial patch of editable fields. Returns a clean object.
export function normalizePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ValidationError('body must be an object');
  const out = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!EDITABLE_FIELDS.includes(key)) throw new ValidationError(`unknown field "${key}"`);
    let v = raw;
    if (typeof v === 'string') v = v.trim();
    if ((v === '' || v === null || v === undefined) && NULLABLE.has(key)) { out[key] = null; continue; }
    switch (key) {
      case 'status':
        if (!STATUSES.includes(v)) throw new ValidationError(`status must be one of ${STATUSES.join(', ')}`);
        break;
      case 'channel':
        if (!CHANNELS.includes(v)) throw new ValidationError(`channel must be one of ${CHANNELS.join(', ')}`);
        break;
      case 'workMode':
        if (v === null || v === '') v = 'unknown';
        if (!WORK_MODES.includes(v)) throw new ValidationError(`workMode must be one of ${WORK_MODES.join(', ')}`);
        break;
      case 'deadline': case 'nextActionDate':
        if (!isValidDate(v)) throw new ValidationError(`${key} must be a YYYY-MM-DD date`);
        break;
      case 'appliedAt':
        if (isValidDate(v)) v = `${v}T00:00:00.000Z`;
        if (!isValidISO(v)) throw new ValidationError('appliedAt must be an ISO date');
        v = new Date(v).toISOString();
        break;
      case 'fit': v = normalizeFit(v); break;
      case 'company': case 'role':
        if (typeof v !== 'string' || !v) throw new ValidationError(`${key} is required`);
        break;
      case 'notes':
        if (v === null || v === undefined) v = '';
        if (typeof v !== 'string') throw new ValidationError('notes must be a string');
        break;
      case 'url':
        if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) throw new ValidationError('url must start with http:// or https://');
        break;
      default:
        if (STRING_FIELDS.includes(key) && typeof v !== 'string') throw new ValidationError(`${key} must be a string`);
    }
    if (typeof v === 'string' && v.length > 20000) throw new ValidationError(`${key} is too long`);
    out[key] = v;
  }
  return out;
}

function normalizeFit(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || typeof v === 'string') v = { score: v };
  if (typeof v !== 'object') throw new ValidationError('fit must be {score, verdict}');
  let score = v.score === '' || v.score === undefined ? null : v.score;
  if (score !== null) {
    score = Number(score);
    if (!Number.isFinite(score) || score < 0 || score > 100) throw new ValidationError('fit.score must be 0-100');
    score = Math.round(score);
  }
  let verdict = v.verdict === '' || v.verdict === undefined ? null : v.verdict;
  if (verdict !== null) {
    verdict = String(verdict).trim();
    verdict = verdict.charAt(0).toUpperCase() + verdict.slice(1).toLowerCase();
    if (!VERDICTS.includes(verdict)) throw new ValidationError(`fit.verdict must be one of ${VERDICTS.join(', ')}`);
  }
  if (score === null && verdict === null) return null;
  return { score, verdict: verdict ?? verdictFor(score) };
}

export function verdictFor(score) {
  if (score === null || score === undefined) return null;
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'Good';
  if (score >= 45) return 'Moderate';
  if (score >= 30) return 'Weak';
  return 'Poor';
}

export function createStore({ trackerFile = paths.tracker, jobsFile = paths.jobs, root = paths.root } = {}) {
  const load = () => {
    const t = readJSON(trackerFile, null);
    if (!t) return emptyTracker();
    if (!Array.isArray(t.applications)) t.applications = [];
    return t;
  };
  const save = (t) => { t.version = 1; t.updatedAt = nowISO(); writeJSON(trackerFile, t); return t; };

  const appsDir = path.resolve(root, 'data', 'applications');
  // normalizePatch + checks that need the root (appDir must live under data/applications/).
  function clean(patch) {
    const fields = normalizePatch(patch);
    if (typeof fields.appDir === 'string') {
      const abs = path.resolve(root, fields.appDir);
      if (!abs.startsWith(appsDir + path.sep)) throw new ValidationError('appDir must be under data/applications/');
      fields.appDir = path.relative(root, abs).split(path.sep).join('/');
    }
    return fields;
  }

  function find(t, id) {
    const exact = t.applications.find((a) => a.id === id);
    if (exact) return exact;
    const pref = id && id.length >= 4 ? t.applications.filter((a) => a.id.startsWith(id)) : [];
    if (pref.length === 1) return pref[0];
    if (pref.length > 1) throw new ValidationError(`id prefix matches ${pref.length} applications`);
    throw new NotFoundError(`application ${id} not found`);
  }

  function list({ status } = {}) {
    const apps = load().applications;
    return status ? apps.filter((a) => a.status === status) : apps;
  }

  function get(id) { return find(load(), id); }

  const lockT = (fn) => withLock(trackerFile, fn);
  const lockJ = (fn) => withLock(jobsFile, fn);

  // Returns {app, created}. A row with the same jobKey → ConflictError, unless upsert (then merge into it).
  async function addOrUpdate(input, { note, upsert = false } = {}) {
    const fields = clean(input);
    return lockT(() => {
      const t = load();
      const existing = fields.jobKey ? t.applications.find((a) => a.jobKey === fields.jobKey) : null;
      if (existing) {
        if (!upsert) throw new ConflictError(`already tracked as ${existing.id}`, existing);
        const app = applyUpdate(t, existing.id, fields, note);
        save(t);
        return { app, created: false };
      }
      const app = insertInto(t, fields, note);
      save(t);
      return { app, created: true };
    });
  }

  async function add(input, opts = {}) { return (await addOrUpdate(input, opts)).app; }

  function insertInto(t, fields, note) {
    if (!fields.company || !fields.role) throw new ValidationError('company and role are required');
    const now = nowISO();
    const status = fields.status ?? 'drafted';
    const app = {
      id: newId(), jobKey: null, company: '', role: '', track: null, url: null, location: null, workMode: 'unknown',
      status, channel: 'ats', fit: null, salary: null, contact: null, appDir: null, resumePath: null, coverPath: null,
      deadline: null, appliedAt: null, nextAction: null, nextActionDate: null, notes: '',
      ...fields,
      createdAt: now, updatedAt: now,
      history: [{ at: now, status, note: note ?? 'Created' }],
    };
    if (STAGES.indexOf(status) >= STAGES.indexOf('applied') && STAGES.includes(status) && !app.appliedAt) app.appliedAt = now;
    while (t.applications.some((a) => a.id === app.id)) app.id = newId();
    t.applications.push(app);
    return app;
  }

  function applyUpdate(t, id, fields, note) {
    if (note !== undefined && note !== null && typeof note !== 'string') throw new ValidationError('note must be a string');
    const cleanNote = typeof note === 'string' ? note.trim() : '';
    const app = find(t, id);
    const now = nowISO();
    const prevStatus = app.status;
    Object.assign(app, fields);
    if (!Array.isArray(app.history)) app.history = [];
    if (fields.status && fields.status !== prevStatus) {
      app.history.push({ at: now, status: fields.status, note: cleanNote });
      if (fields.status === 'applied' && !app.appliedAt) app.appliedAt = now;
    } else if (cleanNote) {
      app.history.push({ at: now, status: app.status, note: cleanNote });
    }
    app.updatedAt = now;
    return app;
  }

  // patch: editable fields; note: optional history note (also recorded when status is unchanged).
  async function update(id, patch = {}, { note } = {}) {
    const fields = clean(patch);
    return lockT(() => { const t = load(); const app = applyUpdate(t, id, fields, note); save(t); return app; });
  }

  // Undo the last live history entry: mark it undone, restore the previous status,
  // and clear appliedAt if that entry set it.
  async function undo(id) {
    return lockT(() => {
      const t = load();
      const app = find(t, id);
      const live = (app.history ?? []).filter((h) => !h.undone);
      if (live.length < 2) throw new ValidationError('nothing to undo');
      const last = live[live.length - 1];
      const prev = live[live.length - 2];
      last.undone = true;
      app.status = prev.status;
      if (app.appliedAt && app.appliedAt === last.at && last.status === 'applied') app.appliedAt = null;
      app.updatedAt = nowISO();
      save(t);
      return app;
    });
  }

  async function remove(id) {
    return lockT(() => {
      const t = load();
      const app = find(t, id);
      t.applications = t.applications.filter((a) => a.id !== app.id);
      save(t);
      return app;
    });
  }

  // ---- jobs.json (owned by scrape): read-only, plus status-only updates ----
  const loadJobs = () => {
    const j = readJSON(jobsFile, null);
    return j && j.jobs && typeof j.jobs === 'object' ? j : { version: 1, updatedAt: null, jobs: {} };
  };

  function listJobs() {
    const j = loadJobs();
    return Object.values(j.jobs).map(({ description, ...rest }) => rest);
  }

  function getJob(key) {
    const job = loadJobs().jobs[key];
    if (!job) throw new NotFoundError(`job ${key} not found`);
    return job;
  }

  async function setJobStatus(key, status) {
    if (!JOB_STATUSES.includes(status)) throw new ValidationError(`job status must be one of ${JOB_STATUSES.join(', ')}`);
    return lockJ(() => {
      const j = readJSON(jobsFile, null); // re-read inside the lock (scrape may have merged meanwhile)
      if (!j || !j.jobs || !j.jobs[key]) throw new NotFoundError(`job ${key} not found`);
      j.jobs[key].status = status; // touch only this field
      writeJSON(jobsFile, j);
      return j.jobs[key];
    });
  }

  // Full posting text pasted or fetched from the tracker, so /tailor and /rank have something to work with.
  async function setJobDescription(key, text, { via = 'pasted' } = {}) {
    if (typeof text !== 'string') throw new ValidationError('description must be text');
    const clean = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
    if (clean.length < 50) throw new ValidationError('description is too short (paste the full job description)');
    if (clean.length > 50000) throw new ValidationError('description is too long (max 50,000 characters)');
    return lockJ(() => {
      const j = readJSON(jobsFile, null);
      if (!j || !j.jobs || !j.jobs[key]) throw new NotFoundError(`job ${key} not found`);
      j.jobs[key].description = clean;
      j.jobs[key].descriptionVia = via;
      j.jobs[key].descriptionAt = new Date().toISOString();
      writeJSON(jobsFile, j);
      const { description, ...rest } = j.jobs[key];
      return { ...rest, descLen: clean.length };
    });
  }

  // Adds the application (tracker lock; jobKey conflict re-checked inside it), then marks the job tracked (jobs lock).
  async function trackJob(key, overrides = {}) {
    const job = getJob(key);
    const channel = job.source === 'linkedin' ? 'linkedin' : job.source === 'manual' ? 'other' : 'ats';
    const app = await add({
      company: job.company || 'Unknown', role: job.title || 'Untitled', jobKey: key,
      track: job.track ?? null, url: safeUrl(job.applyUrl) ?? safeUrl(job.url), location: job.location ?? null,
      workMode: WORK_MODES.includes(job.workMode) ? job.workMode : 'unknown', channel,
      fit: job.rank && Number.isFinite(job.rank.score) ? { score: job.rank.score, verdict: job.rank.verdict ?? null } : null,
      salary: formatSalary(job.salary), status: 'saved', ...overrides,
    }, { note: 'Tracked from jobs inbox' });
    await setJobStatus(key, 'tracked');
    return app;
  }

  return { trackerFile, jobsFile, root, load, list, get, add, addOrUpdate, update, undo, remove, loadJobs, listJobs, getJob, setJobStatus, setJobDescription, trackJob };
}

const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);

export function formatSalary(s) {
  if (!s || typeof s !== 'object' || (!s.min && !s.max)) return null;
  const fmt = (n) => (n >= 100000 && s.currency === 'INR' ? `${+(n / 100000).toFixed(1)}L` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const range = s.min && s.max && s.min !== s.max ? `${fmt(s.min)}-${fmt(s.max)}` : fmt(s.max || s.min);
  return `${s.currency ?? ''} ${range}${s.unit && s.unit !== 'year' ? `/${s.unit}` : ''}`.trim();
}

let defaultStore;
export const store = () => (defaultStore ??= createStore());
