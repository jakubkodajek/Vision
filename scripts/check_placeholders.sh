#!/usr/bin/env bash
# Fails if template bootstrap placeholders remain. Optional argument: root directory.
# Exit codes: 0 clean, 1 placeholders found, 2 error (missing root, grep failure).
# Portable to bash 3.2 and BSD grep (macOS): no GNU-only flags, no bash 4 features.
set -euo pipefail

root="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
# Built by concatenation so this script never matches itself.
pattern="TODO""(bootstrap)"

cd -- "$root" || { echo "check_placeholders: cannot enter root: $root" >&2; exit 2; }

# Exclusions:
# - Directories are excluded by name at any depth (tooling, vendored and build output).
# - The three files below legitimately mention the placeholder (docs and feature
#   list), but only at these exact paths relative to the root. They are filtered
#   from the output instead of using --exclude, which would match the basename
#   at any depth and hide real leftovers such as docs/README.md.
set +e
matches=$(grep -rnF \
  --exclude-dir=.git --exclude-dir=.agents --exclude-dir=.claude --exclude-dir=.github \
  --exclude-dir=.work --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
  -- "$pattern" .)
status=$?
set -e

# grep: 0 = matches, 1 = none, >1 = error. Never treat an error as a pass.
if [ "$status" -gt 1 ]; then
  echo "check_placeholders: grep failed (exit $status)" >&2
  exit 2
fi

if [ "$status" -eq 0 ]; then
  matches=$(printf '%s\n' "$matches" | grep -v \
    -e '^\./README\.md:' -e '^\./docs/PLAN\.md:' -e '^\./memory/features\.json:' || true)
  if [ -n "$matches" ]; then
    printf '%s\n' "$matches" >&2
    echo "Bootstrap placeholders remain" >&2
    exit 1
  fi
fi
exit 0
