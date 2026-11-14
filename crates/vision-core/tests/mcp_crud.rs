//! AC8: MCP CRUD with validation; secrets never appear in IPC responses or `profile.db`.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use common::{Harness, create_profile};
use vision_core::Core;
use vision_core::ipc::{
    ErrorCode, IpcError, KeyValueInput, McpSaveArgs, McpServerArgs, McpServerInput, McpServerView,
    McpTransportInput, McpTransportView, ProfileScopeArgs, ValueInput, ValueView,
};
use vision_core::secrets::SecretString;

const SECRET: &str = "s3cr3t-VALUE-must-not-leak-9f8e7d";

fn secret(key: &str, v: Option<&str>) -> KeyValueInput {
    KeyValueInput {
        key: key.into(),
        value: ValueInput::Secret {
            value: v.map(SecretString::new),
        },
    }
}

fn plain(key: &str, v: &str) -> KeyValueInput {
    KeyValueInput {
        key: key.into(),
        value: ValueInput::Plain { value: v.into() },
    }
}

fn stdio(name: &str, env: Vec<KeyValueInput>) -> McpServerInput {
    McpServerInput {
        id: None,
        name: name.into(),
        transport: McpTransportInput::Stdio {
            command: "npx".into(),
            args: vec!["-y".into(), "@example/server".into()],
            env,
        },
        tool_ids: vec![],
        enabled: true,
    }
}

fn http(name: &str, url: &str, headers: Vec<KeyValueInput>) -> McpServerInput {
    McpServerInput {
        id: None,
        name: name.into(),
        transport: McpTransportInput::Http {
            url: url.into(),
            headers,
        },
        tool_ids: vec![],
        enabled: true,
    }
}

fn setup() -> (Harness, Core, String) {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    (h, core, p.id)
}

fn save(core: &Core, pid: &str, server: McpServerInput) -> Result<McpServerView, IpcError> {
    core.mcp_save(McpSaveArgs {
        profile_id: pid.into(),
        server,
    })
}

fn err(core: &Core, pid: &str, server: McpServerInput) -> ErrorCode {
    save(core, pid, server).unwrap_err().code
}

fn profile_db_bytes(core: &Core, pid: &str) -> Vec<u8> {
    let dir = core.data_root().profile_dir(pid).unwrap();
    let mut all = Vec::new();
    for f in ["profile.db", "profile.db-wal", "profile.db-shm"] {
        all.extend(std::fs::read(dir.join(f)).unwrap_or_default());
    }
    all
}

fn contains(hay: &[u8], needle: &str) -> bool {
    hay.windows(needle.len()).any(|w| w == needle.as_bytes())
}

#[test]
fn stdio_server_is_created_and_listed() {
    let (_h, core, pid) = setup();
    let v = save(&core, &pid, stdio("files", vec![plain("ROOT", "/tmp")])).unwrap();
    let list = core.mcp_list(ProfileScopeArgs { profile_id: pid }).unwrap();
    assert_eq!(list, vec![v]);
}

#[test]
fn http_server_is_created_with_untested_health() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("remote", "https://mcp.example.com/mcp", vec![]),
    )
    .unwrap();
    assert_eq!(v.health.status, vision_core::ipc::McpHealthStatus::Untested);
}

#[test]
fn server_can_be_updated_by_id() {
    let (_h, core, pid) = setup();
    let v = save(&core, &pid, stdio("files", vec![])).unwrap();
    let u = save(
        &core,
        &pid,
        McpServerInput {
            id: Some(v.id.clone()),
            name: "files2".into(),
            ..stdio("x", vec![])
        },
    )
    .unwrap();
    assert_eq!((u.id, u.name.as_str()), (v.id, "files2"));
}

#[test]
fn updating_an_unknown_id_is_not_found() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(
            &core,
            &pid,
            McpServerInput {
                id: Some("m_abcdefghijkl".into()),
                ..stdio("a", vec![])
            }
        ),
        ErrorCode::NotFound
    );
}

#[test]
fn server_can_be_deleted() {
    let (_h, core, pid) = setup();
    let v = save(&core, &pid, stdio("files", vec![])).unwrap();
    core.mcp_delete(McpServerArgs {
        profile_id: pid.clone(),
        server_id: v.id,
    })
    .unwrap();
    assert!(
        core.mcp_list(ProfileScopeArgs { profile_id: pid })
            .unwrap()
            .is_empty()
    );
}

#[test]
fn name_with_a_space_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(&core, &pid, stdio("my server", vec![])),
        ErrorCode::InvalidInput
    );
}

#[test]
fn name_starting_with_a_dash_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(&core, &pid, stdio("--scope", vec![])),
        ErrorCode::InvalidInput
    );
}

#[test]
fn name_longer_than_64_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(&core, &pid, stdio(&"a".repeat(65), vec![])),
        ErrorCode::InvalidInput
    );
}

#[test]
fn duplicate_name_in_a_profile_conflicts() {
    let (_h, core, pid) = setup();
    save(&core, &pid, stdio("files", vec![])).unwrap();
    assert_eq!(
        err(&core, &pid, http("files", "https://x.example", vec![])),
        ErrorCode::Conflict
    );
}

#[test]
fn same_name_in_another_profile_is_allowed() {
    let (_h, core, pid) = setup();
    let other = create_profile(&core, "Personal");
    save(&core, &pid, stdio("files", vec![])).unwrap();
    assert!(save(&core, &other.id, stdio("files", vec![])).is_ok());
}

#[test]
fn plain_http_url_to_a_remote_host_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(&core, &pid, http("r", "http://mcp.example.com/mcp", vec![])),
        ErrorCode::InvalidInput
    );
}

#[test]
fn plain_http_url_to_localhost_is_allowed() {
    let (_h, core, pid) = setup();
    assert!(save(&core, &pid, http("r", "http://127.0.0.1:3000/mcp", vec![])).is_ok());
}

#[test]
fn reserved_header_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(
            &core,
            &pid,
            http("r", "https://x.example", vec![plain("Mcp-Session-Id", "x")])
        ),
        ErrorCode::InvalidInput
    );
}

#[test]
fn duplicate_env_key_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(
            &core,
            &pid,
            stdio("s", vec![plain("A", "1"), plain("A", "2")])
        ),
        ErrorCode::InvalidInput
    );
}

#[test]
fn command_with_arguments_inline_is_rejected() {
    let (_h, core, pid) = setup();
    let s = McpServerInput {
        transport: McpTransportInput::Stdio {
            command: "npx -y server".into(),
            args: vec![],
            env: vec![],
        },
        ..stdio("s", vec![])
    };
    assert_eq!(err(&core, &pid, s), ErrorCode::InvalidInput);
}

#[test]
fn unknown_tool_id_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(
            &core,
            &pid,
            McpServerInput {
                tool_ids: vec!["nope".into()],
                ..stdio("s", vec![])
            }
        ),
        ErrorCode::InvalidInput
    );
}

#[test]
fn secret_is_stored_in_the_credential_store_under_the_spec_account() {
    let (h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio("s", vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    assert_eq!(
        h.secrets.accounts(),
        vec![format!("mcp/{pid}/{}/env/API_KEY", v.id)]
    );
}

#[test]
fn secret_value_never_appears_in_ipc_responses() {
    let (_h, core, pid) = setup();
    let saved = save(
        &core,
        &pid,
        http(
            "r",
            "http://127.0.0.1:9/mcp",
            vec![secret("Authorization", Some(SECRET))],
        ),
    )
    .unwrap();
    let listed = core
        .mcp_list(ProfileScopeArgs {
            profile_id: pid.clone(),
        })
        .unwrap();
    let tested = core
        .mcp_test(McpServerArgs {
            profile_id: pid,
            server_id: saved.id.clone(),
        })
        .unwrap();
    let json = serde_json::to_string(&(saved, listed, tested)).unwrap();
    assert!(!json.contains(SECRET));
    assert!(json.contains("\"has_value\":true"));
}

#[test]
fn secret_value_never_appears_in_profile_db() {
    let (_h, core, pid) = setup();
    save(
        &core,
        &pid,
        stdio(
            "s",
            vec![secret("API_KEY", Some(SECRET)), plain("PLAIN", "visible")],
        ),
    )
    .unwrap();
    let bytes = profile_db_bytes(&core, &pid);
    assert!(
        contains(&bytes, "visible"),
        "sanity: plain values are stored"
    );
    assert!(!contains(&bytes, SECRET));
}

#[test]
fn omitted_secret_value_keeps_the_stored_one() {
    let (h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio("s", vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    save(
        &core,
        &pid,
        McpServerInput {
            id: Some(v.id.clone()),
            ..stdio("s", vec![secret("API_KEY", None)])
        },
    )
    .unwrap();
    let account = format!("mcp/{pid}/{}/env/API_KEY", v.id);
    use vision_core::secrets::SecretStore;
    assert_eq!(h.secrets.get(&account).unwrap().unwrap().expose(), SECRET);
}

#[test]
fn omitted_secret_value_for_a_new_key_is_rejected() {
    let (_h, core, pid) = setup();
    assert_eq!(
        err(&core, &pid, stdio("s", vec![secret("API_KEY", None)])),
        ErrorCode::InvalidInput
    );
}

#[test]
fn removing_a_secret_entry_deletes_it_from_the_store() {
    let (h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio("s", vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    save(
        &core,
        &pid,
        McpServerInput {
            id: Some(v.id),
            ..stdio("s", vec![])
        },
    )
    .unwrap();
    assert!(h.secrets.accounts().is_empty());
}

#[test]
fn unavailable_store_fails_with_secret_store_unavailable_and_writes_nothing() {
    let (h, core, pid) = setup();
    h.secrets.set_unavailable(true);
    let e = err(
        &core,
        &pid,
        stdio("s", vec![secret("API_KEY", Some(SECRET))]),
    );
    assert_eq!(e, ErrorCode::SecretStoreUnavailable);
    assert!(
        core.mcp_list(ProfileScopeArgs {
            profile_id: pid.clone()
        })
        .unwrap()
        .is_empty()
    );
    assert!(!contains(&profile_db_bytes(&core, &pid), SECRET));
}

#[test]
fn deleting_a_server_deletes_its_secrets() {
    let (h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http(
            "r",
            "https://x.example",
            vec![secret("Authorization", Some(SECRET))],
        ),
    )
    .unwrap();
    core.mcp_delete(McpServerArgs {
        profile_id: pid,
        server_id: v.id,
    })
    .unwrap();
    assert!(h.secrets.accounts().is_empty());
}

#[test]
fn secret_entries_are_shown_only_as_has_value() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio("s", vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    let McpTransportView::Stdio { env, .. } = v.transport else {
        panic!("stdio expected")
    };
    assert_eq!(env[0].value, ValueView::Secret { has_value: true });
}

#[test]
fn invalid_value_error_does_not_echo_the_value() {
    let (_h, core, pid) = setup();
    let bad = format!("{SECRET}\r\nInjected: 1");
    let e = save(
        &core,
        &pid,
        http(
            "r",
            "https://x.example",
            vec![secret("Authorization", Some(&bad))],
        ),
    )
    .unwrap_err();
    assert!(!e.message.contains(SECRET));
}
