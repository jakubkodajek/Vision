# Decision log

One line per decision. Significant or hard-to-reverse decisions get an ADR in `docs/adr/`.
Format: `- YYYY-MM-DD: <decision> - <reason> [ADR-NNNN]`

- 2026-11-07: Use AGENTS.md as the canonical agent instruction file, imported by CLAUDE.md - one file works for Claude Code, Codex and Copilot [ADR-0001]
- 2026-11-13: Vision core in Rust inside a Tauri 2 desktop app, UI in React/TypeScript - speed, single binary, no Node sidecar now that runtimes are CLI subprocesses (see docs/PLAN.md §3.2; ADR in M0)
- 2026-11-13: AI access only via the user's own subscription login in the official CLIs; Vision stores no AI or GitHub tokens - provider terms and user requirement (docs/PLAN.md §3.5, §6)
- 2026-11-13: Agents and skills can be shared between profiles via a shared library, controlled by a user setting - user's choice (docs/PLAN.md §6.1)
