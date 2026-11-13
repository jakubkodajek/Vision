#!/usr/bin/env bash
# Fails if template bootstrap placeholders remain. Optional argument: root directory.
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
# Built by concatenation so this script never matches itself.
pattern="TODO""(bootstrap)"

if matches=$(grep -rnF "$pattern" \
  --exclude-dir=.git --exclude-dir=.agents --exclude-dir=.claude --exclude-dir=.github \
  --exclude-dir=.work --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
  --exclude=README.md --exclude=PLAN.md --exclude=features.json "$root"); then
  printf '%s\n' "$matches" >&2
  echo "Bootstrap placeholders remain" >&2
  exit 1
fi
exit 0
