//! AC4: only allowlisted variables reach status commands, terminal scripts and MCP probes.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use std::ffi::{OsStr, OsString};

use common::{Harness, assert_no_leaks, create_profile};
use serde_json::json;
use vision_core::env::{build_env_with, is_allowed, parse_marked_path, resolve_path};
use vision_core::ipc::{McpSaveArgs, McpServerArgs, McpServerInput, McpTransportInput, ToolArgs};

fn env_of(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs
        .iter()
        .map(|(k, v)| (OsString::from(k), OsString::from(v)))
        .collect()
}

fn names(env: &[(OsString, OsString)]) -> Vec<String> {
    env.iter()
        .map(|(k, _)| k.to_string_lossy().into_owned())
        .collect()
}

// ---- pure builder (table-driven) -------------------------------------------------------

#[test]
fn allowlist_accepts_the_documented_base_variables() {
    let allowed = [
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "TERM",
        "HTTP_PROXY",
        "https_proxy",
        "NO_PROXY",
        "all_proxy",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "SystemRoot",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
    ];
    let rejected: Vec<&str> = allowed
        .iter()
        .copied()
        .filter(|n| !is_allowed(n, false))
        .collect();
    assert!(rejected.is_empty(), "{rejected:?}");
}

#[test]
fn allowlist_rejects_credentials_and_everything_else() {
    let denied = [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "OPENAI_API_KEY",
        "AWS_SECRET_ACCESS_KEY",
        "CLAUDE_CODE_USE_BEDROCK",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "NODE_OPTIONS",
        "CLAUDE_CONFIG_DIR",
        "home",
    ];
    let passed: Vec<&str> = denied
        .iter()
        .copied()
        .filter(|n| is_allowed(n, false))
        .collect();
    assert!(passed.is_empty(), "{passed:?}");
}

#[test]
fn windows_matching_is_case_insensitive() {
    assert_eq!(
        (
            is_allowed("SYSTEMROOT", true),
            is_allowed("SYSTEMROOT", false)
        ),
        (true, false)
    );
}

#[test]
fn builder_keeps_allowlisted_drops_others_and_sets_path() {
    let parent = env_of(&[
        ("HOME", "/h"),
        ("PATH", "/parent/bin"),
        ("ANTHROPIC_API_KEY", "x"),
        ("GH_TOKEN", "y"),
        ("LC_TIME", "C"),
    ]);
    let env = build_env_with(&parent, OsStr::new("/resolved/bin"), &[], false);
    assert_eq!(names(&env), vec!["HOME", "LC_TIME", "PATH"]);
    assert_eq!(env[2].1, OsString::from("/resolved/bin"));
}

#[test]
fn builder_extra_variables_override_parent_values() {
    let parent = env_of(&[("HOME", "/h"), ("CLAUDE_CONFIG_DIR", "/parent/claude")]);
    let extra = env_of(&[("CLAUDE_CONFIG_DIR", "/profile/claude"), ("HOME", "/other")]);
    let env = build_env_with(&parent, OsStr::new("/bin"), &extra, false);
    assert_eq!(
        env,
        env_of(&[
            ("PATH", "/bin"),
            ("CLAUDE_CONFIG_DIR", "/profile/claude"),
            ("HOME", "/other")
        ])
    );
}

#[test]
fn builder_on_windows_drops_differently_cased_path() {
    let parent = env_of(&[("Path", r"C:\x"), ("SystemRoot", r"C:\Windows")]);
    let env = build_env_with(&parent, OsStr::new(r"C:\y"), &[], true);
    assert_eq!(
        env,
        env_of(&[("SystemRoot", r"C:\Windows"), ("PATH", r"C:\y")])
    );
}

#[test]
fn login_shell_path_is_parsed_between_markers() {
    assert_eq!(
        parse_marked_path("motd noise\n__VISION_PATH__/a:/b__END__ trailing"),
        Some("/a:/b".to_owned())
    );
}

#[test]
fn login_shell_output_without_markers_yields_none() {
    assert_eq!(parse_marked_path("zsh: command not found"), None);
}

#[cfg(unix)]
#[test]
fn path_resolution_uses_the_login_shell_and_appends_existing_well_known_dirs() {
    let h = Harness::new();
    let shell = h.install_fake(
        "fakeshell",
        json!({"default": {"stdout": "__VISION_PATH__/from/shell__END__"}}),
    );
    let home = h.dir.path().join("home");
    std::fs::create_dir_all(home.join(".local/bin")).unwrap();
    let parent = vec![
        (OsString::from("SHELL"), shell.into_os_string()),
        (OsString::from("HOME"), home.clone().into_os_string()),
        (OsString::from("PATH"), OsString::from("/parent")),
    ];
    let path = resolve_path(&vision_core::process::SystemCommandRunner, &parent);
    let dirs: Vec<_> = std::env::split_paths(&path).collect();
    assert_eq!(dirs.first(), Some(&std::path::PathBuf::from("/from/shell")));
    assert!(dirs.contains(&home.join(".local/bin")));
    assert!(!dirs.contains(&home.join(".cargo/bin")));
}

#[cfg(unix)]
#[test]
fn path_resolution_falls_back_to_the_process_path_when_the_shell_fails() {
    let h = Harness::new();
    let shell = h.install_fake(
        "fakeshell",
        json!({"default": {"stdout": "no markers", "exit": 1}}),
    );
    let parent = vec![
        (OsString::from("SHELL"), shell.into_os_string()),
        (OsString::from("PATH"), OsString::from("/parent")),
    ];
    let path = resolve_path(&vision_core::process::SystemCommandRunner, &parent);
    assert_eq!(
        std::env::split_paths(&path).next(),
        Some(std::path::PathBuf::from("/parent"))
    );
}

// ---- end to end with a fake CLI that dumps its environment -----------------------------

#[test]
fn parent_credentials_never_reach_a_status_command() {
    let h = Harness::new();
    let dump = h.path("env.txt");
    h.install_fake(
        "claude",
        json!({"dump_env": dump.to_str().unwrap(), "default": {"exit": 1}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.tool_check(ToolArgs {
        profile_id: p.id,
        tool_id: "claude".into(),
    })
    .unwrap();
    let env = common::read(&dump);
    assert!(env.contains("CLAUDE_CONFIG_DIR="));
    assert!(env.contains("HTTPS_PROXY=http://proxy.invalid:3128"));
    assert_no_leaks(&env);
}

#[test]
fn status_command_gets_only_its_own_tools_config_variable() {
    let h = Harness::new();
    let dump = h.path("env.txt");
    h.install_fake(
        "gh",
        json!({"dump_env": dump.to_str().unwrap(), "default": {"stdout": "{\"hosts\":{}}"}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.tool_check(ToolArgs {
        profile_id: p.id,
        tool_id: "gh".into(),
    })
    .unwrap();
    let env = common::read(&dump);
    assert!(env.contains("GH_CONFIG_DIR="));
    assert!(!env.contains("CLAUDE_CONFIG_DIR="));
}

#[test]
fn parent_credentials_never_reach_a_terminal_script() {
    let h = Harness::new();
    h.install_fake("claude", json!({}));
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.tool_sign_in(ToolArgs {
        profile_id: p.id,
        tool_id: "claude".into(),
    })
    .unwrap();
    let launch = &h.launches()[0];
    assert_no_leaks(&launch.content);
    assert_no_leaks(&format!("{:?}", launch.env));
}

#[test]
fn parent_credentials_never_reach_an_mcp_probe() {
    let h = Harness::new();
    let dump = h.path("env.txt");
    h.install_fake(
        "fake-mcp",
        json!({"dump_env": dump.to_str().unwrap(), "mcp": {"mode": "ok"}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = core
        .mcp_save(McpSaveArgs {
            profile_id: p.id.clone(),
            server: McpServerInput {
                id: None,
                name: "fake".into(),
                transport: McpTransportInput::Stdio {
                    command: "fake-mcp".into(),
                    args: vec![],
                    env: vec![],
                },
                tool_ids: vec!["gcloud".into()],
                enabled: true,
            },
        })
        .unwrap();
    core.mcp_test(McpServerArgs {
        profile_id: p.id,
        server_id: s.id,
    })
    .unwrap();
    let env = common::read(&dump);
    assert!(
        env.contains("CLOUDSDK_CONFIG="),
        "tool login shared with the server"
    );
    assert_no_leaks(&env);
}
