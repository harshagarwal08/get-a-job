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
