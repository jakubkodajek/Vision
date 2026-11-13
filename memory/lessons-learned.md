# Lessons learned

Short imperative rules learned the hard way. Add one when the same mistake happens
twice or a review finding would have been prevented by a rule. Newest first.
Format: `- YYYY-MM-DD: <rule> (why: <one line>)`

- 2026-11-13: Never pipe `make check` into `tail`, `head` or `grep` without capturing its exit code; run `make check > log 2>&1; echo EXIT=$?` and show both (why: a pipeline reports the last command's status, so a failing check can look green).
- 2026-11-07: Show the `make check` output before claiming a task is done (why: agents tend to declare success early).
