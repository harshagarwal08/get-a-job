import fs from 'node:fs';
import path from 'node:path';

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return typeof fallback === 'function' ? fallback() : fallback;
    throw new Error(`Failed to read ${file}: ${err.message}`);
  }
}

// Atomic write: temp file + rename, so a crash never leaves half-written JSON.
export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const nowISO = () => new Date().toISOString();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding an exclusive lockfile (`<file>.lock`), so separate processes
 * (scheduled scrape, tracker search, CLI imports) don't overwrite each other's writes.
 * Stale locks (older than `staleMs`, or whose pid is gone) are taken over.
 */
export async function withLock(file, fn, { timeoutMs = 120_000, staleMs = 15 * 60_000 } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const { pid, at } = JSON.parse(fs.readFileSync(lock, 'utf8'));
        let alive = true;
        try { process.kill(pid, 0); } catch (e) { alive = e.code === 'EPERM'; }
        stale = !alive || Date.now() - at > staleMs;
      } catch { stale = true; }
      if (stale) { try { fs.unlinkSync(lock); } catch { /* raced */ } continue; }
      if (Date.now() - start > timeoutMs) throw new Error(`${path.basename(file)} is locked by another gaj process; try again shortly`);
      await sleep(200);
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lock); } catch { /* already gone */ }
  }
}
