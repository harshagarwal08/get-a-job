import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../lib/paths.js';

/** Resolve symlinks on the nearest existing ancestor (e.g. macOS /var → /private/var). */
function real(p) {
  const abs = path.resolve(p);
  let dir = abs;
  const rest = [];
  while (!fs.existsSync(dir)) {
    rest.unshift(path.basename(dir));
    const up = path.dirname(dir);
    if (up === dir) return abs;
    dir = up;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

const inside = (child, parent) => {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Directories render may write into (CONTRACTS: "Safety rules for CLI writes"). */
export const allowedOutputRoots = () => [paths.dataDir, paths.profileDir, os.tmpdir()];

/** True when `file` resolves inside data/, profile/ or the OS temp dir. */
export const isAllowedOutput = (file) => allowedOutputRoots().some((root) => inside(file, root));

/**
 * Decide the PDF output path. Explicit `out` wins; inputs under examples/ go to the OS temp dir;
 * otherwise next to the input. Throws if the result is outside the allowed roots.
 * @param {string} input resume.md path
 * @param {string} [out]
 * @returns {string} absolute pdf path
 */
export function resolvePdfPath(input, out) {
  const base = path.basename(input).replace(/\.(md|markdown)$/i, '');
  let pdf;
  if (out) pdf = path.resolve(out);
  else if (inside(input, paths.examples)) pdf = path.join(os.tmpdir(), 'gaj-render', `${base}.pdf`);
  else pdf = path.join(path.dirname(path.resolve(input)), `${base}.pdf`);
  if (!isAllowedOutput(pdf)) {
    throw new Error(`refusing to write ${pdf}: output must be inside data/, profile/ or ${os.tmpdir()} (use --out)`);
  }
  return pdf;
}
