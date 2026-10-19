// Daily digest: jobs first seen since the last digest, grouped by track, as markdown + structured data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJSON, writeJSON, nowISO } from '../lib/store.js';

const OPEN = new Set(['new', 'ranked']);
const FIT = { high: 0, medium: 1, low: 2 };
const DAY = 86400000;

/** Data-root-relative file locations (the tracker passes its own root, e.g. in --demo). */
export const digestPaths = (root) => ({
  jobs: path.join(root, 'data', 'jobs.json'),
  prefs: path.join(root, 'profile', 'preferences.json'),
  state: path.join(root, 'data', 'digest-state.json'),
  dir: path.join(root, 'data', 'digests'),
  logs: path.join(root, 'data', 'logs'),
});

export function loadState(root) {
  const s = readJSON(digestPaths(root).state, null);
  return { lastDigestAt: s && typeof s.lastDigestAt === 'string' ? s.lastDigestAt : null };
}

export function markState(root, at = nowISO()) {
  const file = digestPaths(root).state;
  const cur = readJSON(file, null) ?? {};
  writeJSON(file, { ...cur, lastDigestAt: at });
  return { lastDigestAt: at };
}

/** Resolve the `since` cut-off: --since, else --hours, else lastDigestAt, else 24h ago. */
export function resolveSince({ since, hours, state, now = Date.now() } = {}) {
  if (since) {
    const t = new Date(since);
    if (Number.isNaN(t.getTime())) throw new Error('--since must be an ISO date');
    return t.toISOString();
  }
  if (hours !== undefined && hours !== null) {
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) throw new Error('--hours must be a positive number');
    return new Date(now - n * 3600000).toISOString();
  }
  if (state?.lastDigestAt) return state.lastDigestAt;
  return new Date(now - DAY).toISOString();
}

/** Open jobs (new/ranked) first seen strictly after `since` (and not after `until`, when given). */
export function selectJobs(jobsStore, since, until = Infinity) {
  const t = new Date(since).getTime();
  const u = until === Infinity ? Infinity : new Date(until).getTime();
  return Object.values(jobsStore?.jobs ?? {}).filter((j) => {
    if (!OPEN.has(j.status) || !j.firstSeen) return false;
    const f = new Date(j.firstSeen).getTime();
    return f > t && f <= u;
  });
}

const byQuality = (a, b) => (b.rank?.score ?? -1) - (a.rank?.score ?? -1)
  || (FIT[a.quickFit] ?? 3) - (FIT[b.quickFit] ?? 3)
  || String(b.firstSeen).localeCompare(String(a.firstSeen));

/** Structured digest: per track, green then unknown listed; orange summarised as count + top reasons. */
export function buildDigest(jobs, { since, now = Date.now(), tracks = [] } = {}) {
  const order = tracks.map((t) => t.id);
  const names = Object.fromEntries(tracks.map((t) => [t.id, t.name ?? t.id]));
  const groups = new Map();
  for (const j of jobs) {
    const id = j.track ?? null;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(j);
  }
  const ids = [...groups.keys()].sort((a, b) => {
    const ia = a === null ? 1e9 : order.indexOf(a) === -1 ? 1e6 : order.indexOf(a);
    const ib = b === null ? 1e9 : order.indexOf(b) === -1 ? 1e6 : order.indexOf(b);
    return ia - ib || String(a).localeCompare(String(b));
  });
  const view = (j) => ({
    key: j.key, title: j.title, company: j.company, location: j.location ?? null, workMode: j.workMode ?? null,
    eligibility: j.eligibility ?? 'unknown', eligibilityReason: j.eligibilityReason ?? null,
    score: j.rank?.score ?? null, verdict: j.rank?.verdict ?? null, quickFit: j.quickFit ?? null,
    source: j.source ?? null, via: j.via ?? null, url: j.applyUrl || j.url || null,
    postedAt: j.postedAt ?? null, firstSeen: j.firstSeen,
  });
  const out = ids.map((id) => {
    const list = groups.get(id);
    const green = list.filter((j) => j.eligibility === 'green').sort(byQuality).map(view);
    const unknown = list.filter((j) => j.eligibility !== 'green' && j.eligibility !== 'orange').sort(byQuality).map(view);
    const orange = list.filter((j) => j.eligibility === 'orange');
    const reasons = new Map();
    for (const j of orange) { const r = j.eligibilityReason || 'unspecified'; reasons.set(r, (reasons.get(r) ?? 0) + 1); }
    return {
      id, name: id === null ? 'No track' : names[id] ?? id, green, unknown,
      orange: { count: orange.length, reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => ({ reason, count })) },
    };
  });
  const counts = {
    total: jobs.length,
    green: jobs.filter((j) => j.eligibility === 'green').length,
    orange: jobs.filter((j) => j.eligibility === 'orange').length,
  };
  counts.unknown = counts.total - counts.green - counts.orange;
  return { since, generatedAt: new Date(now).toISOString(), counts, tracks: out };
}

const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const human = (iso) => { const d = new Date(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const age = (iso, now) => {
  if (!iso) return null;
  const d = Math.floor((now - new Date(iso).getTime()) / DAY);
  return d <= 0 ? 'today' : `${d}d`;
};
// Markdown-safe inline text (job data is untrusted: neutralise markup characters).
const md = (s) => String(s ?? '').replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\/[^\s()<>]+$/i.test(u) ? u : null);

function line(j, mark, now) {
  const bits = [`**${md(j.title)}**`, md(j.company)];
  if (j.location) bits.push(md(j.location));
  if (j.workMode && j.workMode !== 'unknown' && !String(j.location ?? '').toLowerCase().includes(j.workMode)) bits.push(j.workMode);
  if (j.score !== null) bits.push(`${j.score} ${j.verdict ?? ''}`.trim());
  else if (j.quickFit) bits.push(`fit ${j.quickFit}`);
  const a = age(j.postedAt ?? j.firstSeen, now);
  if (a) bits.push(a);
  const via = j.via || j.source;
  if (via) bits.push(`via ${md(via)}`);
  const url = safeUrl(j.url);
  return `- ${mark} ${bits.join(' · ')}${url ? ` · [posting](${url})` : ''}`;
}

export function renderMarkdown(d, { now = Date.now() } = {}) {
  const gen = new Date(d.generatedAt);
  const c = d.counts;
  const meta = { since: d.since, generatedAt: d.generatedAt, counts: c };
  const lines = [`<!-- gaj-digest ${JSON.stringify(meta)} -->`, `# Job digest · ${localDate(gen)}`, ''];
  if (!c.total) {
    lines.push(`_No new matching jobs since ${human(d.since)}._`, '',
      'Ideas: run /discover to add companies, widen your track titles or locations in Settings, or raise `maxAgeDays`.', '');
    return lines.join('\n');
  }
  lines.push(`_${c.total} new matching job${c.total === 1 ? '' : 's'} since ${human(d.since)}: ${c.green} eligible, ${c.unknown} unknown, ${c.orange} to check._`, '');
  for (const t of d.tracks) {
    const n = t.green.length + t.unknown.length + t.orange.count;
    lines.push(`## ${md(t.name)}${t.id ? ` (${t.id})` : ''} · ${n}`, '');
    for (const j of t.green) lines.push(line(j, '🟢', now));
    for (const j of t.unknown) lines.push(line(j, '⚪', now));
    if (t.orange.count) {
      const r = t.orange.reasons.map((x) => `${md(x.reason)} (${x.count})`).join(', ');
      lines.push(`- 🟠 _${t.orange.count} more to check: ${r}_`);
    }
    lines.push('');
  }
  lines.push('Next: ask Claude to /rank the new jobs, then /tailor the best ones.', '');
  return lines.join('\n');
}

/** Parse the machine-readable header written by renderMarkdown. */
export function parseDigestMeta(text) {
  const m = /^<!-- gaj-digest (\{.*\}) -->/.exec(String(text ?? ''));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** data/digests/<YYYY-MM-DD>.md, or -HHMM / -HHMMSS suffix when taken. */
export function digestFile(root, now = new Date()) {
  const dir = digestPaths(root).dir;
  const d = new Date(now);
  const base = localDate(d);
  for (const name of [base, `${base}-${pad2(d.getHours())}${pad2(d.getMinutes())}`, `${base}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`]) {
    const f = path.join(dir, `${name}.md`);
    if (!fs.existsSync(f)) return f;
  }
  return path.join(dir, `${base}-${d.getTime()}.md`);
}

/** Newest digest file: {date, file, counts} or null. */
export function latestDigest(root) {
  const dir = digestPaths(root).dir;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.md$/.test(f)); } catch { return null; }
  if (!files.length) return null;
  const withTime = files.map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  const file = path.join(dir, withTime[0].f);
  const text = fs.readFileSync(file, 'utf8');
  const meta = parseDigestMeta(text);
  return { date: withTime[0].f.slice(0, 10), file, text, counts: meta?.counts ?? null, generatedAt: meta?.generatedAt ?? null };
}

// --out may only point inside data/ or the OS temp dir.
function real(p) {
  let dir = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(dir)) { rest.unshift(path.basename(dir)); const up = path.dirname(dir); if (up === dir) return path.resolve(p); dir = up; }
  return path.join(fs.realpathSync(dir), ...rest);
}
export function isAllowedDigestOut(root, file) {
  const f = real(file);
  return [path.join(root, 'data'), os.tmpdir()].some((base) => {
    const rel = path.relative(real(base), f);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

/** Full run: select, render, write. Returns {digest, markdown, file}. */
export function runDigest(root, { since, hours, out, mark = false, now = Date.now() } = {}) {
  const p = digestPaths(root);
  const state = loadState(root);
  const sinceIso = resolveSince({ since, hours, state, now });
  const store = readJSON(p.jobs, null) ?? { jobs: {} };
  const prefs = readJSON(p.prefs, null);
  const digest = buildDigest(selectJobs(store, sinceIso, now), { since: sinceIso, now, tracks: prefs?.tracks ?? [] });
  const markdown = renderMarkdown(digest, { now });
  const file = out ? path.resolve(out) : digestFile(root, new Date(now));
  if (out && !isAllowedDigestOut(root, file)) throw new Error('--out must be inside data/ or the OS temp dir');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown);
  if (mark) markState(root, new Date(now).toISOString());
  return { digest, markdown, file };
}
