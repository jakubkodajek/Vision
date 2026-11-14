//! AC10: `mcp_render_claude_config` matches golden files; sync runs the expected
//! `claude mcp` argv with the profile environment (recording runner).
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use common::{Harness, RecordingRunner, assert_no_leaks, create_profile};
use serde_json::{Value, json};
use vision_core::ipc::IpcResult;
use vision_core::ipc::{
    ErrorCode, KeyValueInput, McpSaveArgs, McpServerArgs, McpServerInput, McpTransportInput,
    ProfileScopeArgs, ValueInput,
};
use vision_core::mcp::{ResolvedServer, ResolvedTransport, render_claude_config};
use vision_core::process::{CommandOutput, CommandRunner, CommandSpec};
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

/// Like [`save`] with a plain value: servers with secrets are never synced (SEC-2).
fn save_plain(s: &Setup, name: &str, enabled: bool, value: &str) -> String {
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
                        value: ValueInput::Plain {
                            value: value.into(),
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

fn sync(s: &Setup) -> vision_core::ipc::SyncReport {
    s.core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap()
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
    save_plain(&s, "files", true, "k-1");
    sync(&s);
    s.runner.calls.lock().unwrap().clear();
    let report = sync(&s);
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
    save_plain(&s, "files", true, "k-1");
    sync(&s);
    let calls = s.runner.calls.lock().unwrap();
    let dir = s.core.data_root().tool_dir(&s.pid, "claude").unwrap();
    let env = &calls[0].env;
    assert!(env.contains(&(OsString::from("CLAUDE_CONFIG_DIR"), dir.into_os_string())));
    assert_no_leaks(&format!("{env:?}"));
}

#[test]
fn sync_removes_managed_servers_that_were_deleted() {
    let s = setup();
    let id = save_plain(&s, "files", true, "k-1");
    sync(&s);
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

// ---- SEC-2 / SEC-6 / BUG-12: what sync never does --------------------------------------

#[test]
fn server_with_a_secret_is_skipped() {
    let s = setup();
    save(&s, "files", true, "k-1");
    let report = sync(&s);
    assert_eq!(
        report
            .skipped
            .iter()
            .map(|k| k.name.as_str())
            .collect::<Vec<_>>(),
        vec!["files"]
    );
}

#[test]
fn server_with_a_secret_runs_no_claude_command() {
    let s = setup();
    save(&s, "files", true, "k-1");
    sync(&s);
    assert!(s.runner.calls.lock().unwrap().is_empty());
}

#[test]
fn no_recorded_argv_contains_a_secret_value() {
    let s = setup();
    save(&s, "secret-one", true, "TOPSECRET-1234");
    save_plain(&s, "plain-one", true, "visible");
    sync(&s);
    let all = format!("{:?}", argvs(&s.runner.calls.lock().unwrap()));
    assert!(!all.contains("TOPSECRET-1234"), "{all}");
}

#[test]
fn a_synced_server_that_gains_a_secret_is_removed_from_claude_code() {
    let s = setup();
    let id = save_plain(&s, "files", true, "k-1");
    sync(&s);
    s.core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: Some(id),
                name: "files".into(),
                transport: McpTransportInput::Stdio {
                    command: "npx".into(),
                    args: vec!["-y".into(), "srv".into()],
                    env: vec![KeyValueInput {
                        key: "API_KEY".into(),
                        value: ValueInput::Secret {
                            value: Some(SecretString::new("now-secret")),
                        },
                    }],
                },
                tool_ids: vec!["gcloud".into()],
                enabled: true,
            },
        })
        .unwrap();
    s.runner.calls.lock().unwrap().clear();
    let report = sync(&s);
    assert_eq!(
        (report.removed, argvs(&s.runner.calls.lock().unwrap())),
        (
            vec!["files".to_owned()],
            vec![vec![
                "mcp".to_owned(),
                "remove".into(),
                "--scope".into(),
                "user".into(),
                "files".into()
            ]]
        )
    );
}

#[test]
fn first_sync_of_a_new_name_only_adds_it() {
    let s = setup();
    save_plain(&s, "files", true, "k-1");
    sync(&s);
    let a = argvs(&s.runner.calls.lock().unwrap());
    assert_eq!(
        (a.len(), &a[0][..2]),
        (1, &["mcp".to_owned(), "add-json".to_owned()][..])
    );
}

/// Answers `claude mcp <verb>` with a fixed output per verb (exit 0 otherwise).
#[derive(Default)]
struct ScriptedRunner {
    calls: std::sync::Mutex<Vec<CommandSpec>>,
    answers: std::sync::Mutex<Vec<(String, CommandOutput)>>,
}

impl ScriptedRunner {
    fn answer(&self, verb: &str, exit: i32, stderr: &str) {
        self.answers.lock().unwrap().push((
            verb.to_owned(),
            CommandOutput {
                exit_code: Some(exit),
                stderr: stderr.as_bytes().to_vec(),
                ..CommandOutput::default()
            },
        ));
    }
}

impl CommandRunner for ScriptedRunner {
    fn run(&self, spec: &CommandSpec) -> IpcResult<CommandOutput> {
        self.calls.lock().unwrap().push(spec.clone());
        let verb = spec
            .args
            .get(1)
            .map(|a| a.to_string_lossy().into_owned())
            .unwrap_or_default();
        Ok(self
            .answers
            .lock()
            .unwrap()
            .iter()
            .find(|(v, _)| *v == verb)
            .map(|(_, o)| o.clone())
            .unwrap_or(CommandOutput {
                exit_code: Some(0),
                ..CommandOutput::default()
            }))
    }
}

struct Scripted {
    runner: Arc<ScriptedRunner>,
    core: vision_core::Core,
    pid: String,
    _h: Harness,
}

fn scripted() -> Scripted {
    let mut h = Harness::new();
    let runner = Arc::new(ScriptedRunner::default());
    h.runner = runner.clone();
    h.install_fake("claude", json!({}));
    let core = h.core();
    let pid = create_profile(&core, "Work").id;
    Scripted {
        runner,
        core,
        pid,
        _h: h,
    }
}

fn scripted_save(s: &Scripted, name: &str, enabled: bool) -> String {
    s.core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: None,
                name: name.into(),
                transport: McpTransportInput::Stdio {
                    command: "npx".into(),
                    args: vec![],
                    env: vec![],
                },
                tool_ids: vec![],
                enabled,
            },
        })
        .unwrap()
        .id
}

fn scripted_sync(s: &Scripted) -> vision_core::ipc::SyncReport {
    s.core
        .mcp_sync_claude(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap()
}

const EXISTS: &str = "MCP server files already exists in user config\n";
const MISSING: &str = "No MCP server named \"files\" in user scope\n";

#[test]
fn an_existing_name_vision_did_not_add_is_reported_as_a_conflict() {
    let s = scripted();
    s.runner.answer("add-json", 1, EXISTS);
    scripted_save(&s, "files", true);
    let report = scripted_sync(&s);
    assert!(
        report.failed.len() == 1 && report.failed[0].message.contains("did not add"),
        "{report:?}"
    );
}

#[test]
fn an_existing_name_vision_did_not_add_is_never_removed() {
    let s = scripted();
    s.runner.answer("add-json", 1, EXISTS);
    scripted_save(&s, "files", true);
    scripted_sync(&s);
    let verbs: Vec<String> = argvs(&s.runner.calls.lock().unwrap())
        .into_iter()
        .map(|a| a[1].clone())
        .collect();
    assert_eq!(verbs, vec!["add-json".to_owned()]);
}

#[test]
fn a_conflicting_name_is_not_tracked_as_managed() {
    let s = scripted();
    s.runner.answer("add-json", 1, EXISTS);
    let id = scripted_save(&s, "files", true);
    scripted_sync(&s);
    s.core
        .mcp_delete(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap();
    s.runner.calls.lock().unwrap().clear();
    scripted_sync(&s);
    assert!(s.runner.calls.lock().unwrap().is_empty());
}

#[test]
fn a_failed_remove_is_reported_and_stays_tracked() {
    let s = scripted();
    let id = scripted_save(&s, "files", true);
    scripted_sync(&s);
    s.core
        .mcp_delete(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap();
    s.runner
        .answer("remove", 1, "Error: config file is locked\n");
    let first = scripted_sync(&s);
    s.runner.answers.lock().unwrap().clear();
    let second = scripted_sync(&s);
    assert_eq!(
        (first.failed.len(), first.removed.len(), second.removed),
        (1, 0, vec!["files".to_owned()])
    );
}

#[test]
fn a_remove_of_a_name_claude_code_no_longer_has_counts_as_done() {
    let s = scripted();
    let id = scripted_save(&s, "files", true);
    scripted_sync(&s);
    s.core
        .mcp_delete(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap();
    s.runner.answer("remove", 1, MISSING);
    assert_eq!(scripted_sync(&s).removed, vec!["files".to_owned()]);
}

#[test]
fn a_failed_remove_message_includes_the_cli_output_redacted() {
    let s = scripted();
    let id = scripted_save(&s, "files", true);
    scripted_sync(&s);
    s.core
        .mcp_delete(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: id,
        })
        .unwrap();
    s.runner
        .answer("remove", 1, "Error: bad token sk-ant-api03-abcdefgh1234\n");
    let msg = scripted_sync(&s).failed[0].message.clone();
    assert!(
        msg.contains("bad token") && !msg.contains("abcdefgh1234"),
        "{msg}"
    );
}

#[test]
fn a_failed_update_remove_skips_the_add_and_reports_it() {
    let s = scripted();
    scripted_save(&s, "files", true);
    scripted_sync(&s);
    s.runner
        .answer("remove", 1, "Error: config file is locked\n");
    s.runner.calls.lock().unwrap().clear();
    let report = scripted_sync(&s);
    let verbs: Vec<String> = argvs(&s.runner.calls.lock().unwrap())
        .into_iter()
        .map(|a| a[1].clone())
        .collect();
    assert_eq!((verbs, report.failed.len()), (vec!["remove".to_owned()], 1));
}
