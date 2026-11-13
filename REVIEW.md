# REVIEW.md

Guidance for automated and human reviewers. Read by Claude Code Review, the
`/review` skill, and the reviewer subagents.

## What to flag (in priority order)

1. **Correctness:** logic errors, broken edge cases (empty input, null, off-by-one,
   timezones, concurrency), unhandled errors, wrong API usage.
2. **Security:** injection, missing authz/authn checks, secrets in code or logs,
   unsafe deserialization, SSRF, path traversal, overly broad permissions.
3. **Data safety:** destructive migrations without rollback, data loss paths.
4. **Tests:** changed behaviour without a test that would fail on the old code;
   tests that were weakened, skipped, or deleted.
5. **Contract changes:** public API, CLI flags, config, or schema changes without
   docs/changelog updates.

## What NOT to flag

- Formatting and import order (the linter owns this).
- Personal style preferences that the linter does not enforce.
- Speculative issues you cannot point to a concrete failing input for.

## Severity

- **critical:** data loss, security hole, crash on the main path. Blocks merge.
- **major:** wrong behaviour on a realistic input. Should be fixed before merge.
- **minor:** edge case or maintainability issue. Can be a follow-up.
- **nit:** optional. Report at most three.

Every finding must include `file:line`, a concrete failure scenario
(input → wrong output), and a suggested fix.
