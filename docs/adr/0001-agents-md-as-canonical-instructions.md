# ADR-0001: AGENTS.md as the canonical agent instruction file

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** template author

## Context
The project should work with several coding agents. Each tool reads a different
instruction file, and duplicated instructions drift apart.

## Options considered
1. **Separate files per tool** (CLAUDE.md, copilot-instructions.md, AGENTS.md) - full
   control per tool, but content drifts.
2. **AGENTS.md as source, others import or point to it** - one place to edit; tool-specific
   extras stay small.

## Decision
Option 2. `AGENTS.md` holds all shared instructions. `CLAUDE.md` imports it with
`@AGENTS.md` and adds only Claude-specific notes; `.github/copilot-instructions.md`
points to it. Agent and skill definitions are authored once in `.claude/` and generated
for Codex and Copilot by `scripts/sync_agents.py`.

## Consequences
- Positive: one source of truth; CI detects drift of generated files.
- Negative: tool-specific features (e.g. Claude `tools:` allowlists) are not carried
  over to Codex/Copilot copies and must be enforced there by sandbox/approval settings.

## Sources
- OpenAI Codex - Custom instructions with AGENTS.md: https://developers.openai.com/codex/guides/agents-md
- Claude Code - memory and AGENTS.md: https://code.claude.com/docs/en/memory
- GitHub changelog - Copilot coding agent supports AGENTS.md: https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions
