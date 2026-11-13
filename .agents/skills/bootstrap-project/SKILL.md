---
name: bootstrap-project
description: First-run setup of a new project created from this template - interview the user about the product and stack, then fill in AGENTS.md, memory/project-context.md, the Makefile targets, docs/architecture.md and the initial feature list. Use once, right after creating a repo from the template.
disable-model-invocation: true
---

# Bootstrap a new project from the template

1. Ask the user (in one message) for: product one-liner, target users, the 3–5 core
   features, tech stack (or ask you to propose one), deployment target, and hard
   constraints (budget, compliance, deadlines).
2. If the user wants a stack proposal, write an ADR with the `adr` skill first.
3. Fill in, replacing every `TODO(bootstrap)`:
   - `AGENTS.md` (project, stack, layout, conventions)
   - `memory/project-context.md`
   - `Makefile` targets `setup`, `lint`, `test`, `e2e`, `dev` with the real commands
   - `docs/architecture.md` (initial component diagram)
   - `memory/features.json` with one item per core feature, all `"passes": false`
4. Scaffold the app with the stack's official generator, add a first passing test,
   and make `make check` green.
5. Remove the `TEMPLATE:` comment at the top of `AGENTS.md`, set the toolchain step in
   `.github/workflows/ci.yml`, run `python3 scripts/sync_agents.py`, then
   `grep -rn "TODO(bootstrap)" --exclude-dir=.git --exclude-dir=.agents --exclude-dir=.claude --exclude-dir=.github --exclude=README.md .`
   must return nothing.
6. Commit as `chore: bootstrap project from template` and run the `handoff` skill.
