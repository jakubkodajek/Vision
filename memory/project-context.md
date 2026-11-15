# Project context

## Product
- **One-liner:** Vision is an open-source desktop app (macOS, Windows, Linux) that orchestrates AI coding agents by driving the user's own official CLIs (Claude Code, Codex) per account profile.
- **Problem it solves:** Running several AI coding agents across work and personal accounts and nested projects safely, with isolated logins per profile and shared project knowledge.
- **Target users:** Developers who use Claude Code or Codex subscriptions; initially the owner.

## Scope
- **Core features:** see `memory/features.json`; roadmap in `docs/PLAN.md` §9.
- **Out of scope:** hosted service, API-key access, bundling or modifying the CLIs, telemetry, a paid offering (PLAN §0, §8, R2).

## Constraints
- **Tech stack:** Tauri 2 + Rust core (`crates/vision-core`, `src-tauri`), React 19 + TypeScript + Vite UI, SQLite per profile; official CLIs run as child processes; npm + Cargo workspace.
- **Deployment target:** desktop builds for macOS Apple Silicon, Windows, Linux (AppImage/.deb) via GitHub Releases; unsigned for early testers.
- **Non-functional:** WCAG 2.2 AA; no telemetry; strict webview CSP; local-only data; macOS verified live per milestone, Windows via CI replay tier until a Windows machine is available (PLAN D11); 1 000-node tree switch under 100 ms p95 target from M4.

## Glossary
- **Profile:** top-level account context (e.g. Work, Personal) with its own logins and database; sits above workspaces.
- **Workspace:** container of a project tree inside a profile.
- **Project:** node in the nested project tree; settings inherit from parents.
- **Tool account / config home:** per-profile login for one tool via its own config directory (CLAUDE_CONFIG_DIR, CODEX_HOME, GH_CONFIG_DIR, ...).
- **Run:** one agent execution as a child CLI process.
- **Agent definition:** role, prompt, tools and permissions of an agent (PLAN §5.1).
- **Runtime adapter:** core component that starts a CLI and normalises its stream into Vision events.
- **Approval:** a permission request from a run that a human allows or denies.
- **Event log:** append-only record of events per run.
