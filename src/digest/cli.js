// CLI: gaj digest | gaj schedule install|remove|status
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, out, fail } from '../lib/args.js';
import { paths } from '../lib/paths.js';
import { runDigest, markState } from './digest.js';
import * as schedule from './schedule.js';

const rel = (f) => (f.startsWith(paths.root + path.sep) ? path.relative(paths.root, f) : f);

function notify(n) {
  if (process.platform !== 'darwin') return;
  const msg = n ? `${n} new job${n === 1 ? '' : 's'} in your digest` : 'No new matching jobs today';
  // Args array, no shell; the message contains only digits and fixed text.
  spawnSync('osascript', ['-e', `display notification "${msg}" with title "get-a-job"`], { stdio: 'ignore' });
}

async function digest(argv) {
  const a = parse(argv, { since: { type: 'string' }, hours: { type: 'string' }, mark: { type: 'boolean' }, 'mark-only': { type: 'boolean' }, at: { type: 'string' }, out: { type: 'string' }, notify: { type: 'boolean' } }, { allowPositionals: false });
  if (a.help) return out(null, false, commands.digest.usage);
  if (a.at !== undefined && !a['mark-only']) fail('--at only works with --mark-only');
  if (a['mark-only']) {
    // Mark exactly what was shown: `digest --json` → generatedAt → `digest --mark-only --at <generatedAt>`. Writes no file.
    if (a.mark || a.out || a.since || a.hours || a.notify) fail('--mark-only takes only --at (and --json)');
    let at = new Date();
    if (a.at !== undefined) {
      at = new Date(a.at);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(a.at) || Number.isNaN(at.getTime())) fail('--at must be an ISO date-time, e.g. the generatedAt from digest --json');
      if (at.getTime() > Date.now() + 60_000) fail('--at is in the future');
    }
    const st = markState(paths.root, at.toISOString());
    return out({ ...st, marked: true }, a.json, () => `Marked the latest digest at ${st.lastDigestAt}`);
  }
  let res;
  try {
    res = runDigest(paths.root, { since: a.since, hours: a.hours, out: a.out, mark: !!a.mark });
  } catch (err) { fail(err.message); }
  if (a.notify) notify(res.digest.counts.total);
  const c = res.digest.counts;
  out({ ...res.digest, file: rel(res.file), marked: !!a.mark }, a.json, () => [
    c.total ? `${c.total} new matching job${c.total === 1 ? '' : 's'} since ${res.digest.since}: ${c.green} eligible, ${c.unknown} unknown, ${c.orange} to check.`
      : `No new matching jobs since ${res.digest.since}. Try /discover or widen your track titles.`,
    `Wrote ${rel(res.file)}${a.mark ? ' (marked as the latest digest)' : ''}`,
  ].join('\n'));
}

function printPlan(plan, verb) {
  const lines = [];
  if (plan.manual) lines.push(plan.manual);
  for (const f of plan.files ?? []) {
    if (typeof f === 'string') lines.push(`${verb} ${f}`);
    else lines.push(`${verb} ${f.path}:`, '----', f.content.trimEnd(), '----');
  }
  for (const [cmd, args] of plan.commands ?? []) lines.push(`Run: ${cmd} ${args.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
  return lines.join('\n');
}

async function scheduleCmd(argv) {
  const [sub, ...rest] = argv;
  const a = parse(rest, { time: { type: 'string' }, yes: { type: 'boolean' }, notify: { type: 'boolean' } }, { allowPositionals: false });
  const e = schedule.env({ root: paths.root });
  if (sub === 'install') {
    let plan;
    try { plan = schedule.planInstall(e, { time: a.time ?? '08:00', notify: !!a.notify }); } catch (err) { fail(err.message); }
    if (plan.kind === 'manual') return out(plan, a.json, () => `Automatic install isn't supported here. Do this yourself:\n${plan.manual}`);
    if (!a.yes) {
      return out({ ...plan, dryRun: true }, a.json, () => `${printPlan(plan, 'Would write')}\n\nNothing was changed. Re-run with --yes to install.`);
    }
    const r = schedule.install(e, { time: a.time ?? '08:00', notify: !!a.notify });
    if (!r.installed) fail(`wrote ${r.files.map((f) => f.path).join(', ')} but loading it failed: ${(r.results.at(-1)?.stderr || '').trim()}`);
    return out({ installed: true, files: r.files.map((f) => f.path) }, a.json, () => `Installed. Runs daily at ${schedule.parseTime(a.time ?? '08:00').text}: scrape (free sources) then digest. Logs: data/logs/. Check with: gaj schedule status`);
  }
  if (sub === 'remove') {
    const plan = schedule.planRemove(e);
    if (plan.kind === 'manual') return out(plan, a.json, () => `Remove it yourself:\n${plan.manual}`);
    if (!a.yes) return out({ ...plan, dryRun: true }, a.json, () => `${printPlan(plan, 'Would delete')}\n\nNothing was changed. Re-run with --yes to remove.`);
    const r = schedule.remove(e);
    return out({ removed: r.removed }, a.json, () => (r.removed ? 'Removed the daily schedule.' : 'No schedule was installed.') + (r.manual ? `\n${r.manual}` : ''));
  }
  if (sub === 'status') {
    const s = schedule.status(e);
    return out(s, a.json, () => [
      s.installed ? `Installed (${s.file})${s.loaded === false ? ', but not loaded' : ''}. Daily at ${s.time ?? '?'}; next run ${s.nextRunAt ?? 'unknown'}.`
        : `Not installed.${s.supported ? ` Install with: ${s.installCommand}` : ' Run "gaj schedule install" for instructions.'}`,
      ...(s.warning ? [`Warning: ${s.warning}`] : []),
      `Last log: ${s.lastLog ? `${s.lastLog.file} (${s.lastLog.modifiedAt})` : 'none'}`,
      `Last digest: ${s.lastDigestDate ?? 'none'}${s.lastDigestAt ? ` (marked ${s.lastDigestAt})` : ''}`,
    ].join('\n'));
  }
  fail(`usage: ${commands.schedule.usage}`);
}

export const commands = {
  digest: {
    summary: 'Write a digest of jobs first seen since the last one',
    usage: 'gaj digest [--since ISO | --hours N] [--mark] [--out path] [--notify] [--json] | gaj digest --mark-only [--at ISO] [--json]',
    run: digest,
  },
  schedule: {
    summary: 'Install, remove or check the daily scrape + digest',
    usage: 'gaj schedule install [--time HH:MM] [--notify] [--yes] | schedule remove [--yes] | schedule status [--json]',
    run: scheduleCmd,
  },
};
