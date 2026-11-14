//! AC10: `mcp_render_claude_config` matches golden files; sync runs the expected
//! `claude mcp` argv with the profile environment (recording runner).
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use common::{Harness, RecordingRunner, assert_no_leaks, create_profile};
use serde_json::{Value, json};
use vision_core::ipc::{
    ErrorCode, KeyValueInput, McpSaveArgs, McpServerArgs, McpServerInput, McpTransportInput,
    ProfileScopeArgs, ValueInput,
};
use vision_core::mcp::{ResolvedServer, ResolvedTransport, render_claude_config};
use vision_core::process::CommandSpec;
use vision_core::secrets::SecretString;

fn golden(name: &str) -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn stdio_config_matches_golden_file() {
    let s = ResolvedServer {
        name: "files".into(),
        transport: ResolvedTransport::Stdio {
            command: "npx".into(),
            args: vec![
                "-y".into(),
                "@modelcontextprotocol/server-filesystem".into(),
                "/data".into(),
            ],
            env: vec![
                (
                    "CLOUDSDK_CONFIG".into(),
                    "/vision/profiles/p_abcdefghijkl/tools/gcloud".into(),
                ),
                ("API_KEY".into(), "value-1".into()),
            ],
        },
    };
    assert_eq!(
        render_claude_config(&[s]),
        golden("claude_config_stdio.json")
    );
}

#[test]
fn http_config_matches_golden_file() {
    let s = ResolvedServer {
        name: "remote".into(),
        transport: ResolvedTransport::Http {
            url: "https://mcp.example.com/mcp".into(),
            headers: vec![("Authorization".into(), "Bearer token-1".into())],
        },
    };
    assert_eq!(
        render_claude_config(&[s]),
        golden("claude_config_http.json")
    );
}

#[test]
fn empty_profile_renders_an_empty_server_map() {
    assert_eq!(render_claude_config(&[]), json!({"mcpServers": {}}));
}

// ---- through the core ------------------------------------------------------------------

struct Setup {
    h: Harness,
    runner: Arc<RecordingRunner>,
    core: vision_core::Core,
    pid: String,
}

fn setup() -> Setup {
    let mut h = Harness::new();
    let runner = Arc::new(RecordingRunner::default());
    h.runner = runner.clone();
    h.install_fake("claude", json!({}));
    let core = h.core();
    let pid = create_profile(&core, "Work").id;
    Setup {
        h,
        runner,
        core,
        pid,
    }
}

fn save(s: &Setup, name: &str, enabled: bool, secret: &str) -> String {
    s.core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: None,
                name: name.into(),
                transport: McpTransportInput::Stdio {
                    command: "npx".into(),
                    args: vec!["-y".into(), "srv".into()],
                    env: vec![KeyValueInput {
                        key: "API_KEY".into(),
                        value: ValueInput::Secret {
                            value: Some(SecretString::new(secret)),
                        },
                    }],
                },
                tool_ids: vec!["gcloud".into()],
                enabled,
            },
        })
        .unwrap()
        .id
}

fn argvs(calls: &[CommandSpec]) -> Vec<Vec<String>> {
    calls
        .iter()
        .map(|c| {
            c.args
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        })
        .collect()
}

#[test]
fn core_render_includes_tool_variables_and_resolved_secrets_for_enabled_servers() {
    let s = setup();
    save(&s, "on", true, "k-1");
    save(&s, "off", false, "k-2");
    let cfg = s.core.mcp_render_claude_config(&s.pid).unwrap();
    let gcloud = s.core.data_root().tool_dir(&s.pid, "gcloud").unwrap();
    assert_eq!(
        cfg,
        json!({"mcpServers": {"on": {"command": "npx", "args": ["-y", "srv"],
            "env": {"CLOUDSDK_CONFIG": gcloud.to_string_lossy(), "API_KEY": "k-1"}}}})
    );
}

#[test]
fn sync_removes_then_adds_each_enabled_server_in_user_scope() {
    let s = setup();
    save(&s, "files", true, "k-1");
    let report = s
        .core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    let calls = s.runner.calls.lock().unwrap();
    let a = argvs(&calls);
    let entry: Value = serde_json::from_str(&a[1][5]).unwrap();
    assert_eq!(report.synced, vec!["files".to_owned()]);
    assert_eq!(a[0], ["mcp", "remove", "--scope", "user", "files"]);
    assert_eq!(&a[1][..5], ["mcp", "add-json", "--scope", "user", "files"]);
    assert_eq!(entry["env"]["API_KEY"], "k-1");
    assert_eq!(
        calls[0].program,
        s.h.bin_dir()
            .join(format!("claude{}", std::env::consts::EXE_SUFFIX))
    );
}

#[test]
fn sync_runs_claude_with_the_profile_environment_only() {
    let s = setup();
    save(&s, "files", true, "k-1");
    s.core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    let calls = s.runner.calls.lock().unwrap();
    let dir = s.core.data_root().tool_dir(&s.pid, "claude").unwrap();
    let env = &calls[1].env;
    assert!(env.contains(&(OsString::from("CLAUDE_CONFIG_DIR"), dir.into_os_string())));
    assert_no_leaks(&format!("{env:?}"));
}

#[test]
fn sync_removes_managed_servers_that_were_deleted() {
    let s = setup();
    let id = save(&s, "files", true, "k-1");
    s.core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    s.core
        .mcp_delete(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap();
    s.runner.calls.lock().unwrap().clear();
    let report = s
        .core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    assert_eq!(report.removed, vec!["files".to_owned()]);
    assert_eq!(
        argvs(&s.runner.calls.lock().unwrap()),
        vec![vec!["mcp", "remove", "--scope", "user", "files"]]
    );
}

#[test]
fn sync_never_touches_names_vision_does_not_manage() {
    let s = setup();
    save(&s, "off", false, "k");
    let report = s
        .core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    assert!(report.removed.is_empty() && report.synced.is_empty());
    assert!(s.runner.calls.lock().unwrap().is_empty());
}

#[test]
fn sync_without_claude_installed_is_not_installed() {
    let mut h = Harness::new();
    h.runner = Arc::new(RecordingRunner::default());
    let core = h.core();
    let p = create_profile(&core, "Work");
    let e = core
        .mcp_sync_claude(ProfileScopeArgs { profile_id: p.id })
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotInstalled);
}

#[test]
fn authorize_opens_claude_mcp_login_in_the_terminal() {
    let s = setup();
    let id = s
        .core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: None,
                name: "remote".into(),
                transport: McpTransportInput::Http {
                    url: "https://mcp.example.com/mcp".into(),
                    headers: vec![],
                },
                tool_ids: vec![],
                enabled: true,
            },
        })
        .unwrap()
        .id;
    s.core
        .mcp_authorize(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap();
    let content = &s.h.launches()[0].content;
    assert!(
        content.contains("'mcp' \\\n  'login' \\\n  'remote'") || cfg!(windows),
        "{content}"
    );
}

#[test]
fn authorize_for_a_stdio_server_is_invalid_input() {
    let s = setup();
    let id = save(&s, "files", true, "k");
    let e = s
        .core
        .mcp_authorize(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
}
