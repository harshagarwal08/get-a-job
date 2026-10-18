#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../src/lib/paths.js';

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
    const { validatePreferences } = await import('../src/lib/preferences.js');
    try {
      const { errors, warnings } = validatePreferences(JSON.parse(fs.readFileSync(paths.preferences, 'utf8')));
      problems = [...errors, ...warnings];
    }
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
