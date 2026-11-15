# ADR-0002: Tauri 2 desktop shell with a Rust core and a React + TypeScript UI

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Jakub (product owner), recorded by the planner agent for F-001

## Context
Vision is a desktop app for macOS, Windows and Linux, open source and with nothing hosted
(docs/PLAN.md §0 D4). It starts and supervises many child processes (the official `claude`,
`codex` and `agy` CLIs), each in its own process group or Job Object, and talks to them over
stdio protocols (PLAN §2.2, §3.5). Because every runtime is a language-neutral subprocess
protocol rather than an embedded SDK, the core language is free to optimise for speed and
footprint (PLAN §3.1). The owner decided that speed matters more than language (D5).

Selection criteria, in order (PLAN §3): integration surface (subprocess protocols, process
trees, PTY, git, OS keychain), speed and memory with many child processes, packaging for
three OSes, maintainability, contributor friendliness.

## Options considered
1. **Tauri 2 + Rust core** - system webview, very small binaries, one process tree; the MCP
   Rust SDK is Tier 1 and the `keyring` crate covers all three OS credential stores. Slower
   to write than TypeScript; webview differences between WebKitGTK, WebView2 and WKWebView.
2. **Tauri 2 + Node.js sidecar** - TypeScript everywhere, but a second runtime packaged per
   target and an extra process. Kept as the fallback if Rust slows the project (R9).
3. **Electron + TypeScript** - mature tooling, but a bundled browser engine, larger download
   and memory use.

## Decision
We choose **Tauri 2 with a Rust core and a React + TypeScript + Vite UI** (option 1), as
decided in D5. The code is split into:

- `crates/vision-core`: a plain Rust library with the domain logic and no Tauri dependency,
  so it is unit-testable without a webview;
- `src-tauri`: the Tauri 2 application binary, a thin layer exposing core functions as
  typed commands;
- `src/`: the React UI, which talks to the core only through Tauri commands and events
  (PLAN §2.1).

The webview is treated as untrusted (PLAN §2.3): strict Content Security Policy without
inline script, no remote content, and capabilities scoped per window to the commands it
needs.

## Consequences
- Positive: small single binary per OS, no Node.js at runtime, direct access to process,
  PTY, git and keychain crates; the core can be tested and reused without the shell.
- Negative / risks: Rust learning curve (R9); webview rendering differences and Windows
  process/PTY behaviour (R8, PLAN §8.1) must be checked on Windows and one Unix per
  milestone.
- Follow-ups: typed IPC with generated TypeScript types (F-004); installer matrix for three
  OSes (F-002); if M0 + M1 take more than twice their time box, revisit option 2 before M3
  (R9).

## Sources
- docs/PLAN.md rev 3.1: §0 D4, D5; §1 item 1; §2, §2.1-2.3; §3.1, §3.2, §3.3; §10 R8, R9.
- Tauri 2 - what is Tauri: https://v2.tauri.app/start/
- Tauri 2 - Node.js as a sidecar: https://v2.tauri.app/learn/sidecar-nodejs/
- MCP SDKs: https://modelcontextprotocol.io/docs/sdk
- keyring crate: https://docs.rs/crate/keyring/3.6.3/source/README.md
- Electron process model: https://electronjs.org/docs/latest/tutorial/process-model
