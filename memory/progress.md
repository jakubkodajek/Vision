# Progress log

Append-only. Newest entry at the bottom. Read the last 2-3 entries at session start.

Template:

```
## YYYY-MM-DD - <task-slug>
- Done: what changed (commits)
- State: make check green/red; branch name
- Next: the single next concrete step
- Blockers / open questions:
```

## 2026-11-07 - template-created
- Done: repository created from the AI dev template.
- State: no application code yet.
- Next: run the `bootstrap-project` skill.
- Blockers / open questions: none.

## 2026-11-13 - vision-plan
- Done: wrote `docs/PLAN.md` (architecture, stack comparison with sources, data model, account profiles and vault, roadmap M0-M8, risks, open questions). Planning only, no code.
- State: no application code yet; `make check` unchanged; branch `claude/project-thread-qwfpka`.
- Next: Jakub answers the open questions in `docs/PLAN.md` §10; then record ADRs 0002-0005 and run `bootstrap-project`.
- Blockers / open questions: see `docs/PLAN.md` §10.

## 2026-11-13 - vision-plan (revision 2)
- Done: revised `docs/PLAN.md` after Jakub's answers: CLI subscription sign-in (no API keys), per-profile config homes (CLAUDE_CONFIG_DIR, CODEX_HOME, GH_CONFIG_DIR), desktop-only open source app, Tauri 2 + Rust core, macOS/Windows/Linux.
- State: no application code yet; branch `claude/project-thread-qwfpka`, PR #1.
- Next: Jakub answers the remaining questions in `docs/PLAN.md` §10, then M0 (skeleton + Claude Code streaming spike).
- Blockers / open questions: see `docs/PLAN.md` §10.

## 2026-11-13 - vision-plan (revision 3)
- Done: `docs/PLAN.md` revision 3: owner decisions D1-D8, knowledge layer, generic per-profile tool registry, findings of an independent review applied (safe launch flags, no push credential for agents, crash recovery, launch compilation, adapter tests, Windows specifics, roadmap reorder with first run at M2 and 0.1 at M7).
- State: no application code yet; branch `claude/project-thread-qwfpka`, PR #1.
- Next: Jakub answers `docs/PLAN.md` §11, then M0.
- Blockers / open questions: `docs/PLAN.md` §11.

## 2026-11-13 - f-001-bootstrap
- Done: Tauri 2 workspace (`crates/vision-core`, `src-tauri`), React 19/TS/Vite UI placeholder with `app_info` command, strict CSP + single-permission capability, placeholder icons, Makefile targets, placeholder check script (`scripts/check_placeholders.sh`), CI toolchain, filled `AGENTS.md`/memory/architecture, ADRs 0002-0004. Commits: cc34bf8, ed1c56f, 1c4121f, 4cdc7f1, 033619a (placeholder-check regression tests), 4eb7a84 (review round 1 fixes). Verifier run: `.work/f-001-bootstrap/verified-findings.md` (10 confirmed, 2 plausible, 6 rejected); the fix-now items were applied in 4eb7a84 (CR-1 ADR-0004 wording, BUG-1 grep error handling, CR-2 `unwrap_used = "deny"`, CR-3 unused serde removed, BUG-2 `--` before root, CR-7 `.nvmrc` 22.22.2). `F-001` `passes` set to true.
- State: `make check` exit 0 on branch `claude/project-thread-mbj4su` (3 Rust tests, 50 vitest tests). `generate_context!` needs no `dist/` in dev profile. README.md still describes the template (not updated).
- Next: open the PR for `claude/project-thread-mbj4su`, then F-002 (installer matrix) or F-003 (SQLite storage), one per session.
- Deferred items:
  - SEC-1 / BUG-6: pin third-party GitHub Actions to commit SHAs and pin the Rust toolchain version (`rust-toolchain.toml` uses `channel = "stable"`) -> F-002.
  - cargo-audit or cargo-deny job (glib RUSTSEC-2024-0429 inherited from Tauri's GTK3 stack on Linux) -> F-002.
  - App.tsx input validation and error boundary -> F-004 (typed IPC) / F-005 (real UI).
  - devCsp assertion test (CR-5, optional) -> F-004.
  - Placeholder check exclusions match by basename at any depth (BUG-3, optional).
  - `no-unnecessary-type-parameters` disabled for tests/config (CR-4a, optional inline disable with reason).
  - README.md rewrite for the Vision project -> docs pass after F-002.
- Blockers / open questions:
  - Owner must decide the bundle identifier before F-003 (`dev.vision.desktop` is a placeholder).
