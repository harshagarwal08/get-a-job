// Recently funded startups: a local lead list (data/funded.json) for /funded and /cold-dm.
// Startups hire soon after a round, often before roles are posted, so these are
// outreach targets as well as companies to add to config/companies.json.
import path from 'node:path';
import { paths, slugify } from '../lib/paths.js';
import { readJSON, writeJSON, withLock, nowISO } from '../lib/store.js';
import { httpUrl } from '../scrape/job.js';

export const FUNDED_FILE = path.join(paths.dataDir, 'funded.json');
export const ROUNDS = ['pre-seed', 'seed', 'pre-series-a', 'series-a', 'series-b', 'series-c', 'series-d+', 'growth', 'debt', 'grant', 'unknown'];
// new: just found · added: in config/companies.json · contacted: cold DM sent · replied · skipped
export const FUNDED_STATUSES = ['new', 'added', 'contacted', 'replied', 'skipped'];

const MAX = { name: 120, text: 200, note: 500, investors: 10 };
// Untrusted web text: keep a plain, single-line subset.
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>`$\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '')) && !Number.isNaN(Date.parse(s)) ? String(s) : null);

/** Normalise one round from /funded's research. Returns {record} or {error}. */
export function normalizeRound(raw, now = new Date()) {
  const name = clean(raw?.name ?? raw?.company, MAX.name);
  if (!name) return { error: 'missing name' };
  const announcedAt = isoDate(raw.announcedAt);
  if (!announcedAt) return { error: `${name}: announcedAt must be YYYY-MM-DD` };
  if (Date.parse(announcedAt) > now.getTime() + 86400000) return { error: `${name}: announcedAt is in the future` };
  const sourceUrl = httpUrl(raw.sourceUrl);
  if (!sourceUrl) return { error: `${name}: sourceUrl must be an http(s) URL (every round needs a source)` };
  const round = ROUNDS.includes(String(raw.round ?? '').toLowerCase()) ? String(raw.round).toLowerCase() : 'unknown';
  const amountUsd = Number.isFinite(Number(raw.amountUsd)) && Number(raw.amountUsd) > 0 ? Math.round(Number(raw.amountUsd)) : null;
  return {
    record: {
      id: slugify(name),
      name,
      round,
      amountUsd,
      // amounts are the one field where "$" is expected; everything else risky is still stripped
      amountText: clean(String(raw.amountText ?? '').replace(/\$/g, 'USD '), 40).replace(/USD (?=\d)/g, '$') || null,
      announcedAt,
      sector: clean(raw.sector, MAX.text) || null,
      city: clean(raw.city, MAX.text) || null,
      country: clean(raw.country, 60) || null,
      investors: (Array.isArray(raw.investors) ? raw.investors : []).map((i) => clean(i, MAX.name)).filter(Boolean).slice(0, MAX.investors),
      website: httpUrl(raw.website),
      sourceUrl,
    },
  };
}

const load = () => readJSON(FUNDED_FILE, () => ({ version: 1, lastSearchAt: null, companies: [] }));
export const DEFAULT_EVERY_DAYS = 7;

/**
 * Is a /funded search due? /scrape runs one when the last search is older than
 * `sources.funded.everyDays` (default 7). Off only when `sources.funded.enabled` is false.
 * @returns {{enabled: boolean, everyDays: number, lastSearchAt: string|null, daysSince: number|null, due: boolean, newLeads: number}}
 */
export function fundedStatus(prefs, now = new Date()) {
  const cfg = prefs?.sources?.funded ?? {};
  const enabled = cfg.enabled !== false;
  const everyDays = Number.isInteger(cfg.everyDays) && cfg.everyDays > 0 ? cfg.everyDays : DEFAULT_EVERY_DAYS;
  const db = load();
  const last = db.lastSearchAt ? Date.parse(db.lastSearchAt) : NaN;
  const daysSince = Number.isNaN(last) ? null : Math.floor((now.getTime() - last) / 86400000);
  return { enabled, everyDays, lastSearchAt: db.lastSearchAt ?? null, daysSince, due: enabled && (daysSince === null || daysSince >= everyDays),
    newLeads: db.companies.filter((c) => c.status === 'new').length };
}

/**
 * Merge rounds into data/funded.json and stamp lastSearchAt. Same company → keep the newest round, keep status/notes.
 * @returns {Promise<{added: string[], updated: string[], unchanged: string[], errors: string[]}>}
 */
export async function addRounds(rounds, { now = new Date() } = {}) {
  const res = { added: [], updated: [], unchanged: [], errors: [] };
  await withLock(FUNDED_FILE, async () => {
    const db = load();
    const byId = new Map(db.companies.map((c) => [c.id, c]));
    for (const raw of rounds) {
      const { record, error } = normalizeRound(raw, now);
      if (error) { res.errors.push(error); continue; }
      const prev = byId.get(record.id);
      if (!prev) {
        byId.set(record.id, { ...record, status: 'new', notes: [], firstSeenAt: nowISO() });
        res.added.push(record.id);
      } else if (record.announcedAt > prev.announcedAt || (record.announcedAt === prev.announcedAt && record.round !== prev.round)) {
        byId.set(record.id, { ...prev, ...record, investors: record.investors.length ? record.investors : prev.investors });
        res.updated.push(record.id);
      } else res.unchanged.push(record.id);
    }
    // Any funded:add (even an empty array) records that a search ran.
    writeJSON(FUNDED_FILE, { version: 1, lastSearchAt: now.toISOString(), companies: [...byId.values()] });
  });
  return res;
}

/** List funded companies, newest round first. */
export function listFunded({ days, status, now = new Date() } = {}) {
  const cutoff = days != null ? new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10) : null;
  return load().companies
    .filter((c) => (!cutoff || c.announcedAt >= cutoff) && (!status || c.status === status))
    .sort((a, b) => b.announcedAt.localeCompare(a.announcedAt) || a.name.localeCompare(b.name));
}

/** Update one company's status and/or add a note. */
export async function setFunded(id, { status, note } = {}) {
  if (status && !FUNDED_STATUSES.includes(status)) throw new Error(`status must be one of ${FUNDED_STATUSES.join(', ')}`);
  let found;
  await withLock(FUNDED_FILE, async () => {
    const db = load();
    found = db.companies.find((c) => c.id === id || c.id === slugify(id));
    if (!found) return;
    if (status) found.status = status;
    if (note) found.notes = [...(found.notes ?? []), { at: nowISO(), text: clean(note, MAX.note) }];
    found.updatedAt = nowISO();
    writeJSON(FUNDED_FILE, db);
  });
  if (!found) throw new Error(`no funded company "${id}" (see gaj funded)`);
  return found;
}
