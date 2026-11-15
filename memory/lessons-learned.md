# Lessons learned

Short imperative rules learned the hard way. Add one when the same mistake happens
twice or a review finding would have been prevented by a rule. Newest first.
Format: `- YYYY-MM-DD: <rule> (why: <one line>)`

- 2026-11-15: Run the Rust suite on Windows and macOS runners, not only Linux, before calling process or file code done (why: the first Windows run hung in `kill_group` and failed a byte comparison that Linux never saw).
- 2026-11-15: Never call process-wrap's Job Object `wait()` after polling `try_wait()`; reap the leader through `inner_mut().wait()` (why: `try_wait` drains the job's completion port, so the untimed `wait` blocks forever).
- 2026-11-15: Pin `eol=lf` in `.gitattributes` for every file a test compares byte for byte (why: Git for Windows checked `src/ipc/bindings.ts` out with CRLF and the freshness test failed).
- 2026-11-14: Never write back a whole row you read before a slow operation (process run, probe, dialog); write only the result with a targeted `UPDATE ... WHERE id AND revision` (why: `mcp_test` resurrected deleted servers and reverted edits).
- 2026-11-14: Never run a user-defined command headless without a native confirmation of its exact definition (why: a saved custom tool or MCP server could run arbitrary code on the next Check).
- 2026-11-14: Never put a secret on a child process command line; pass it through a file or the environment (why: `claude mcp add-json` argv is visible to every local process).
- 2026-11-14: When a stored secret is reused on edit, re-ask for it if its destination changed (why: an edited URL silently received the old Authorization header).
- 2026-11-14: Read child output into a shared buffer and stop at a deadline after exit, never wait for EOF (why: a daemon that inherits the pipe hung the PATH probe and dropped all output).
- 2026-11-14: Normalise user-visible names (NFC, no Cf characters) before comparing or storing them (why: zero-width and bidi characters made look-alike profile names).
- 2026-11-13: Never pipe `make check` into `tail`, `head` or `grep` without capturing its exit code; run `make check > log 2>&1; echo EXIT=$?` and show both (why: a pipeline reports the last command's status, so a failing check can look green).
- 2026-11-07: Show the `make check` output before claiming a task is done (why: agents tend to declare success early).
