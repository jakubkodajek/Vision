#!/usr/bin/env bash
# PostToolUse hook for Edit|Write: formats the edited file if a formatter is available.
# Never blocks; formatting failures are reported but do not stop the agent.
set -uo pipefail

file=$(jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$file" ] || [ ! -f "$file" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

case "$file" in
  *.py)
    command -v ruff >/dev/null && ruff format --quiet "$file" ;;
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.html|*.yml|*.yaml)
    [ -x node_modules/.bin/prettier ] && node_modules/.bin/prettier --write --log-level warn "$file" ;;
  *.go)
    command -v gofmt >/dev/null && gofmt -w "$file" ;;
  *.rs)
    command -v rustfmt >/dev/null && rustfmt --quiet "$file" ;;
  *.sh)
    command -v shfmt >/dev/null && shfmt -w "$file" ;;
esac

exit 0
