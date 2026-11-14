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

// ---- SEC-3: a stored secret never follows a changed destination -------------------------

fn update(
    core: &Core,
    pid: &str,
    id: &str,
    mut server: McpServerInput,
) -> Result<McpServerView, IpcError> {
    server.id = Some(id.into());
    save(core, pid, server)
}

fn auth(v: Option<&str>) -> Vec<KeyValueInput> {
    vec![secret("Authorization", v)]
}

#[test]
fn changing_the_http_host_requires_secrets_to_be_entered_again() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://mcp.example.com/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    let e = update(
        &core,
        &pid,
        &v.id,
        http("r", "https://evil.example.net/mcp", auth(None)),
    )
    .unwrap_err();
    assert!(
        e.code == ErrorCode::InvalidInput && e.message.contains("again"),
        "{e:?}"
    );
}

#[test]
fn a_rejected_destination_change_modifies_nothing() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://mcp.example.com/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    let _ = update(
        &core,
        &pid,
        &v.id,
        http("r", "https://evil.example.net/mcp", auth(None)),
    );
    let listed = core.mcp_list(ProfileScopeArgs { profile_id: pid }).unwrap();
    assert_eq!(
        listed[0].transport,
        McpTransportView::Http {
            url: "https://mcp.example.com/mcp".into(),
            headers: vec![vision_core::ipc::KeyValueView {
                key: "Authorization".into(),
                value: ValueView::Secret { has_value: true },
            }],
        }
    );
}

#[test]
fn changing_the_http_port_requires_secrets_to_be_entered_again() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://mcp.example.com/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    assert_eq!(
        update(
            &core,
            &pid,
            &v.id,
            http("r", "https://mcp.example.com:8443/mcp", auth(None))
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn changing_the_http_scheme_requires_secrets_to_be_entered_again() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://localhost/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    assert_eq!(
        update(
            &core,
            &pid,
            &v.id,
            http("r", "http://localhost/mcp", auth(None))
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn changing_only_the_http_path_keeps_the_stored_secret() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://mcp.example.com/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    assert!(
        update(
            &core,
            &pid,
            &v.id,
            http("r", "https://mcp.example.com/v2/mcp", auth(None))
        )
        .is_ok()
    );
}

#[test]
fn spelling_the_default_port_keeps_the_stored_secret() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://mcp.example.com/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    assert!(
        update(
            &core,
            &pid,
            &v.id,
            http("r", "https://mcp.example.com:443/mcp", auth(None))
        )
        .is_ok()
    );
}

#[test]
fn a_destination_change_with_new_secret_values_is_allowed() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        http("r", "https://mcp.example.com/mcp", auth(Some(SECRET))),
    )
    .unwrap();
    assert!(
        update(
            &core,
            &pid,
            &v.id,
            http("r", "https://other.example.com/mcp", auth(Some("new")))
        )
        .is_ok()
    );
}

fn stdio_with(command: &str, args: Vec<String>, env: Vec<KeyValueInput>) -> McpServerInput {
    McpServerInput {
        id: None,
        name: "s".into(),
        transport: McpTransportInput::Stdio {
            command: command.into(),
            args,
            env,
        },
        tool_ids: vec![],
        enabled: true,
    }
}

#[test]
fn changing_the_stdio_command_requires_secrets_to_be_entered_again() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio_with("npx", vec![], vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    assert_eq!(
        update(
            &core,
            &pid,
            &v.id,
            stdio_with("uvx", vec![], vec![secret("API_KEY", None)])
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn changing_the_stdio_arguments_requires_secrets_to_be_entered_again() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio_with(
            "npx",
            vec!["a".into()],
            vec![secret("API_KEY", Some(SECRET))],
        ),
    )
    .unwrap();
    assert_eq!(
        update(
            &core,
            &pid,
            &v.id,
            stdio_with("npx", vec!["b".into()], vec![secret("API_KEY", None)])
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn changing_the_transport_kind_requires_secrets_to_be_entered_again() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio_with("npx", vec![], vec![secret("Authorization", Some(SECRET))]),
    )
    .unwrap();
    assert_eq!(
        update(
            &core,
            &pid,
            &v.id,
            http("s", "https://mcp.example.com/mcp", auth(None))
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn editing_only_plain_values_keeps_the_stored_secret() {
    let (_h, core, pid) = setup();
    let v = save(
        &core,
        &pid,
        stdio_with("npx", vec![], vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    assert!(
        update(
            &core,
            &pid,
            &v.id,
            stdio_with(
                "npx",
                vec![],
                vec![secret("API_KEY", None), plain("MODE", "fast")]
            )
        )
        .is_ok()
    );
}

// ---- BUG-9 / SEC-9: deleting a custom tool cleans up after it ---------------------------

fn custom_tool(core: &Core) {
    core.custom_tool_save(vision_core::ipc::CustomToolSaveArgs {
        tool: vision_core::ipc::CustomToolInput {
            id: "kubectl".into(),
            name: "kubectl".into(),
            description: None,
            binary: "kubectl".into(),
            install_url: None,
            config_var: "KUBECTL_CONFIG".into(),
            config_kind: vision_core::ipc::ConfigEnvKind::File,
            login: vec!["login".into()],
            status: None,
            logout: None,
        },
        replace: false,
    })
    .unwrap();
}

fn delete_tool(core: &Core) {
    core.custom_tool_delete(vision_core::ipc::ToolIdArgs {
        tool_id: "kubectl".into(),
    })
    .unwrap();
}

fn sharing(name: &str) -> McpServerInput {
    McpServerInput {
        tool_ids: vec!["kubectl".into(), "gcloud".into()],
        ..stdio(name, vec![])
    }
}

#[test]
fn deleting_a_custom_tool_removes_it_from_every_servers_shared_logins() {
    let (_h, core, pid) = setup();
    custom_tool(&core);
    save(&core, &pid, sharing("s")).unwrap();
    delete_tool(&core);
    let listed = core.mcp_list(ProfileScopeArgs { profile_id: pid }).unwrap();
    assert_eq!(listed[0].tool_ids, vec!["gcloud".to_owned()]);
}

#[test]
fn deleting_a_custom_tool_cleans_servers_in_every_profile() {
    let (_h, core, pid) = setup();
    let other = create_profile(&core, "Personal").id;
    custom_tool(&core);
    save(&core, &pid, sharing("s")).unwrap();
    save(&core, &other, sharing("s")).unwrap();
    delete_tool(&core);
    let listed = core
        .mcp_list(ProfileScopeArgs { profile_id: other })
        .unwrap();
    assert_eq!(listed[0].tool_ids, vec!["gcloud".to_owned()]);
}

#[test]
fn saving_a_server_drops_a_deleted_tool_it_already_had() {
    let (_h, core, pid) = setup();
    custom_tool(&core);
    let v = save(&core, &pid, sharing("s")).unwrap();
    // Simulate an edit form opened before the delete: it still sends the old id.
    let db = core.data_root().profile_db(&pid).unwrap();
    delete_tool(&core);
    let conn = rusqlite::Connection::open(db).unwrap();
    conn.execute(
        "UPDATE mcp_servers SET tool_ids_json = '[\"kubectl\",\"gcloud\"]'",
        [],
    )
    .unwrap();
    let saved = update(&core, &pid, &v.id, sharing("s")).unwrap();
    assert_eq!(saved.tool_ids, vec!["gcloud".to_owned()]);
}

#[test]
fn a_new_unknown_tool_id_is_still_rejected_on_update() {
    let (_h, core, pid) = setup();
    let v = save(&core, &pid, stdio("s", vec![])).unwrap();
    assert_eq!(
        update(
            &core,
            &pid,
            &v.id,
            McpServerInput {
                tool_ids: vec!["nope".into()],
                ..stdio("s", vec![])
            }
        )
        .unwrap_err()
        .code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn deleting_a_custom_tool_removes_its_login_files_in_every_profile() {
    let (_h, core, pid) = setup();
    let other = create_profile(&core, "Personal").id;
    custom_tool(&core);
    let dirs: Vec<std::path::PathBuf> = [&pid, &other]
        .iter()
        .map(|p| core.data_root().tool_dir(p, "kubectl").unwrap())
        .collect();
    for d in &dirs {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("config"), "token: x").unwrap();
    }
    delete_tool(&core);
    assert_eq!(
        dirs.iter().map(|d| d.exists()).collect::<Vec<_>>(),
        vec![false, false]
    );
}

// ---- BUG-11: every stored secret is indexed in app.db ----------------------------------

#[test]
fn a_saved_secret_is_indexed_under_its_profile() {
    let (h, core, pid) = setup();
    save(
        &core,
        &pid,
        stdio("s", vec![secret("API_KEY", Some(SECRET))]),
    )
    .unwrap();
    let conn = rusqlite::Connection::open(h.data_root().join("app.db")).unwrap();
    let rows: Vec<(String, String)> = conn
        .prepare("SELECT account, profile_id FROM secret_index")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        rows.iter()
            .map(|(a, p)| (a.clone(), p.clone()))
            .collect::<Vec<_>>(),
        h.secrets
            .accounts()
            .into_iter()
            .map(|a| (a, pid.clone()))
            .collect::<Vec<_>>()
    );
}

// ---- A1: errors name the field (and the entry) they belong to -----------------------------

fn field_of(server: McpServerInput) -> (Option<String>, Option<String>) {
    let (_h, core, pid) = setup();
    let e = save(&core, &pid, server).unwrap_err();
    (e.field, e.entry_key)
}

#[test]
fn a_bad_name_names_the_name_field() {
    assert_eq!(field_of(stdio("a b", vec![])).0.as_deref(), Some("name"));
}

#[test]
fn a_duplicate_name_names_the_name_field() {
    let (_h, core, pid) = setup();
    save(&core, &pid, stdio("dup", vec![])).unwrap();
    let e = save(&core, &pid, stdio("dup", vec![])).unwrap_err();
    assert_eq!(
        (e.code, e.field.as_deref()),
        (ErrorCode::Conflict, Some("name"))
    );
}

#[test]
fn a_bad_url_names_the_url_field() {
    assert_eq!(
        field_of(http("remote", "http://example.com/mcp", vec![]))
            .0
            .as_deref(),
        Some("url")
    );
}

#[test]
fn a_bad_command_names_the_command_field() {
    let mut s = stdio("cmd", vec![]);
    s.transport = McpTransportInput::Stdio {
        command: "npx -y".into(),
        args: vec![],
        env: vec![],
    };
    assert_eq!(field_of(s).0.as_deref(), Some("command"));
}

#[test]
fn a_bad_argument_names_the_args_field() {
    let mut s = stdio("args", vec![]);
    s.transport = McpTransportInput::Stdio {
        command: "npx".into(),
        args: vec!["a\nb".into()],
        env: vec![],
    };
    assert_eq!(field_of(s).0.as_deref(), Some("args"));
}

#[test]
fn a_duplicate_env_key_names_the_env_field_and_the_key() {
    assert_eq!(
        field_of(stdio("env", vec![plain("A", "1"), plain("A", "2")])),
        (Some("env".to_owned()), Some("A".to_owned()))
    );
}

#[test]
fn a_reserved_header_names_the_headers_field_and_the_key() {
    assert_eq!(
        field_of(http(
            "hdr",
            "https://example.com/mcp",
            vec![plain("Content-Type", "x")]
        )),
        (Some("headers".to_owned()), Some("Content-Type".to_owned()))
    );
}

#[test]
fn a_new_secret_without_a_value_names_its_entry() {
    assert_eq!(
        field_of(stdio("sec", vec![secret("TOKEN", None)])),
        (Some("env".to_owned()), Some("TOKEN".to_owned()))
    );
}

#[test]
fn an_unknown_shared_login_names_the_tool_ids_field() {
    let mut s = stdio("logins", vec![]);
    s.tool_ids = vec!["nope".into()];
    assert_eq!(field_of(s).0.as_deref(), Some("tool_ids"));
}
