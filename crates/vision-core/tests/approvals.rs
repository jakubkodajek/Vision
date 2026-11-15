//! SEC-1 / AC15: headless execution of user-defined commands (custom tools, stdio MCP
//! servers) requires a native confirmation; a declined confirmation runs nothing, a changed
//! definition asks again, built-in tools never ask and `tools_list` never asks or spawns.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use common::{Harness, create_profile};
use serde_json::json;
use vision_core::Core;
use vision_core::ipc::{
    ConfigEnvKind, CustomToolInput, CustomToolSaveArgs, ErrorCode, IpcResult, McpSaveArgs,
    McpServerArgs, McpServerInput, McpServerView, McpTransportInput, ProfileScopeArgs, ToolArgs,
    ToolIdArgs, ToolView,
};

fn kube() -> CustomToolInput {
    CustomToolInput {
        id: "kubectl".into(),
        name: "kubectl".into(),
        description: None,
        binary: "kubectl".into(),
        install_url: None,
        config_var: "KUBECTL_CONFIG".into(),
        config_kind: ConfigEnvKind::File,
        login: vec!["config".into(), "view".into()],
        status: Some(vec!["config".into(), "current-context".into()]),
        logout: None,
    }
}

struct Setup {
    h: Harness,
    core: Core,
    pid: String,
}

/// A harness with a fake `kubectl` that logs every invocation, and the custom tool saved.
fn setup() -> Setup {
    let h = Harness::new();
    let log = h.path("args.txt");
    h.install_fake(
        "kubectl",
        json!({"log_args": log.to_str().unwrap(), "default": {"exit": 0}}),
    );
    let core = h.core();
    let pid = create_profile(&core, "Work").id;
    core.custom_tool_save(CustomToolSaveArgs {
        tool: kube(),
        replace: false,
    })
    .unwrap();
    Setup { h, core, pid }
}

fn check(s: &Setup, tool: &str) -> IpcResult<ToolView> {
    s.core.tool_check(ToolArgs {
        profile_id: s.pid.clone(),
        tool_id: tool.into(),
    })
}

fn ran(s: &Setup) -> bool {
    s.h.path("args.txt").exists()
}

#[test]
fn custom_tool_check_asks_for_confirmation_first() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    assert_eq!(s.h.confirmer.count(), 1);
}

#[test]
fn declined_custom_tool_check_is_not_approved() {
    let s = setup();
    s.h.confirmer.set_decline(true);
    assert_eq!(
        check(&s, "kubectl").unwrap_err().code,
        ErrorCode::NotApproved
    );
}

#[test]
fn declined_custom_tool_check_runs_nothing() {
    let s = setup();
    s.h.confirmer.set_decline(true);
    let _ = check(&s, "kubectl");
    assert!(!ran(&s));
}

#[test]
fn approved_custom_tool_runs_after_confirmation() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    assert!(ran(&s));
}

#[test]
fn approved_custom_tool_is_not_asked_again() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    check(&s, "kubectl").unwrap();
    assert_eq!(s.h.confirmer.count(), 1);
}

#[test]
fn approval_survives_a_restart() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    drop(s.core);
    let core = s.h.core();
    core.tool_check(ToolArgs {
        profile_id: s.pid.clone(),
        tool_id: "kubectl".into(),
    })
    .unwrap();
    assert_eq!(s.h.confirmer.count(), 1);
}

#[test]
fn changed_custom_tool_definition_asks_again() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    s.core
        .custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                status: Some(vec!["version".into()]),
                ..kube()
            },
            replace: true,
        })
        .unwrap();
    check(&s, "kubectl").unwrap();
    assert_eq!(s.h.confirmer.count(), 2);
}

#[test]
fn renaming_a_custom_tool_does_not_ask_again() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    s.core
        .custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                name: "Kubernetes CLI".into(),
                ..kube()
            },
            replace: true,
        })
        .unwrap();
    check(&s, "kubectl").unwrap();
    assert_eq!(s.h.confirmer.count(), 1);
}

#[test]
fn deleting_a_custom_tool_forgets_its_approval() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    s.core
        .custom_tool_delete(ToolIdArgs {
            tool_id: "kubectl".into(),
        })
        .unwrap();
    s.core
        .custom_tool_save(CustomToolSaveArgs {
            tool: kube(),
            replace: false,
        })
        .unwrap();
    check(&s, "kubectl").unwrap();
    assert_eq!(s.h.confirmer.count(), 2);
}

#[test]
fn builtin_tool_check_never_asks() {
    let s = setup();
    s.h.install_fake("gh", json!({"default": {"exit": 0}}));
    check(&s, "gh").unwrap();
    assert_eq!(s.h.confirmer.count(), 0);
}

#[test]
fn tools_list_never_asks() {
    let s = setup();
    s.core
        .tools_list(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    assert_eq!(s.h.confirmer.count(), 0);
}

#[test]
fn tools_list_with_a_custom_tool_runs_nothing() {
    let s = setup();
    s.core
        .tools_list(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    assert!(!ran(&s));
}

#[test]
fn missing_custom_tool_binary_does_not_ask() {
    let h = Harness::new();
    let core = h.core();
    let pid = create_profile(&core, "Work").id;
    core.custom_tool_save(CustomToolSaveArgs {
        tool: kube(),
        replace: false,
    })
    .unwrap();
    core.tool_check(ToolArgs {
        profile_id: pid,
        tool_id: "kubectl".into(),
    })
    .unwrap();
    assert_eq!(h.confirmer.count(), 0);
}

#[test]
fn declined_custom_tool_sign_in_opens_no_terminal() {
    let s = setup();
    s.h.confirmer.set_decline(true);
    let e = s
        .core
        .tool_sign_in(ToolArgs {
            profile_id: s.pid.clone(),
            tool_id: "kubectl".into(),
        })
        .unwrap_err();
    assert_eq!((e.code, s.h.launches().len()), (ErrorCode::NotApproved, 0));
}

#[test]
fn approved_custom_tool_sign_in_opens_the_terminal() {
    let s = setup();
    s.core
        .tool_sign_in(ToolArgs {
            profile_id: s.pid.clone(),
            tool_id: "kubectl".into(),
        })
        .unwrap();
    assert_eq!((s.h.confirmer.count(), s.h.launches().len()), (1, 1));
}

#[test]
fn confirmation_names_the_profile() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    assert!(s.h.confirmer.last().unwrap().message.contains("Work"));
}

#[test]
fn confirmation_shows_the_resolved_program_path() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    let bin =
        s.h.bin_dir()
            .join(format!("kubectl{}", std::env::consts::EXE_SUFFIX));
    assert!(
        s.h.confirmer
            .last()
            .unwrap()
            .message
            .contains(&bin.to_string_lossy().into_owned())
    );
}

#[test]
fn confirmation_lists_each_argument_on_its_own_line() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    let msg = s.h.confirmer.last().unwrap().message;
    let lines: Vec<&str> = msg.lines().map(str::trim).collect();
    assert!(
        lines.contains(&"current-context") && lines.contains(&"view"),
        "{msg}"
    );
}

#[test]
fn confirmation_makes_invisible_characters_in_arguments_visible() {
    let s = setup();
    s.core
        .custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                status: Some(vec!["status\u{202e}txt.exe".into()]),
                ..kube()
            },
            replace: true,
        })
        .unwrap();
    check(&s, "kubectl").unwrap();
    let msg = s.h.confirmer.last().unwrap().message;
    assert!(
        !msg.contains('\u{202e}') && msg.contains("\\u{202e}"),
        "{msg}"
    );
}

// ---- interpreters are not custom tools ---------------------------------------------------

fn binary_err(binary: &str) -> ErrorCode {
    Harness::new()
        .core()
        .custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                binary: binary.into(),
                ..kube()
            },
            replace: false,
        })
        .unwrap_err()
        .code
}

#[test]
fn bash_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("bash"), ErrorCode::InvalidInput);
}

#[test]
fn python3_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("python3.12"), ErrorCode::InvalidInput);
}

#[test]
fn node_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("node"), ErrorCode::InvalidInput);
}

#[test]
fn env_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("env"), ErrorCode::InvalidInput);
}

#[test]
fn powershell_exe_in_any_case_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("PowerShell.EXE"), ErrorCode::InvalidInput);
}

#[test]
fn osascript_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("osascript"), ErrorCode::InvalidInput);
}

#[test]
fn xdg_open_is_rejected_as_a_custom_tool_binary() {
    assert_eq!(binary_err("xdg-open"), ErrorCode::InvalidInput);
}

// ---- stored tools that no longer validate ------------------------------------------------

/// Stores a custom tool with a config variable today's rules reject (as an older build
/// could have), bypassing `custom_tool_save`.
fn store_legacy_tool(h: &Harness) {
    drop(h.core());
    let conn = rusqlite::Connection::open(h.data_root().join("app.db")).unwrap();
    let spec = serde_json::to_string(&CustomToolInput {
        config_var: "BROWSER".into(),
        ..kube()
    })
    .unwrap();
    conn.execute(
        "INSERT INTO custom_tools (id, spec_json, created_at) VALUES ('kubectl', ?1, '2026-01-01T00:00:00Z')",
        [spec],
    )
    .unwrap();
}

#[test]
fn stored_invalid_custom_tool_is_listed_with_its_reason() {
    let h = Harness::new();
    let pid = create_profile(&h.core(), "Work").id;
    store_legacy_tool(&h);
    let tools = h
        .core()
        .tools_list(ProfileScopeArgs { profile_id: pid })
        .unwrap();
    let t = tools.iter().find(|t| t.spec.id == "kubectl").unwrap();
    assert!(t.spec.invalid.is_some());
}

#[test]
fn stored_invalid_custom_tool_cannot_be_checked() {
    let h = Harness::new();
    h.install_fake("kubectl", json!({"default": {"exit": 0}}));
    let pid = create_profile(&h.core(), "Work").id;
    store_legacy_tool(&h);
    let e = h
        .core()
        .tool_check(ToolArgs {
            profile_id: pid,
            tool_id: "kubectl".into(),
        })
        .unwrap_err();
    assert_eq!((e.code, h.confirmer.count()), (ErrorCode::InvalidInput, 0));
}

#[test]
fn valid_tools_have_no_invalid_marker() {
    let s = setup();
    let tools = s
        .core
        .tools_list(ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    assert!(tools.iter().all(|t| t.spec.invalid.is_none()));
}

// ---- stdio MCP servers -------------------------------------------------------------------

fn mcp_setup() -> Setup {
    let h = Harness::new();
    let pids = h.path("pids.txt");
    h.install_fake(
        "fake-mcp",
        json!({"mcp": {"mode": "ok", "pid_file": pids.to_str().unwrap()}}),
    );
    let core = h.core();
    let pid = create_profile(&core, "Work").id;
    Setup { h, core, pid }
}

fn save_stdio(s: &Setup, args: Vec<String>) -> McpServerView {
    s.core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: None,
                name: "fake".into(),
                transport: McpTransportInput::Stdio {
                    command: "fake-mcp".into(),
                    args,
                    env: vec![],
                },
                tool_ids: vec![],
                enabled: true,
            },
        })
        .unwrap()
}

fn mcp_test(s: &Setup, id: &str) -> IpcResult<McpServerView> {
    s.core.mcp_test(McpServerArgs {
        profile_id: s.pid.clone(),
        server_id: id.into(),
    })
}

#[test]
fn stdio_mcp_test_asks_for_confirmation_first() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    mcp_test(&s, &v.id).unwrap();
    assert_eq!(s.h.confirmer.count(), 1);
}

#[test]
fn declined_stdio_mcp_test_is_not_approved() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    s.h.confirmer.set_decline(true);
    assert_eq!(
        mcp_test(&s, &v.id).unwrap_err().code,
        ErrorCode::NotApproved
    );
}

#[test]
fn declined_stdio_mcp_test_starts_no_process() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    s.h.confirmer.set_decline(true);
    let _ = mcp_test(&s, &v.id);
    assert!(!s.h.path("pids.txt").exists());
}

#[test]
fn approved_stdio_server_is_not_asked_again() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    mcp_test(&s, &v.id).unwrap();
    mcp_test(&s, &v.id).unwrap();
    assert_eq!(s.h.confirmer.count(), 1);
}

#[test]
fn changed_stdio_arguments_ask_again() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    mcp_test(&s, &v.id).unwrap();
    s.core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: Some(v.id.clone()),
                name: "fake".into(),
                transport: McpTransportInput::Stdio {
                    command: "fake-mcp".into(),
                    args: vec!["--extra".into()],
                    env: vec![],
                },
                tool_ids: vec![],
                enabled: true,
            },
        })
        .unwrap();
    mcp_test(&s, &v.id).unwrap();
    assert_eq!(s.h.confirmer.count(), 2);
}

#[test]
fn stdio_approval_is_per_profile() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    mcp_test(&s, &v.id).unwrap();
    let other = create_profile(&s.core, "Personal").id;
    let v2 = s
        .core
        .mcp_save(McpSaveArgs {
            profile_id: other.clone(),
            server: McpServerInput {
                id: None,
                name: "fake".into(),
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
    s.core
        .mcp_test(McpServerArgs {
            profile_id: other,
            server_id: v2.id,
        })
        .unwrap();
    assert_eq!(s.h.confirmer.count(), 2);
}

#[test]
fn stdio_confirmation_shows_the_arguments() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec!["--root".into(), "/srv/data".into()]);
    mcp_test(&s, &v.id).unwrap();
    let msg = s.h.confirmer.last().unwrap().message;
    assert!(msg.contains("/srv/data") && msg.contains("--root"), "{msg}");
}

#[test]
fn missing_stdio_command_reports_an_error_without_asking() {
    let s = mcp_setup();
    let v = s
        .core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: None,
                name: "gone".into(),
                transport: McpTransportInput::Stdio {
                    command: "not-installed-anywhere".into(),
                    args: vec![],
                    env: vec![],
                },
                tool_ids: vec![],
                enabled: true,
            },
        })
        .unwrap();
    mcp_test(&s, &v.id).unwrap();
    assert_eq!(s.h.confirmer.count(), 0);
}

#[test]
fn http_mcp_test_never_asks() {
    let s = mcp_setup();
    let v = s
        .core
        .mcp_save(McpSaveArgs {
            profile_id: s.pid.clone(),
            server: McpServerInput {
                id: None,
                name: "remote".into(),
                transport: McpTransportInput::Http {
                    // Nothing listens on port 9 (discard) on loopback in CI.
                    url: "http://127.0.0.1:9/mcp".into(),
                    headers: vec![],
                },
                tool_ids: vec![],
                enabled: true,
            },
        })
        .unwrap();
    mcp_test(&s, &v.id).unwrap();
    assert_eq!(s.h.confirmer.count(), 0);
}

#[test]
fn deleting_a_stdio_server_forgets_its_approval() {
    let s = mcp_setup();
    let v = save_stdio(&s, vec![]);
    mcp_test(&s, &v.id).unwrap();
    s.core
        .mcp_delete(McpServerArgs {
            profile_id: s.pid.clone(),
            server_id: v.id.clone(),
        })
        .unwrap();
    let conn = rusqlite::Connection::open(s.h.data_root().join("app.db")).unwrap();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM approvals WHERE subject = ?1",
            [&v.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

// ---- A3: the tool view says whether a check would ask --------------------------------------

#[test]
fn an_approved_custom_tool_view_is_approved() {
    let s = setup();
    assert!(check(&s, "kubectl").unwrap().spec.approved);
}

#[test]
fn a_custom_tool_listed_before_any_approval_is_not_approved() {
    let s = setup();
    let list = s
        .core
        .tools_list(vision_core::ipc::ProfileScopeArgs {
            profile_id: s.pid.clone(),
        })
        .unwrap();
    let kube = list.iter().find(|t| t.spec.id == "kubectl").unwrap();
    assert!(!kube.spec.approved);
}

#[test]
fn a_changed_custom_tool_is_no_longer_approved() {
    let s = setup();
    check(&s, "kubectl").unwrap();
    let v = s
        .core
        .custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                status: Some(vec!["version".into()]),
                ..kube()
            },
            replace: true,
        })
        .unwrap();
    assert!(!v.approved);
}
