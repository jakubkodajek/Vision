# ADR-0003: SQLite in WAL mode, one database per profile plus an app database

- **Status:** Accepted
- **Date:** 2026-11-13
- **Deciders:** Jakub (product owner, via acceptance of docs/PLAN.md rev 3.1), recorded by the planner agent for F-001

## Context
Vision stores profiles, workspaces, project trees, agent definitions, runs, an append-only
event log, approvals and an audit log (PLAN §4). A profile (Work, Personal, ...) is the
isolation boundary: its data must never appear in another profile, and exporting or
deleting a profile must be simple and complete (PLAN §0 D2, D3; §6.1). The app is local
only, with nothing hosted (D4). The Rust core is the only writer (ADR-0002). Hierarchies
need ancestor walks and the knowledge layer needs full-text search (PLAN §3.4, §7.2).

## Options considered
1. **One SQLite database per profile plus a small app database** - export or delete of a
   profile is a file operation; a Work export cannot contain Personal data by construction.
   Cross-profile queries (e.g. a usage overview) need to open several files.
2. **One SQLite database with a `profile_id` column everywhere** - simple cross-profile
   queries, but isolation depends on every query filtering correctly, and export/delete
   become row-level operations.
3. **An embedded key-value store or a server database** - no SQL, CTEs or FTS5 (key-value),
   or a separate server process, which conflicts with a local single-binary app.

## Decision
We choose **option 1**: SQLite in WAL mode, one `profile.db` per profile under the
non-roaming local app data directory (`<local app data>/Vision/profiles/<short-id>/`), plus
an app database holding the profiles list, the shared-library index and app settings
(PLAN §3.4, §4.1, §6.2).

Rules from PLAN §4.5: forward-only numbered migrations tracked in `PRAGMA user_version`;
the database is checkpointed and copied before a migration; an older build refuses to open
a newer schema with a clear message; approvals and audit writes use `synchronous=FULL`,
other writes may use `NORMAL`. Files on local disk only, because WAL does not work on
network filesystems, and the `-wal` file is kept with the database when copying.

## Consequences
- Positive: isolation between profiles is structural; export and deletion are file
  operations; recursive CTEs and FTS5 are available in one embedded engine.
- Negative / risks: cross-profile views must aggregate over several files; schema migrations
  run per file; copying a live database must include the WAL file.
- Follow-ups: implementation with migrations and tests in F-003; per-profile database
  creation in F-010.

## Sources
- docs/PLAN.md rev 3.1: §0 D2-D4; §3.4; §4.1; §4.5; §6.1; §6.2.
- SQLite write-ahead logging: https://www.sqlite.org/wal.html
- SQLite WITH clause (recursive CTEs): https://www.sqlite.org/lang_with.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
