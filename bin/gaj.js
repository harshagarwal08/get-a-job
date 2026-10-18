#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/lib/paths.js';
import { getKey, KEYS } from '../src/lib/env.js';

const MODULES = {
  scrape: '../src/scrape/cli.js',
  resume: '../src/resume/cli.js',
  tracker: '../src/tracker/cli.js',
};

const ROUTES = {
  scrape: 'scrape', jobs: 'scrape', job: 'scrape', 'jobs:set': 'scrape', 'company:check': 'scrape', fetch: 'scrape',
  'company:detect': 'scrape', companies: 'scrape', 'companies:add': 'scrape', discover: 'scrape', 'jobs:import': 'scrape', 'careers:check': 'scrape',
  render: 'resume', verify: 'resume',
  tracker: 'tracker', track: 'tracker', export: 'tracker',
};

async function load(mod) {
  return (await import(MODULES[mod])).commands;
}

const rel = (file) => path.relative(paths.root, file) || '.';
const tilde = (p) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);

/** Structural checks on preferences.json; returns a list of problems. */
function validatePreferences(prefs, regions = {}) {
  const problems = [];
  const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!Array.isArray(prefs.tracks) || prefs.tracks.length === 0) problems.push('tracks: need at least one track');
  for (const [i, t] of (prefs.tracks ?? []).entries()) {
    if (!t.id || !/^[a-z0-9-]+$/.test(t.id)) problems.push(`tracks[${i}].id: lowercase letters, digits, dashes`);
    if (!isStrArr(t.titles) || t.titles.length === 0) problems.push(`tracks[${i}].titles: need at least one title`);
  }
  const loc = prefs.location ?? {};
  if (!loc.based) problems.push('location.based: missing');
  if (!isStrArr(loc.acceptableLocations)) problems.push('location.acceptableLocations: must be a list of strings');
  if (!isStrArr(loc.workModes) || loc.workModes.some((m) => !['remote', 'hybrid', 'onsite'].includes(m))) problems.push('location.workModes: subset of remote, hybrid, onsite');
  if (!isStrArr(loc.remoteScope)) problems.push('location.remoteScope: must be a list of strings');
  if (typeof loc.needsSponsorship !== 'boolean') problems.push('location.needsSponsorship: true or false');
  const comp = prefs.compensation ?? {};
  if (!comp.currency || typeof comp.min !== 'number') problems.push('compensation: need currency and numeric min');
  else if (comp.min === 0) problems.push('compensation.min is 0: set a real floor so comp gates work');
  if (!['year', 'month', 'hour'].includes(comp.unit)) problems.push('compensation.unit: year, month or hour');
  const scopes = ['global', ...Object.keys(regions)];
  for (const s of loc.remoteScope ?? []) {
    if (!scopes.includes(String(s).toLowerCase())) problems.push(`location.remoteScope: "${s}" is not one of ${scopes.join(', ')}`);
  }
  const src = prefs.sources ?? {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'maxAgeDays') { if (!Number.isInteger(v) || v < 0) problems.push('sources.maxAgeDays: non-negative integer'); }
    else if (v && typeof v === 'object') { if (typeof v.enabled !== 'boolean') problems.push(`sources.${k}.enabled: true or false`); }
    else if (typeof v !== 'boolean') problems.push(`sources.${k}: true or false`);
  }
  if (src.jobspy?.enabled) {
    const uv = spawnSync('uv', ['--version'], { stdio: 'ignore' });
    if (uv.error || uv.status !== 0) problems.push('sources.jobspy is enabled but uv is not installed (brew install uv, or see docs/SETUP.md)');
  }
  const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const caps = [
    ['googleJobs', 'maxQueries', 1, 20], ['googleJobs', 'maxRequestsPerMonth', 1, 10000],
    ['apify', 'maxItems', 1, 500], ['apify', 'maxChargeUsd', 0.01, 5], ['apify', 'maxUsdPerMonth', 0.01, 1000],
    ['jobspy', 'resultsWanted', 1, 100], ['jobspy', 'maxQueries', 1, 5],
  ];
  for (const [k, f, lo, hi] of caps) {
    if (src[k] && src[k][f] !== undefined && !num(src[k][f], lo, hi)) problems.push(`sources.${k}.${f}: number between ${lo} and ${hi}`);
  }
  if (Array.isArray(src.apify?.actors) && src.apify.actors.length > 3) problems.push('sources.apify.actors: at most 3 actors');
  const providerKeys = { googleJobs: (o) => (o.provider === 'serpapi' ? 'serpapi' : 'jsearch'), apify: () => 'apify' };
  for (const [k, keyOf] of Object.entries(providerKeys)) {
    if (src[k]?.enabled && !getKey(keyOf(src[k]))) problems.push(`sources.${k} is enabled but ${KEYS[keyOf(src[k])]} is not set (add it to .env)`);
  }
  return problems;
}

async function doctor(argv) {
  const checks = [];
  const major = Number(process.versions.node.split('.')[0]);
  checks.push([major >= 20, `Node ${process.versions.node} (need >= 20)`]);
  try {
    const { launchBrowser } = await import('../src/resume/browser.js');
    const browser = await launchBrowser();
    const exe = browser.process()?.spawnfile ?? 'unknown';
    await browser.close();
    checks.push([true, `Chrome launches: ${tilde(exe)}`]);
  } catch (e) {
    checks.push([false, `Chrome failed to launch (run npm install, or set PUPPETEER_EXECUTABLE_PATH): ${e.message.split('\n')[0]}`]);
  }
  for (const [file, hint] of [
    [paths.preferences, 'run /onboard'],
    [paths.profile, 'run /onboard'],
    [paths.resume, 'run /onboard'],
    [paths.companies, 'cp config/companies.example.json config/companies.json'],
  ]) checks.push([fs.existsSync(file), `${rel(file)}${fs.existsSync(file) ? '' : ` missing (${hint})`}`]);
  if (argv.includes('--validate') && fs.existsSync(paths.preferences)) {
    let problems;
    const { REGIONS } = await import('../src/scrape/geo.js');
    try { problems = validatePreferences(JSON.parse(fs.readFileSync(paths.preferences, 'utf8')), REGIONS); }
    catch (e) { problems = [`not valid JSON: ${e.message}`]; }
    checks.push([problems.length === 0, `preferences.json ${problems.length ? 'has problems' : 'is valid'}`]);
    for (const p of problems) checks.push([false, `  ${p}`]);
  }
  for (const [ok, msg] of checks) console.log(`${ok ? '✓' : '✗'} ${msg}`);
  process.exit(checks.every(([ok]) => ok) ? 0 : 1);
}

async function help() {
  console.log('gaj: get-a-job CLI\n\nUsage: gaj <command> [options]\n');
  for (const mod of Object.keys(MODULES)) {
    try {
      for (const [name, c] of Object.entries(await load(mod))) console.log(`  ${name.padEnd(14)} ${c.summary}`);
    } catch { /* module not built yet */ }
  }
  console.log(`  ${'doctor'.padEnd(14)} Check environment and profile files (--validate checks preferences.json)`);
}

const [cmd, ...argv] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') await help();
else if (cmd === 'doctor') await doctor(argv);
else if (!ROUTES[cmd]) { console.error(`Unknown command: ${cmd}. Run "gaj help".`); process.exit(1); }
else {
  const command = (await load(ROUTES[cmd]))[cmd];
  if (!command) { console.error(`Command "${cmd}" not implemented in ${ROUTES[cmd]} module.`); process.exit(1); }
  try {
    await command.run(argv);
  } catch (err) {
    console.error(`error: ${err.message}`);
    if (process.env.GAJ_DEBUG) console.error(err.stack);
    process.exit(1);
  }
}
