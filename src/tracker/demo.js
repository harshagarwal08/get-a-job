// --demo: copy fixture tracker/jobs into a temp root, shifting all dates so the data looks current.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDigest } from '../digest/digest.js';

export const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'tracker');

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Recursively shift ISO timestamps and YYYY-MM-DD dates by `ms`.
export function shiftDates(value, ms) {
  if (Array.isArray(value)) return value.map((v) => shiftDates(v, ms));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftDates(v, ms)]));
  }
  if (typeof value === 'string') {
    if (ISO_RE.test(value)) return new Date(new Date(value).getTime() + ms).toISOString();
    if (DATE_RE.test(value)) return new Date(new Date(`${value}T00:00:00Z`).getTime() + ms).toISOString().slice(0, 10);
  }
  return value;
}

// Returns the temp root. Fixture "now" is tracker.json's updatedAt; dates shift by whole days to keep weekdays sane.
export function prepareDemoRoot({ now = Date.now() } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gaj-demo-'));
  const tracker = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'tracker.json'), 'utf8'));
  const jobs = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'jobs.json'), 'utf8'));
  const anchor = new Date(tracker.updatedAt).getTime();
  const days = Math.round((now - anchor) / 86400000);
  const ms = days * 86400000;
  fs.mkdirSync(path.join(root, 'data', 'applications'), { recursive: true });
  fs.mkdirSync(path.join(root, 'profile'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'tracker.json'), JSON.stringify(shiftDates(tracker, ms), null, 2));
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), JSON.stringify(shiftDates(jobs, ms), null, 2));
  const prefs = path.join(FIXTURE_DIR, 'preferences.json');
  if (fs.existsSync(prefs)) fs.copyFileSync(prefs, path.join(root, 'profile', 'preferences.json'));
  // Digest demo: last digest marked 2 days before the fixture "now", covering the 3 days before that.
  const statePath = path.join(FIXTURE_DIR, 'digest-state.json');
  if (fs.existsSync(statePath)) {
    const state = shiftDates(JSON.parse(fs.readFileSync(statePath, 'utf8')), ms);
    fs.writeFileSync(path.join(root, 'data', 'digest-state.json'), JSON.stringify(state, null, 2));
    if (state.lastDigestAt) {
      const at = new Date(state.lastDigestAt).getTime();
      runDigest(root, { since: new Date(at - 3 * 86400000).toISOString(), now: at });
    }
  }
  return root;
}

// Remove the temp demo root when the process ends (exit, Ctrl+C, kill).
export function cleanupOnExit(root) {
  const rm = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } };
  process.once('exit', rm);
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { rm(); process.exit(0); });
  return rm;
}
