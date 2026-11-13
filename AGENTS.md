# AGENTS.md

Canonical instructions for every AI coding agent working in this repository
(Claude Code, OpenAI Codex, GitHub Copilot, Cursor, Gemini, ...).
`CLAUDE.md` imports this file; `.github/copilot-instructions.md` points here.
Keep it short: every line is loaded into every session.

<!-- TEMPLATE: replace every "TODO(bootstrap)" below, or run the `bootstrap-project` skill. -->

## Project

- **What it is:** TODO(bootstrap) one-sentence description.
- **Stack:** TODO(bootstrap) e.g. TypeScript + React + Vite / Python 3.12 + FastAPI.
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

## Repository layout

- `src/` application code (TODO(bootstrap) adjust)
- `tests/` automated tests
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

- TODO(bootstrap) language-specific style, e.g. "strict TypeScript, no `any`".
- Prefer the standard library and well-established packages; justify new dependencies in the PR.
- Public functions get type annotations and a docstring/JSDoc.
- No secrets in code, logs, or commits. Configuration comes from environment variables
  documented in `.env.example`.

## Pull requests

- Fill in `.github/pull_request_template.md`, including the verification evidence.
- Link the spec (`docs/specs/...`) or issue the PR implements.
- Review guidance for automated reviewers lives in `REVIEW.md`.
