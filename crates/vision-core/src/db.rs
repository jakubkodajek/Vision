//! SQLite storage (spec §2.2): WAL, foreign keys, busy timeout, forward-only migrations
//! tracked in `PRAGMA user_version`, a backup before migrating an existing database, and
//! refusal (without touching the file) of a database written by a newer build.

use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::ipc::{ErrorCode, IpcError, IpcResult};
use crate::paths::create_private_dir;

/// Migrations of `app.db`. Index `i` migrates from version `i` to `i + 1`. Never edit a
/// released entry; append a new one.
pub const APP_MIGRATIONS: &[&str] = &[
    // v1: profiles and settings.
    "CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        accent TEXT NOT NULL,
        created_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    // v2: custom tools (app scope).
    "CREATE TABLE custom_tools (
        id TEXT PRIMARY KEY,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL
    );",
];

/// Migrations of `profile.db`.
pub const PROFILE_MIGRATIONS: &[&str] = &[
    // v1: tool status cache, MCP servers, names Vision manages in Claude Code.
    "CREATE TABLE tool_status (
        tool_id TEXT PRIMARY KEY,
        status_json TEXT NOT NULL,
        version TEXT,
        binary_path TEXT,
        checked_at TEXT NOT NULL
    );
    CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        transport TEXT NOT NULL,
        command TEXT,
        args_json TEXT NOT NULL,
        url TEXT,
        entries_json TEXT NOT NULL,
        tool_ids_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        health_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE TABLE mcp_managed (name TEXT PRIMARY KEY);",
];

/// One SQLite connection guarded by a mutex; the core is the only writer.
#[derive(Debug)]
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    /// Locks the connection.
    ///
    /// # Errors
    /// `internal` if a previous holder panicked.
    pub fn lock(&self) -> IpcResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| IpcError::internal("Database lock poisoned"))
    }
}

fn too_new(label: &str, found: i64, known: usize) -> IpcError {
    IpcError::new(
        ErrorCode::SchemaTooNew,
        format!(
            "The {label} database was created by a newer version of Vision (schema {found}, this \
             build knows {known}). Update Vision; the file was not changed."
        ),
    )
}

/// Reads `user_version` of an existing file without modifying it.
fn peek_version(path: &Path) -> IpcResult<i64> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    drop(conn);
    Ok(v)
}

/// Opens (creating if needed) and migrates a database.
///
/// `label` names the database in messages and backup files (`app`, `profile-<id>`).
///
/// # Errors
/// `schema_too_new` if the file's `user_version` exceeds `migrations.len()` (the file is not
/// modified); `internal`/`io` for SQLite or file-system failures.
pub fn open(path: &Path, migrations: &[&str], backups_dir: &Path, label: &str) -> IpcResult<Db> {
    let known = migrations.len();
    if path.exists() {
        // A failed read-only peek (e.g. a WAL left without its -shm file) falls through to
        // the normal open, which checks the version again.
        if let Ok(v) = peek_version(path)
            && (v < 0 || usize::try_from(v).is_ok_and(|v| v > known))
        {
            return Err(too_new(label, v, known));
        }
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let current: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let current = usize::try_from(current).map_err(|_| too_new(label, current, known))?;
    if current > known {
        return Err(too_new(
            label,
            i64::try_from(current).unwrap_or(i64::MAX),
            known,
        ));
    }
    if current < known {
        if current > 0 {
            backup(&conn, backups_dir, label, current)?;
        }
        migrate(&conn, migrations, current)?;
    }
    Ok(Db {
        conn: Mutex::new(conn),
    })
}

fn backup(conn: &Connection, backups_dir: &Path, label: &str, version: usize) -> IpcResult<()> {
    create_private_dir(backups_dir)?;
    // Fold the WAL into the main file first so the copy is complete.
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    let stamp = crate::time::now_rfc3339().replace(':', "");
    let mut n = 0u32;
    let target = loop {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!("-{n}")
        };
        let p = backups_dir.join(format!("{label}-v{version}-{stamp}{suffix}.db"));
        if !p.exists() {
            break p;
        }
        n += 1;
    };
    let target_str = target
        .to_str()
        .ok_or_else(|| IpcError::io("The backup path is not valid UTF-8"))?;
    conn.execute("VACUUM INTO ?1", [target_str])?;
    Ok(())
}

fn migrate(conn: &Connection, migrations: &[&str], from: usize) -> IpcResult<()> {
    for (i, sql) in migrations.iter().enumerate().skip(from) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(
            None,
            "user_version",
            i64::try_from(i + 1).unwrap_or(i64::MAX),
        )?;
        tx.commit()?;
    }
    Ok(())
}
