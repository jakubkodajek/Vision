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

// ---- BUG-14: name hygiene ----------------------------------------------------------------

#[test]
fn a_name_of_only_zero_width_characters_is_rejected() {
    assert_eq!(
        create_err(&Harness::new().core(), "\u{200b}\u{200b}"),
        ErrorCode::InvalidInput
    );
}

#[test]
fn a_name_with_a_text_direction_override_is_rejected() {
    assert_eq!(
        create_err(&Harness::new().core(), "Work\u{202e}lanosreP"),
        ErrorCode::InvalidInput
    );
}

#[test]
fn a_name_with_a_zero_width_joiner_inside_is_rejected() {
    assert_eq!(
        create_err(&Harness::new().core(), "Wo\u{200d}rk"),
        ErrorCode::InvalidInput
    );
}

#[test]
fn a_decomposed_name_is_stored_in_nfc_form() {
    assert_eq!(
        create_profile(&Harness::new().core(), "Cafe\u{301}").name,
        "Caf\u{e9}"
    );
}

#[test]
fn composed_and_decomposed_spellings_conflict() {
    let core = Harness::new().core();
    create_profile(&core, "Caf\u{e9}");
    assert_eq!(create_err(&core, "Cafe\u{301}"), ErrorCode::Conflict);
}

#[test]
fn a_full_width_spelling_conflicts_with_the_ascii_name() {
    let core = Harness::new().core();
    create_profile(&core, "Work");
    assert_eq!(
        create_err(&core, "\u{ff37}\u{ff4f}\u{ff52}\u{ff4b}"),
        ErrorCode::Conflict
    );
}

#[test]
fn the_length_limit_counts_characters_after_normalisation() {
    let name = "e\u{301}".repeat(40);
    assert_eq!(
        create_profile(&Harness::new().core(), &name)
            .name
            .chars()
            .count(),
        40
    );
}

#[test]
fn delete_accepts_the_name_typed_in_decomposed_form() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Caf\u{e9}");
    assert!(
        core.profile_delete(ProfileDeleteArgs {
            id: p.id,
            confirm_name: "Cafe\u{301}".into(),
        })
        .is_ok()
    );
}

#[test]
fn a_custom_tool_name_with_a_direction_override_is_rejected() {
    let e = Harness::new()
        .core()
        .custom_tool_save(vision_core::ipc::CustomToolSaveArgs {
            tool: vision_core::ipc::CustomToolInput {
                id: "mytool".into(),
                name: "tool\u{202e}exe".into(),
                description: None,
                binary: "mytool".into(),
                install_url: None,
                config_var: "MYTOOL_CONFIG_DIR".into(),
                config_kind: vision_core::ipc::ConfigEnvKind::Dir,
                login: vec!["login".into()],
                status: None,
                logout: None,
            },
        })
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
}

// ---- BUG-10: profile lifecycle -----------------------------------------------------------

fn delete(core: &Core, p: &vision_core::ipc::Profile) -> vision_core::ipc::IpcResult<()> {
    core.profile_delete(ProfileDeleteArgs {
        id: p.id.clone(),
        confirm_name: p.name.clone(),
    })
}

#[test]
fn listing_tools_of_a_deleted_profile_is_not_found() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    delete(&core, &p).unwrap();
    assert_eq!(
        core.tools_list(vision_core::ipc::ProfileScopeArgs {
            profile_id: p.id.clone()
        })
        .unwrap_err()
        .code,
        ErrorCode::NotFound
    );
}

#[test]
fn an_operation_on_a_deleted_profile_does_not_recreate_its_directory() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    delete(&core, &p).unwrap();
    let _ = core.mcp_list(vision_core::ipc::ProfileScopeArgs {
        profile_id: p.id.clone(),
    });
    assert!(!h.data_root().join("profiles").join(&p.id).exists());
}

#[test]
fn deleting_twice_is_not_found() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    delete(&core, &p).unwrap();
    assert_eq!(delete(&core, &p).unwrap_err().code, ErrorCode::NotFound);
}

/// Deletes the profile while a slow MCP health check of it is running.
fn delete_during_probe() -> (Harness, vision_core::ipc::IpcResult<()>, String) {
    let h = Harness::new();
    let pids = h.path("pids.txt");
    h.install_fake(
        "fake-mcp",
        serde_json::json!({"mcp": {"mode": "ok", "init_delay_ms": 1000, "pid_file": pids.to_str().unwrap()}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = core
        .mcp_save(McpSaveArgs {
            profile_id: p.id.clone(),
            server: McpServerInput {
                id: None,
                name: "slow".into(),
                transport: McpTransportInput::Stdio {
                    command: "fake-mcp".into(),
                    args: vec![],
                    env: vec![],
                },
                tool_ids: vec![],
                enabled: true,
            },
        })
        .unwrap();
    let deleted = std::thread::scope(|scope| {
        let probing = scope.spawn(|| {
            core.mcp_test(vision_core::ipc::McpServerArgs {
                profile_id: p.id.clone(),
                server_id: s.id.clone(),
            })
        });
        let started = std::time::Instant::now();
        while !pids.exists() && started.elapsed() < std::time::Duration::from_secs(10) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let deleted = delete(&core, &p);
        let _ = probing.join().unwrap();
        deleted
    });
    (h, deleted, p.id)
}

#[test]
fn deleting_a_profile_during_a_health_check_succeeds() {
    let (_h, deleted, _) = delete_during_probe();
    assert!(deleted.is_ok(), "{deleted:?}");
}

#[test]
fn a_health_check_finishing_during_a_delete_leaves_no_directory_behind() {
    let (h, _, pid) = delete_during_probe();
    assert!(!h.data_root().join("profiles").join(pid).exists());
}

// ---- BUG-11 / startup cleanup: secrets never outlive their profile -----------------------

fn with_secret(h: &Harness, core: &Core) -> vision_core::ipc::Profile {
    let p = create_profile(core, "Work");
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
    p
}

#[test]
fn delete_removes_secrets_even_when_the_profile_database_is_corrupt() {
    let h = Harness::new();
    let core = h.core();
    let p = with_secret(&h, &core);
    drop(core);
    let dir = h.data_root().join("profiles").join(&p.id);
    for f in ["profile.db-wal", "profile.db-shm"] {
        let _ = std::fs::remove_file(dir.join(f));
    }
    std::fs::write(dir.join("profile.db"), b"this is not a database").unwrap();
    delete(&h.core(), &p).unwrap();
    assert!(h.secrets.accounts().is_empty());
}

#[test]
fn delete_succeeds_when_the_credential_store_is_unavailable() {
    let h = Harness::new();
    let core = h.core();
    let p = with_secret(&h, &core);
    h.secrets.set_unavailable(true);
    assert!(delete(&core, &p).is_ok());
}

#[test]
fn secrets_left_by_an_unavailable_store_are_deleted_on_the_next_start() {
    let h = Harness::new();
    let core = h.core();
    let p = with_secret(&h, &core);
    h.secrets.set_unavailable(true);
    delete(&core, &p).unwrap();
    drop(core);
    h.secrets.set_unavailable(false);
    h.core();
    assert!(h.secrets.accounts().is_empty());
}

/// Removes the profile row behind the core's back, as a crash in the middle of a delete
/// would.
fn orphan(h: &Harness, p: &vision_core::ipc::Profile) {
    let conn = Connection::open(h.data_root().join("app.db")).unwrap();
    conn.execute("DELETE FROM profiles WHERE id = ?1", [&p.id])
        .unwrap();
}

#[test]
fn startup_removes_a_profile_directory_without_a_row() {
    let h = Harness::new();
    let core = h.core();
    let p = with_secret(&h, &core);
    drop(core);
    orphan(&h, &p);
    h.core();
    assert!(!h.data_root().join("profiles").join(&p.id).exists());
}

#[test]
fn startup_removes_the_secrets_of_a_profile_without_a_row() {
    let h = Harness::new();
    let core = h.core();
    let p = with_secret(&h, &core);
    drop(core);
    orphan(&h, &p);
    h.core();
    assert!(h.secrets.accounts().is_empty());
}

#[test]
fn startup_leaves_directories_that_are_not_profile_ids_alone() {
    let h = Harness::new();
    drop(h.core());
    let stray = h.data_root().join("profiles").join("notes");
    std::fs::create_dir_all(&stray).unwrap();
    h.core();
    assert!(stray.is_dir());
}

#[test]
fn startup_keeps_existing_profiles_and_their_secrets() {
    let h = Harness::new();
    let core = h.core();
    let p = with_secret(&h, &core);
    drop(core);
    h.core();
    assert_eq!(
        (
            h.data_root().join("profiles").join(&p.id).is_dir(),
            h.secrets.accounts().len()
        ),
        (true, 1)
    );
}

#[test]
fn a_secret_saved_while_the_profile_is_deleted_is_not_orphaned() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    std::thread::scope(|scope| {
        let saving = scope.spawn(|| {
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
                                value: Some(SecretString::new("Bearer racing")),
                            },
                        }],
                    },
                    tool_ids: vec![],
                    enabled: true,
                },
            })
        });
        delete(&core, &p).unwrap();
        let _ = saving.join().unwrap();
    });
    assert!(h.secrets.accounts().is_empty());
}
