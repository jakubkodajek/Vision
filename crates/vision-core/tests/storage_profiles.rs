//! AC1 to AC3: storage, migrations and profiles.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use common::{Harness, create_profile};
use rusqlite::Connection;
use vision_core::ipc::{
    Accent, ErrorCode, KeyValueInput, McpSaveArgs, McpServerInput, McpTransportInput,
    ProfileCreateArgs, ProfileDeleteArgs, ProfileKind, ProfileSetActiveArgs, ProfileUpdateArgs,
    ValueInput,
};
use vision_core::secrets::SecretString;
use vision_core::{Core, db};

// ---- AC1 -------------------------------------------------------------------------------

#[test]
fn bootstrap_on_fresh_data_root_returns_no_profiles() {
    let h = Harness::new();
    let b = h.core().bootstrap().unwrap();
    assert!(b.profiles.is_empty());
    assert_eq!(b.active_profile_id, None);
}

#[test]
fn created_profile_survives_a_restart() {
    let h = Harness::new();
    let p = create_profile(&h.core(), "Work");
    let b = h.core().bootstrap().unwrap();
    assert_eq!(b.profiles, vec![p.clone()]);
    assert_eq!(b.active_profile_id, Some(p.id));
}

#[test]
fn active_profile_setting_survives_a_restart() {
    let h = Harness::new();
    let core = h.core();
    create_profile(&core, "Work");
    let personal = create_profile(&core, "Personal");
    core.profile_set_active(ProfileSetActiveArgs {
        id: personal.id.clone(),
    })
    .unwrap();
    drop(core);
    assert_eq!(
        h.core().bootstrap().unwrap().active_profile_id,
        Some(personal.id)
    );
}

#[test]
fn profile_update_changes_only_given_fields() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let u = core
        .profile_update(ProfileUpdateArgs {
            id: p.id.clone(),
            name: None,
            kind: None,
            accent: Some(Accent::Teal),
        })
        .unwrap();
    assert_eq!(
        (u.name.as_str(), u.kind, u.accent),
        ("Work", ProfileKind::Work, Accent::Teal)
    );
}

// ---- AC2 -------------------------------------------------------------------------------

/// The v1 `app.db` schema exactly as released (fixture of an older database).
const APP_V1_FIXTURE: &str = "CREATE TABLE profiles (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL, accent TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO profiles VALUES ('p_aaaaaaaaaaaa', 'Old', 'old', 'work', 'iris', '2026-01-01T00:00:00Z');
    PRAGMA user_version = 1;";

fn write_fixture(h: &Harness, sql: &str) {
    std::fs::create_dir_all(h.data_root()).unwrap();
    let c = Connection::open(h.data_root().join("app.db")).unwrap();
    c.execute_batch(sql).unwrap();
}

fn backups(h: &Harness) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(h.data_root().join("backups"))
        .map(|rd| rd.map(|e| e.unwrap().path()).collect())
        .unwrap_or_default()
}

#[test]
fn migrating_an_older_database_keeps_its_data() {
    let h = Harness::new();
    write_fixture(&h, APP_V1_FIXTURE);
    let b = h.core().bootstrap().unwrap();
    assert_eq!(b.profiles[0].name, "Old");
}

#[test]
fn migrating_an_older_database_takes_a_backup_of_the_old_version_first() {
    let h = Harness::new();
    write_fixture(&h, APP_V1_FIXTURE);
    h.core();
    let files = backups(&h);
    assert_eq!(files.len(), 1, "{files:?}");
    let c = Connection::open(&files[0]).unwrap();
    let v: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    let name: String = c
        .query_row("SELECT name FROM profiles", [], |r| r.get(0))
        .unwrap();
    assert_eq!((v, name.as_str()), (1, "Old"));
}

#[test]
fn migrated_database_reaches_the_latest_version() {
    let h = Harness::new();
    write_fixture(&h, APP_V1_FIXTURE);
    h.core();
    let c = Connection::open(h.data_root().join("app.db")).unwrap();
    let v: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, db::APP_MIGRATIONS.len() as i64);
}

#[test]
fn fresh_database_takes_no_backup() {
    let h = Harness::new();
    h.core();
    assert!(backups(&h).is_empty());
}

#[test]
fn newer_schema_is_refused_with_schema_too_new() {
    let h = Harness::new();
    write_fixture(&h, "CREATE TABLE future (x); PRAGMA user_version = 99;");
    let err = Core::open(h.data_root(), h.deps()).unwrap_err();
    assert_eq!(err.code, ErrorCode::SchemaTooNew);
}

#[test]
fn newer_schema_database_is_byte_identical_after_refusal() {
    let h = Harness::new();
    write_fixture(
        &h,
        "CREATE TABLE future (x); INSERT INTO future VALUES (1); PRAGMA user_version = 99;",
    );
    let path = h.data_root().join("app.db");
    let before = std::fs::read(&path).unwrap();
    let _ = Core::open(h.data_root(), h.deps());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert!(!h.data_root().join("app.db-wal").exists());
}

#[test]
fn database_uses_wal_mode() {
    let h = Harness::new();
    h.core();
    let c = Connection::open(h.data_root().join("app.db")).unwrap();
    let mode: String = c
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
}

// ---- AC3 -------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn profile_directories_are_user_only() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    let p = create_profile(&h.core(), "Work");
    let dir = h.data_root().join("profiles").join(&p.id);
    let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
    let tools = std::fs::metadata(dir.join("tools"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!((mode, tools), (0o700, 0o700));
}

#[test]
fn profile_create_makes_directory_and_database() {
    let h = Harness::new();
    let p = create_profile(&h.core(), "Work");
    assert!(
        h.data_root()
            .join("profiles")
            .join(&p.id)
            .join("profile.db")
            .is_file()
    );
}

fn create_err(core: &Core, name: &str) -> ErrorCode {
    core.profile_create(ProfileCreateArgs {
        name: name.to_owned(),
        kind: ProfileKind::Personal,
        accent: Accent::Rose,
    })
    .unwrap_err()
    .code
}

#[test]
fn empty_profile_name_is_rejected() {
    assert_eq!(
        create_err(&Harness::new().core(), "   "),
        ErrorCode::InvalidInput
    );
}

#[test]
fn profile_name_longer_than_40_characters_is_rejected() {
    assert_eq!(
        create_err(&Harness::new().core(), &"x".repeat(41)),
        ErrorCode::InvalidInput
    );
}

#[test]
fn profile_name_with_control_characters_is_rejected() {
    assert_eq!(
        create_err(&Harness::new().core(), "Work\nEvil"),
        ErrorCode::InvalidInput
    );
}

#[test]
fn profile_name_is_trimmed() {
    let h = Harness::new();
    assert_eq!(create_profile(&h.core(), "  Work  ").name, "Work");
}

#[test]
fn duplicate_profile_name_conflicts_case_insensitively() {
    let h = Harness::new();
    let core = h.core();
    create_profile(&core, "Work");
    assert_eq!(create_err(&core, "WORK"), ErrorCode::Conflict);
}

#[test]
fn renaming_to_an_existing_name_conflicts() {
    let h = Harness::new();
    let core = h.core();
    create_profile(&core, "Work");
    let p = create_profile(&core, "Personal");
    let err = core
        .profile_update(ProfileUpdateArgs {
            id: p.id,
            name: Some("work".into()),
            kind: None,
            accent: None,
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
}

#[test]
fn delete_with_wrong_confirmation_changes_nothing() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let err = core
        .profile_delete(ProfileDeleteArgs {
            id: p.id.clone(),
            confirm_name: "work".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
    assert_eq!(core.bootstrap().unwrap().profiles, vec![p.clone()]);
    assert!(h.data_root().join("profiles").join(&p.id).is_dir());
}

#[test]
fn delete_removes_row_and_directory() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.profile_delete(ProfileDeleteArgs {
        id: p.id.clone(),
        confirm_name: "Work".into(),
    })
    .unwrap();
    assert!(core.bootstrap().unwrap().profiles.is_empty());
    assert!(!h.data_root().join("profiles").join(&p.id).exists());
}

#[test]
fn deleting_the_active_profile_activates_another() {
    let h = Harness::new();
    let core = h.core();
    let work = create_profile(&core, "Work");
    let personal = create_profile(&core, "Personal");
    core.profile_delete(ProfileDeleteArgs {
        id: work.id,
        confirm_name: "Work".into(),
    })
    .unwrap();
    assert_eq!(
        core.bootstrap().unwrap().active_profile_id,
        Some(personal.id)
    );
}

#[test]
fn delete_removes_the_profiles_secrets() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.mcp_save(McpSaveArgs {
        profile_id: p.id.clone(),
        server: McpServerInput {
            id: None,
            name: "remote".into(),
            transport: McpTransportInput::Http {
                url: "https://mcp.example.com/mcp".into(),
                headers: vec![KeyValueInput {
                    key: "Authorization".into(),
                    value: ValueInput::Secret {
                        value: Some(SecretString::new("Bearer s3cr3t")),
                    },
                }],
            },
            tool_ids: vec![],
            enabled: true,
        },
    })
    .unwrap();
    assert_eq!(h.secrets.accounts().len(), 1);
    core.profile_delete(ProfileDeleteArgs {
        id: p.id,
        confirm_name: "Work".into(),
    })
    .unwrap();
    assert!(h.secrets.accounts().is_empty());
}

#[test]
fn unknown_profile_id_is_not_found() {
    let h = Harness::new();
    let err = h
        .core()
        .profile_set_active(ProfileSetActiveArgs {
            id: "p_abcdefghijkl".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn malformed_profile_id_is_invalid_input() {
    let h = Harness::new();
    let err = h
        .core()
        .profile_set_active(ProfileSetActiveArgs {
            id: "../../etc".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
}
