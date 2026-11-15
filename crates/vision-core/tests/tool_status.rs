//! AC5: status parsers (fixtures for signed in, signed out, garbage, timeout per preset),
//! `not_installed`, and per-profile isolation of config directories and statuses.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use std::path::Path;
use std::sync::Arc;

use common::{Harness, RecordingRunner, create_profile};
use serde_json::json;
use vision_core::ipc::{ProfileScopeArgs, StatusParser, ToolArgs, ToolStatus};
use vision_core::process::CommandOutput;
use vision_core::tools::parse_status;

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/status")
            .join(name),
    )
    .unwrap()
}

fn out(stdout: &str, exit: i32) -> CommandOutput {
    CommandOutput {
        exit_code: Some(exit),
        stdout: if stdout.is_empty() {
            vec![]
        } else {
            fixture(stdout)
        },
        stderr: vec![],
        timed_out: false,
        truncated: false,
    }
}

fn stderr_out(stderr: &str, exit: i32) -> CommandOutput {
    CommandOutput {
        exit_code: Some(exit),
        stdout: vec![],
        stderr: fixture(stderr),
        timed_out: false,
        truncated: false,
    }
}

fn timed_out() -> CommandOutput {
    CommandOutput {
        exit_code: None,
        timed_out: true,
        ..CommandOutput::default()
    }
}

fn parse(p: StatusParser, o: &CommandOutput) -> ToolStatus {
    parse_status(p, o, Path::new("/profile/tools/x"))
}

fn signed_in(account: &str) -> ToolStatus {
    ToolStatus::SignedIn {
        account: Some(account.to_owned()),
        warning: None,
    }
}

fn is_unknown(s: &ToolStatus) -> bool {
    matches!(s, ToolStatus::Unknown { .. })
}

// ---- claude ----------------------------------------------------------------------------

#[test]
fn claude_signed_in_reports_email_and_ignores_unknown_fields() {
    assert_eq!(
        parse(StatusParser::Claude, &out("claude_signed_in.json", 0)),
        signed_in("ada@example.com")
    );
}

#[test]
fn claude_exit_1_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Claude, &out("claude_signed_out.json", 1)),
        ToolStatus::SignedOut
    );
}

#[test]
fn claude_logged_in_false_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Claude, &out("claude_signed_out.json", 0)),
        ToolStatus::SignedOut
    );
}

#[test]
fn claude_garbage_is_unknown_with_first_line() {
    let s = parse(StatusParser::Claude, &out("garbage.txt", 0));
    assert!(
        matches!(&s, ToolStatus::Unknown { message } if message.contains("Segmentation fault") && !message.contains('\u{1b}')),
        "{s:?}"
    );
}

#[test]
fn claude_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Claude, &timed_out())));
}

#[test]
fn claude_non_subscription_auth_method_warns() {
    let s = parse(StatusParser::Claude, &out("claude_api_key.json", 0));
    assert!(
        matches!(
            &s,
            ToolStatus::SignedIn {
                warning: Some(_),
                ..
            }
        ),
        "{s:?}"
    );
}

#[test]
fn claude_different_config_directory_warns() {
    let o = CommandOutput {
        exit_code: Some(0),
        stdout: br#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","configDirectory":"/somewhere/else"}"#.to_vec(),
        ..CommandOutput::default()
    };
    assert!(matches!(
        parse(StatusParser::Claude, &o),
        ToolStatus::SignedIn {
            warning: Some(_),
            ..
        }
    ));
}

#[test]
fn claude_matching_config_directory_does_not_warn() {
    let o = CommandOutput {
        exit_code: Some(0),
        stdout: br#"{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.c","configDirectory":"/profile/tools/x/"}"#.to_vec(),
        ..CommandOutput::default()
    };
    assert_eq!(parse(StatusParser::Claude, &o), signed_in("a@b.c"));
}

// ---- codex -----------------------------------------------------------------------------

#[test]
fn codex_chatgpt_login_is_signed_in() {
    assert_eq!(
        parse(StatusParser::Codex, &out("codex_signed_in.txt", 0)),
        signed_in("ChatGPT account")
    );
}

#[test]
fn codex_not_logged_in_is_signed_out_whatever_the_exit_code() {
    assert_eq!(
        parse(StatusParser::Codex, &out("codex_signed_out.txt", 1)),
        ToolStatus::SignedOut
    );
}

#[test]
fn codex_api_key_login_never_echoes_the_key() {
    let s = parse(StatusParser::Codex, &out("codex_api_key.txt", 0));
    assert!(!format!("{s:?}").contains("sk-proj"), "{s:?}");
}

#[test]
fn codex_garbage_is_unknown() {
    assert!(is_unknown(&parse(
        StatusParser::Codex,
        &out("garbage.txt", 0)
    )));
}

#[test]
fn codex_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Codex, &timed_out())));
}

// ---- gh --------------------------------------------------------------------------------

#[test]
fn gh_json_reports_the_active_login() {
    assert_eq!(
        parse(StatusParser::Gh, &out("gh_signed_in.json", 0)),
        signed_in("octocat (github.com)")
    );
}

#[test]
fn gh_json_without_hosts_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Gh, &out("gh_signed_out.json", 0)),
        ToolStatus::SignedOut
    );
}

#[test]
fn gh_text_fallback_reports_the_login() {
    assert_eq!(
        parse(StatusParser::Gh, &out("gh_text_signed_in.txt", 0)),
        signed_in("octocat (github.com)")
    );
}

#[test]
fn gh_text_fallback_not_logged_in_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Gh, &stderr_out("gh_text_signed_out.txt", 1)),
        ToolStatus::SignedOut
    );
}

#[test]
fn gh_garbage_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Gh, &out("garbage.txt", 0))));
}

#[test]
fn gh_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Gh, &timed_out())));
}

// ---- gcloud ----------------------------------------------------------------------------

#[test]
fn gcloud_reports_the_active_account() {
    assert_eq!(
        parse(StatusParser::Gcloud, &out("gcloud_signed_in.json", 0)),
        signed_in("ada@example.com")
    );
}

#[test]
fn gcloud_empty_list_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Gcloud, &out("gcloud_signed_out.json", 0)),
        ToolStatus::SignedOut
    );
}

#[test]
fn gcloud_garbage_is_unknown() {
    assert!(is_unknown(&parse(
        StatusParser::Gcloud,
        &out("garbage.txt", 0)
    )));
}

#[test]
fn gcloud_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Gcloud, &timed_out())));
}

// ---- azure -----------------------------------------------------------------------------

#[test]
fn azure_reports_user_and_subscription() {
    assert_eq!(
        parse(StatusParser::Azure, &out("azure_signed_in.json", 0)),
        signed_in("ada@example.com (Pay-As-You-Go)")
    );
}

#[test]
fn azure_please_run_az_login_is_signed_out() {
    assert_eq!(
        parse(
            StatusParser::Azure,
            &stderr_out("azure_signed_out.stderr", 1)
        ),
        ToolStatus::SignedOut
    );
}

#[test]
fn azure_garbage_is_unknown() {
    assert!(is_unknown(&parse(
        StatusParser::Azure,
        &out("garbage.txt", 0)
    )));
}

#[test]
fn azure_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Azure, &timed_out())));
}

// ---- aws -------------------------------------------------------------------------------

#[test]
fn aws_configured_keys_are_signed_in_without_echoing_the_key() {
    let s = parse(StatusParser::Aws, &out("aws_signed_in.txt", 0));
    assert_eq!(s, signed_in("credentials from shared-credentials-file"));
}

#[test]
fn aws_not_set_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Aws, &out("aws_signed_out.txt", 0)),
        ToolStatus::SignedOut
    );
}

#[test]
fn aws_garbage_is_unknown() {
    assert!(is_unknown(&parse(
        StatusParser::Aws,
        &out("garbage.txt", 0)
    )));
}

#[test]
fn aws_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::Aws, &timed_out())));
}

// ---- exit_code -------------------------------------------------------------------------

#[test]
fn exit_code_parser_maps_zero_to_signed_in_and_nonzero_to_signed_out() {
    assert_eq!(
        (
            parse(StatusParser::ExitCode, &out("", 0)),
            parse(StatusParser::ExitCode, &out("", 3))
        ),
        (
            ToolStatus::SignedIn {
                account: None,
                warning: None
            },
            ToolStatus::SignedOut
        )
    );
}

#[test]
fn exit_code_parser_timeout_is_unknown() {
    assert!(is_unknown(&parse(StatusParser::ExitCode, &timed_out())));
}

// ---- through the core ------------------------------------------------------------------

fn check(core: &vision_core::Core, profile_id: &str, tool: &str) -> vision_core::ipc::ToolView {
    core.tool_check(ToolArgs {
        profile_id: profile_id.to_owned(),
        tool_id: tool.to_owned(),
    })
    .unwrap()
}

#[test]
fn missing_binary_is_not_installed() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    assert_eq!(
        check(&core, &p.id, "gcloud").status,
        Some(ToolStatus::NotInstalled)
    );
}

#[test]
fn tool_check_runs_the_fake_cli_and_caches_the_result() {
    let h = Harness::new();
    let stdout = String::from_utf8(fixture("claude_signed_in.json")).unwrap();
    h.install_fake(
        "claude",
        json!({
            "responses": [
                {"args": ["auth", "status"], "stdout": stdout, "exit": 0},
                {"args": ["--version"], "stdout": "2.1.0 (Claude Code)\n", "exit": 0}
            ]
        }),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let checked = check(&core, &p.id, "claude");
    let listed = core
        .tools_list(ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    let cached = listed.iter().find(|t| t.spec.id == "claude").unwrap();
    assert_eq!(checked.status, Some(signed_in("ada@example.com")));
    assert_eq!(checked.version.as_deref(), Some("2.1.0"));
    assert_eq!(cached.status, checked.status);
}

#[test]
fn slow_status_command_times_out_as_unknown() {
    let mut h = Harness::new();
    h.timeouts.status = std::time::Duration::from_millis(500);
    h.install_fake("az", json!({"responses": [{"args": ["account", "show", "--output", "json"], "sleep_ms": 30000}]}));
    let core = h.core();
    let p = create_profile(&core, "Work");
    let started = std::time::Instant::now();
    let s = check(&core, &p.id, "azure").status.unwrap();
    assert!(
        matches!(&s, ToolStatus::Unknown { message } if message.contains("did not finish")),
        "{s:?}"
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(10));
}

#[test]
fn gh_falls_back_to_text_status_when_json_is_unsupported() {
    let h = Harness::new();
    let text = String::from_utf8(fixture("gh_text_signed_in.txt")).unwrap();
    h.install_fake("gh", json!({"responses": [
        {"args": ["auth", "status", "--json", "hosts"], "stderr": "unknown flag: --json\n", "exit": 1},
        {"args": ["auth", "status"], "stdout": text, "exit": 0}
    ]}));
    let core = h.core();
    let p = create_profile(&core, "Work");
    assert_eq!(
        check(&core, &p.id, "gh").status,
        Some(signed_in("octocat (github.com)"))
    );
}

#[test]
fn two_profiles_get_different_config_directories_and_independent_statuses() {
    let h = Harness::new();
    let dump = h.path("env.txt");
    h.install_fake(
        "claude",
        json!({
            "env_dir_response": "CLAUDE_CONFIG_DIR",
            "dump_env": dump.to_str().unwrap(),
            "default": {"stdout": "{\"loggedIn\":false}", "exit": 1}
        }),
    );
    let core = h.core();
    let work = create_profile(&core, "Work");
    let personal = create_profile(&core, "Personal");
    let work_dir = core.data_root().tool_dir(&work.id, "claude").unwrap();
    std::fs::create_dir_all(&work_dir).unwrap();
    let signed = String::from_utf8(fixture("claude_signed_in.json")).unwrap();
    std::fs::write(
        work_dir.join("fake-response.json"),
        json!({"stdout": signed, "exit": 0}).to_string(),
    )
    .unwrap();

    let w = check(&core, &work.id, "claude").status;
    let p = check(&core, &personal.id, "claude").status;

    assert_eq!(w, Some(signed_in("ada@example.com")));
    assert_eq!(p, Some(ToolStatus::SignedOut));
    let env = common::read(&dump);
    let personal_dir = core.data_root().tool_dir(&personal.id, "claude").unwrap();
    assert!(env.contains(&format!("CLAUDE_CONFIG_DIR={}", work_dir.display())));
    assert!(env.contains(&format!("CLAUDE_CONFIG_DIR={}", personal_dir.display())));
    assert_ne!(work_dir, personal_dir);
}

#[test]
fn tools_list_spawns_no_process() {
    let mut h = Harness::new();
    let runner = Arc::new(RecordingRunner::default());
    h.runner = runner.clone();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let tools = core
        .tools_list(ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    assert_eq!(tools.len(), 6);
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[test]
fn codex_check_writes_file_credential_store_config_once() {
    let h = Harness::new();
    h.install_fake(
        "codex",
        json!({"default": {"stdout": "Not logged in\n", "exit": 1}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    check(&core, &p.id, "codex");
    let cfg = core
        .data_root()
        .tool_dir(&p.id, "codex")
        .unwrap()
        .join("config.toml");
    assert!(common::read(&cfg).contains("cli_auth_credentials_store = \"file\""));
}

#[test]
fn codex_existing_config_is_never_rewritten() {
    let h = Harness::new();
    h.install_fake(
        "codex",
        json!({"default": {"stdout": "Not logged in\n", "exit": 1}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let dir = core.data_root().tool_dir(&p.id, "codex").unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("config.toml"), "model = \"mine\"\n").unwrap();
    check(&core, &p.id, "codex");
    assert_eq!(common::read(&dir.join("config.toml")), "model = \"mine\"\n");
}

// ---- suspected (d): codex wording ------------------------------------------------------

fn text(stdout: &str, exit: i32) -> CommandOutput {
    CommandOutput {
        exit_code: Some(exit),
        stdout: stdout.as_bytes().to_vec(),
        ..CommandOutput::default()
    }
}

#[test]
fn codex_no_longer_logged_in_is_signed_out() {
    assert_eq!(
        parse(
            StatusParser::Codex,
            &text("You are no longer logged in. Run codex login.\n", 0)
        ),
        ToolStatus::SignedOut
    );
}

#[test]
fn codex_logged_out_is_signed_out() {
    assert_eq!(
        parse(StatusParser::Codex, &text("Logged out\n", 0)),
        ToolStatus::SignedOut
    );
}

#[test]
fn codex_logged_in_mentioned_mid_line_is_unknown() {
    assert!(is_unknown(&parse(
        StatusParser::Codex,
        &text("Error: could not confirm you are logged in\n", 0)
    )));
}

// ---- suspected (c): version labels -----------------------------------------------------

#[test]
fn version_is_the_version_looking_token() {
    assert_eq!(
        vision_core::tools::parse_version(&text("codex-cli 0.46.0\n", 0)).as_deref(),
        Some("0.46.0")
    );
}

#[test]
fn version_keeps_a_pre_release_suffix() {
    assert_eq!(
        vision_core::tools::parse_version(&text("tool v1.2.3-beta.1\n", 0)).as_deref(),
        Some("1.2.3-beta.1")
    );
}

#[test]
fn version_of_a_failed_command_is_none() {
    assert_eq!(
        vision_core::tools::parse_version(&text("error 1.2.3 not found\n", 2)),
        None
    );
}

#[test]
fn version_falls_back_to_stderr_when_stdout_is_empty() {
    let o = CommandOutput {
        exit_code: Some(0),
        stderr: b"java version 21.0.2\n".to_vec(),
        ..CommandOutput::default()
    };
    assert_eq!(
        vision_core::tools::parse_version(&o).as_deref(),
        Some("21.0.2")
    );
}

#[test]
fn output_without_a_version_number_gives_no_version() {
    assert_eq!(
        vision_core::tools::parse_version(&text("Usage: tool [options]\n", 0)),
        None
    );
}

// ---- SEC-8: key-like tokens never reach the UI -------------------------------------------

#[test]
fn an_unknown_status_message_redacts_an_api_key() {
    let s = parse(
        StatusParser::Claude,
        &text("Invalid API key: sk-ant-api03-AbCdEf123456\n", 0),
    );
    assert!(
        matches!(&s, ToolStatus::Unknown { message } if message.contains("sk-[redacted]") && !message.contains("AbCdEf123456")),
        "{s:?}"
    );
}

#[test]
fn an_unknown_status_message_redacts_a_github_token() {
    let s = parse(
        StatusParser::Gh,
        &text("bad credentials for ghp_0123456789abcdefABCDEF\n", 0),
    );
    assert!(
        matches!(&s, ToolStatus::Unknown { message } if !message.contains("0123456789abcdef")),
        "{s:?}"
    );
}

// ---- tool_check never caches a result for an edited tool ---------------------------------

#[test]
fn a_check_finishing_after_the_tool_was_edited_caches_nothing() {
    use vision_core::ipc::{ConfigEnvKind, CustomToolInput, CustomToolSaveArgs};
    let h = Harness::new();
    let marker = h.path("args.txt");
    h.install_fake(
        "mytool",
        json!({"log_args": marker.to_str().unwrap(), "default": {"exit": 0, "sleep_ms": 1000}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let tool = CustomToolInput {
        id: "mytool".into(),
        name: "mytool".into(),
        description: None,
        binary: "mytool".into(),
        install_url: None,
        config_var: "MYTOOL_CONFIG_DIR".into(),
        config_kind: ConfigEnvKind::Dir,
        login: vec!["login".into()],
        status: Some(vec!["status".into()]),
        logout: None,
    };
    core.custom_tool_save(CustomToolSaveArgs {
        tool: tool.clone(),
        replace: false,
    })
    .unwrap();
    let result = std::thread::scope(|scope| {
        let checking = scope.spawn(|| {
            core.tool_check(ToolArgs {
                profile_id: p.id.clone(),
                tool_id: "mytool".into(),
            })
        });
        let started = std::time::Instant::now();
        while !marker.exists() && started.elapsed() < std::time::Duration::from_secs(10) {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        core.custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                status: Some(vec!["whoami".into()]),
                ..tool
            },
            replace: true,
        })
        .unwrap();
        checking.join().unwrap()
    });
    assert_eq!(result.unwrap().status, None);
}
