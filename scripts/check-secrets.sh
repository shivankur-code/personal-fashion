#!/usr/bin/env bash
# Fails if a file tracked by git (or staged) contains something shaped like a secret.
# Runs in `pnpm check` and in CI, so a pasted key can never reach the repository.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
PATTERN='sk-or-v1-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AccountKey=[A-Za-z0-9+/=]{20,}|SharedAccessKey=[A-Za-z0-9+/=]{20,}'
# Files tracked now plus files staged for the next commit; this script itself is excluded.
FILES=$( { git ls-files; git diff --cached --name-only; } | sort -u | grep -v '^scripts/check-secrets.sh$' || true)
[ -z "$FILES" ] && { echo "check-secrets: no files"; exit 0; }
if echo "$FILES" | xargs -d '\n' grep -nIE "$PATTERN" -- 2>/dev/null; then
  echo "check-secrets: possible secret found above. Remove it and rotate the key." >&2
  exit 1
fi
echo "check-secrets: clean ($(echo "$FILES" | wc -l) files)"
