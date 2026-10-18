#!/usr/bin/env bash
# Fails if .claude/settings.json pre-approves unrestricted shell access
# (bare "Bash" or "Bash(*)"). Run from the repo root.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
file=.claude/settings.json

if [[ ! -f "$file" ]]; then
  echo "• $file not found; skipping"
  exit 0
fi

node --input-type=module - "$file" <<'JS'
import fs from 'node:fs';
const file = process.argv[2];
let settings;
try {
  settings = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`✗ ${file} is not valid JSON: ${e.message}`);
  process.exit(1);
}
const allow = settings?.permissions?.allow ?? [];
const bad = allow.filter((rule) => {
  const r = String(rule).replace(/\s+/g, '');
  return r === 'Bash' || r === 'Bash(*)' || r === 'Bash(:*)' || r === 'Bash(**)';
});
if (bad.length) {
  console.error(`✗ ${file} allows unrestricted shell: ${bad.join(', ')}`);
  console.error('  Allow specific commands only, e.g. "Bash(node bin/gaj.js:*)" or "Bash(npm run:*)".');
  process.exit(1);
}
console.log(`✓ prompt-lint: ${file} has no unrestricted Bash rule (${allow.length} allow rules)`);
JS
