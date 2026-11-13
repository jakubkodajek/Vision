---
name: ux-audit
description: Audit the running app's UX/UI and accessibility (WCAG 2.2 AA) in a real browser across mobile and desktop widths, with screenshots as evidence. Use when the user asks for UX, UI, design, or accessibility review.
argument-hint: "[URL or flow names] (default: make dev on localhost)"
---

# UX / UI audit

Target: $ARGUMENTS

1. Slug `ux-<area>`; create `.work/<slug>/screens/`.
2. Make sure the app is running (`make dev`) or use the given URL. If no browser tool
   is available, tell the user how to add Playwright MCP (see `docs/agent-workflow.md#tools`).
3. Delegate to **ux-ui-reviewer** with the URL, the flows to test, and the slug.
4. Delegate to **verifier** to drop findings that are not reproducible in the browser.
5. Report findings grouped by: blockers (user cannot finish a task), accessibility,
   visual consistency, copy. Each with screenshot path and suggested fix.
