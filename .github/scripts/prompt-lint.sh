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
// Commands that must always prompt: they reach arbitrary hosts or write outside the repo.
const MUST_PROMPT = ['fetch', 'careers:check', 'schedule'];
for (const rule of allow) {
  const m = /^Bash\((?:node bin\/gaj\.js|npx gaj|gaj)\s+([^\s:)*]+(?::[^\s:)*]+)?)/.exec(String(rule).trim());
  if (m && MUST_PROMPT.includes(m[1])) bad.push(rule);
  if (/^Bash\((?:node bin\/gaj\.js|npx gaj|gaj)(?::\*|\s*\*)\)$/.test(String(rule).trim())) bad.push(rule);
}
if (bad.length) {
  console.error(`✗ ${file} pre-approves rules that must prompt: ${bad.join(', ')}`);
  console.error('  Allow specific gaj subcommands only (never bare Bash, all of gaj, fetch, careers:check or schedule).');
  process.exit(1);
}
console.log(`✓ prompt-lint: ${file} has no unrestricted Bash rule and no always-prompt gaj command (${allow.length} allow rules)`);
JS
