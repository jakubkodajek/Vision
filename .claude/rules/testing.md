---
paths:
  - "tests/**"
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/test_*.py"
---

# Testing rules

- One behaviour per test; the test name states the behaviour (`returns_404_for_unknown_user`).
- Arrange / Act / Assert, no logic (loops, conditionals) inside tests.
- No real network, clock, or randomness: use fakes, frozen time, fixed seeds.
- Never delete, skip, or loosen an existing assertion to make a change pass.
- A bug fix starts with a regression test that fails on the old code.
