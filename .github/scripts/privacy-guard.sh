#!/usr/bin/env bash
# Privacy guard: fails if personal-data ignore rules are missing from .gitignore,
# or if any personal-data path is in git.
#
#   bash .github/scripts/privacy-guard.sh            # whole index (CI)
#   bash .github/scripts/privacy-guard.sh --staged   # only files staged for commit (pre-commit hook)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
mode=${1:-all}
fail=0

required=(
  'profile/*'
  'data/'
  'inbox/*'
  'config/companies.json'
  '.claude/settings.local.json'
  'CLAUDE.local.md'
  '.env'
)

# In --staged mode, check the .gitignore that is about to be committed if it is staged.
if [[ "$mode" == "--staged" ]] && git diff --cached --name-only --diff-filter=ACMR | grep -qxF .gitignore; then
  gitignore=$(git show :.gitignore)
elif [[ -f .gitignore ]]; then
  gitignore=$(cat .gitignore)
else
  echo "✗ .gitignore is missing"
  exit 1
fi

for line in "${required[@]}"; do
  if ! grep -qxF -- "$line" <<<"$gitignore"; then
    echo "✗ .gitignore is missing required line: $line"
    fail=1
  fi
done

if [[ "$mode" == "--staged" ]]; then
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  what="staged"
else
  files=$(git ls-files --cached)
  what="tracked by git"
fi

bad=$(grep -E \
  -e '^profile/' \
  -e '^data/' \
  -e '^inbox/' \
  -e '^config/companies\.json$' \
  -e '^\.claude/settings\.local\.json$' \
  -e '^CLAUDE\.local\.md$' \
  -e '(^|/)\.env(\..+)?$' \
  <<<"$files" | grep -vxF -e 'profile/.gitkeep' -e 'inbox/.gitkeep' -e '.env.example' || true)

if [[ -n "$bad" ]]; then
  echo "✗ Personal-data files are $what:"
  echo "$bad" | sed 's/^/    /'
  echo "  Unstage/untrack with: git rm --cached <file>  (purge history if already pushed)"
  fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "privacy-guard: FAILED"
  exit 1
fi
echo "✓ privacy-guard: ignore rules present, no personal data $what"
