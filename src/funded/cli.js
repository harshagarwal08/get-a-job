// CLI: gaj funded | funded:add | funded:set
import fs from 'node:fs';
import { parse, out, fail } from '../lib/args.js';
import { importPathAllowed } from '../scrape/importer.js';
import { addRounds, listFunded, setFunded, fundedStatus, FUNDED_STATUSES } from './funded.js';
import { readJSON } from '../lib/store.js';
import { paths } from '../lib/paths.js';

const LIST_USAGE = `gaj funded [--days N] [--status ${FUNDED_STATUSES.join('|')}] [--json]`;
const ADD_USAGE = 'gaj funded:add <file.json> [--json]   (file under data/ or the OS temp dir: array of {name, round, amountUsd?, amountText?, announcedAt: YYYY-MM-DD, sector?, city?, investors?, website?, sourceUrl})';
const SET_USAGE = `gaj funded:set <id> [--status ${FUNDED_STATUSES.join('|')}] [--note "..."] [--json]`;

const money = (c) => c.amountText ?? (c.amountUsd ? `$${(c.amountUsd / 1e6).toFixed(c.amountUsd < 1e7 ? 1 : 0)}M` : '?');

async function list(argv) {
  const a = parse(argv, { days: { type: 'string' }, status: { type: 'string' } }, { allowPositionals: false });
  if (a.help) return console.log(LIST_USAGE);
  const days = a.days != null ? Number(a.days) : undefined;
  if (days != null && !(Number.isInteger(days) && days > 0)) fail('--days must be a positive integer');
  if (a.status && !FUNDED_STATUSES.includes(a.status)) fail(`--status must be one of ${FUNDED_STATUSES.join(', ')}`);
  const rows = listFunded({ days, status: a.status });
  const search = fundedStatus(readJSON(paths.preferences, {}));
  const when = search.lastSearchAt ? `Last search ${search.daysSince} day(s) ago${search.due ? ' (due: run /funded)' : ''}.` : 'Never searched: run /funded.';
  out({ count: rows.length, search, companies: rows }, a.json, () => {
    if (!rows.length) return `No funded companies yet. ${when}`;
    const lines = ['| date | company | round | amount | sector | city | status | id |', '|---|---|---|---|---|---|---|---|'];
    for (const c of rows) lines.push(`| ${c.announcedAt} | ${c.name} | ${c.round} | ${money(c)} | ${c.sector ?? ''} | ${c.city ?? ''} | ${c.status} | ${c.id} |`);
    return [...lines, '', when].join('\n');
  });
}

async function add(argv) {
  const a = parse(argv);
  if (a.help) return console.log(ADD_USAGE);
  if (!a._[0]) fail(`missing <file.json>\nusage: ${ADD_USAGE}`);
  const allowed = importPathAllowed(a._[0]);
  if (!allowed.ok) fail(allowed.error.replace('jobs:import', 'funded:add'));
  let rounds;
  try { rounds = JSON.parse(fs.readFileSync(allowed.path, 'utf8')); } catch (e) { fail(`not valid JSON: ${e.message}`); }
  if (!Array.isArray(rounds)) fail('file must hold a JSON array of rounds');
  const res = await addRounds(rounds);
  out(res, a.json, (r) => [`Added ${r.added.length}, updated ${r.updated.length}, unchanged ${r.unchanged.length}. Search recorded.`,
    ...r.errors.map((e) => `  ✗ ${e}`)].join('\n'));
  if (res.errors.length && !res.added.length && !res.updated.length) process.exitCode = 1;
}

async function set(argv) {
  const a = parse(argv, { status: { type: 'string' }, note: { type: 'string' } });
  if (a.help) return console.log(SET_USAGE);
  if (!a._[0]) fail(`missing <id>\nusage: ${SET_USAGE}`);
  if (!a.status && !a.note) fail('pass --status and/or --note');
  const c = await setFunded(a._[0], { status: a.status, note: a.note });
  out(c, a.json, `${c.name}: ${c.status}${a.note ? ' (note added)' : ''}`);
}

/** Commands exported to bin/gaj.js (see docs/CONTRACTS.md). */
export const commands = {
  funded: { summary: 'List recently funded startups found by /funded (newest first)', usage: LIST_USAGE, run: list },
  'funded:add': { summary: 'Merge funding rounds from a JSON file into data/funded.json', usage: ADD_USAGE, run: add },
  'funded:set': { summary: 'Set a funded company status (new|added|contacted|replied|skipped) or add a note', usage: SET_USAGE, run: set },
};
