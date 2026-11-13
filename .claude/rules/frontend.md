---
paths:
  - "src/**/*.tsx"
  - "src/**/*.jsx"
  - "src/**/*.vue"
  - "src/**/*.svelte"
  - "src/**/*.css"
---

# Frontend rules

- Every interactive element is reachable and operable by keyboard, with a visible focus state.
- Every input has a programmatic label; every image has meaningful `alt` or `alt=""`.
- Design every state: loading, empty, error, success, disabled.
- Use design tokens / existing components before adding new styles.
- Text contrast at least 4.5:1 (WCAG 2.2 AA).
