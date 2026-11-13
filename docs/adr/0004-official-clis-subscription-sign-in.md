# ADR-0004: Drive the official CLIs with the user's subscription sign-in; no API keys

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Jakub (product owner), recorded by the planner agent for F-001

## Context
Vision orchestrates AI coding agents for one user on their own machine. The owner decided
that Vision stores and offers no API keys; users sign in to their own subscriptions through
the official CLIs (PLAN §0 D1), with separate logins per profile (D2). Provider terms
constrain how a third-party product may use subscription logins: Anthropic does not prevent
an end user from signing in to the unmodified Claude Code binary with their own
subscription, while third-party developers may not offer claude.ai login or collect, store
or intermediate its credentials; OpenAI permits local or open-source apps using app-server
authentication (PLAN §1 item 3, §3.1). These are readings of current terms, tracked as R2.

## Options considered
1. **Embed provider SDKs with API keys** - full control over the agent loop, but conflicts
   with D1, and the Agent SDK developer clause expects API keys.
2. **Drive the user's installed official CLIs** (`claude -p` stream-json, `codex
   app-server`, `agy acp`) as child processes, with sign-in done in each CLI's own flow -
   matches D1 and the terms as read; depends on CLI behaviour that can change (R4, R10, R11).
3. **Vision-hosted proxy or account service** - conflicts with "nothing hosted" (D4) and
   would require handling credentials.

## Decision
We choose **option 2**. Vision runs the user's own unmodified `claude`, `codex` and
optionally `agy` binaries as child processes over their documented machine interfaces
(PLAN §1 item 2, §3.5). Sign-in happens in the CLI's own flow, started in the system
terminal with the profile environment (PLAN §6.5). Each profile gets its own config home per
tool (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GH_CONFIG_DIR`, `CLOUDSDK_CONFIG`, ...; PLAN §6.2,
§6.3). Vision never reads, stores, exports or intermediates tokens; it stores only a login
label and the time of the last status check. It does not bundle or modify the CLIs, does not
use `claude setup-token`, never launches Claude Code with `--bare`, and builds each run's
environment from an allowlist so variables such as `ANTHROPIC_API_KEY` or `GH_TOKEN` cannot
override the profile login (PLAN §3.5, §6.5, §6.6).

## Consequences
- Positive: no secrets in Vision's storage; each profile's logins are isolated by
  documented CLI mechanisms; usage draws from the user's own subscription.
- Negative / risks: provider terms may change (R2); `--bare` may become the `-p` default
  and lose subscription login (R10); programmatic use may be metered separately (R11); CLI
  output formats may change (R4).
- Follow-ups: spike from Rust proving start, permission round-trip, cancel and resume on a
  subscription login, recorded as ADR-0005 (F-006); tool registry and environment allowlist
  (F-011, F-012); written question to Anthropic and OpenAI before M2 (Q2).

## Sources
- docs/PLAN.md rev 3.1: §0 D1, D2, D4; §1 items 2-4; §3.1; §3.5; §6.2-6.6; §10 R2, R4, R10, R11.
- Claude Code legal and compliance: https://code.claude.com/docs/en/legal-and-compliance
- Claude Code authentication: https://code.claude.com/docs/en/authentication
- Claude Code headless mode: https://code.claude.com/docs/en/headless.md
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference.md
- Codex app-server: https://learn.chatgpt.com/docs/app-server.md
- Codex authentication: https://learn.chatgpt.com/docs/auth.md
