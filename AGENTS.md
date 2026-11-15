# AGENTS.md

Canonical instructions for every AI coding agent working in this repository
(Claude Code, OpenAI Codex, GitHub Copilot, Cursor, Gemini, ...).
`CLAUDE.md` imports this file; `.github/copilot-instructions.md` points here.
Keep it short: every line is loaded into every session.

## Project

- **What it is:** Vision, an open-source desktop app (macOS, Windows, Linux) that orchestrates AI coding agents by driving the user's own official CLIs (Claude Code, Codex) per account profile; nothing hosted, no API keys.
- **Stack:** Tauri 2 + Rust core (`crates/vision-core`, `src-tauri`), React 19 + TypeScript + Vite UI (`src/`), SQLite per profile; npm, Cargo workspace.
- **Context:** read `memory/project-context.md` (goals, users, constraints) before non-trivial work.

## Commands

All verification goes through `make`. Agents must run these and show the output
instead of claiming success.

| Task | Command |
| --- | --- |
| Install deps | `make setup` |
| Lint + typecheck | `make lint` |
| Unit/integration tests | `make test` |
| End-to-end / UI tests | `make e2e` |
| Everything CI runs | `make check` |
| Run the app locally | `make dev` |
| Build installers for this OS | `make build` |

## Repository layout

- `src/` React + TypeScript UI; `src-tauri/` Tauri shell (commands, config, capabilities)
- `crates/vision-core/` domain logic, no Tauri dependency
- `tests/` UI and config tests (vitest); Rust tests in `crates/*/tests/` and in-crate `#[cfg(test)]`
- `docs/` architecture, ADRs (`docs/adr/`), feature specs (`docs/specs/`), agent workflow
- `memory/` durable project memory shared by humans and agents (see `memory/README.md`)
- `.claude/` Claude Code agents, skills, hooks, rules (source of truth for all agent definitions)
- `.work/` scratch space for agent handoffs, git-ignored

## Working rules

1. **Explore → plan → implement → verify → review.** Do not write code before you
   understand the relevant files. For anything larger than a small fix, write a plan
   in `.work/<task-slug>/plan.md` first.
2. **One feature at a time.** Pick a single item from `memory/features.json`, finish
   it, verify it, commit it. Do not start a second item in the same session.
3. **Evidence over assertion.** A task is done only when `make check` passes and you
   have shown the command output. For UI work, also attach a screenshot or an
   accessibility snapshot.
4. **Never weaken tests to make them pass.** Do not delete, skip, or loosen an
   existing test or assertion without an explicit human decision recorded in the PR.
5. **Small, reviewable commits** using Conventional Commits (`feat:`, `fix:`, `test:`,
   `docs:`, `refactor:`, `chore:`).
6. **Separation of duties.** The agent that wrote code does not approve it. Reviews are
   done by a fresh reviewer context (see `docs/agent-workflow.md`).
7. **Update memory before you stop.** Append a short entry to `memory/progress.md`;
   record new decisions in `memory/decisions.md` (or an ADR) and repeated mistakes in
   `memory/lessons-learned.md`.

## Code conventions

- TypeScript strict, no `any`. Rust 2024: `cargo fmt`, clippy clean (`-D warnings`), no `unsafe`, no `unwrap()` outside tests.
- The UI reaches the core only through Tauri commands/events. Never add generic run-command or file-read IPC; keep the CSP strict (PLAN §2.3).
- Vision never stores AI or GitHub tokens (ADR-0004).
- Prefer the standard library and well-established packages; justify new dependencies in the PR.
- Public functions get type annotations and a docstring/JSDoc.
- No secrets in code, logs, or commits. Configuration comes from environment variables
  documented in `.env.example`.

## Pull requests

- Fill in `.github/pull_request_template.md`, including the verification evidence.
- Link the spec (`docs/specs/...`) or issue the PR implements.
- Review guidance for automated reviewers lives in `REVIEW.md`.
