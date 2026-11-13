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
