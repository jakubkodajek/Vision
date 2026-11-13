#!/usr/bin/env bash
# PreToolUse hook for Edit|Write: blocks edits to secrets, lockfiles and generated files.
set -euo pipefail

file=$(jq -r '.tool_input.file_path // .tool_input.path // ""')
[ -z "$file" ] && exit 0
rel=${file#"${CLAUDE_PROJECT_DIR:-$PWD}/"}

block() {
  echo "Blocked by .claude/hooks/protect-files.sh: $rel - $1" >&2
  exit 2
}

case "$rel" in
  .env|.env.*|*/.env|*/.env.*)
    [[ "$rel" == *.env.example ]] || block "secret file; edit .env.example instead" ;;
  *.pem|*.key|*id_rsa*|*.p12)
    block "private key material" ;;
  package-lock.json|pnpm-lock.yaml|yarn.lock|poetry.lock|uv.lock|Cargo.lock|*/package-lock.json)
    block "lockfile; change it with the package manager, not by hand" ;;
  .github/agents/*|.codex/agents/*|.agents/skills/*)
    block "generated file; edit .claude/agents or .claude/skills and run scripts/sync_agents.py" ;;
  .git/*)
    block "git internals" ;;
esac

exit 0
