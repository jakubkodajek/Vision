//! AC6: sign-in writes a launch script (exports, quoted argv, no parent secrets) and calls
//! the launcher; quoting withstands adversarial arguments (property-style test).
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use common::{Harness, create_profile};
use serde_json::json;
use vision_core::ipc::{ErrorCode, ProfileScopeArgs, ToolArgs};
use vision_core::terminal::{LaunchScript, render_posix, sh_quote};

fn sign_in(h: &Harness, tool: &str) -> (vision_core::Core, String) {
    let core = h.core();
    let p = create_profile(&core, "Work & Play");
    core.tool_sign_in(ToolArgs {
        profile_id: p.id.clone(),
        tool_id: tool.into(),
    })
    .unwrap();
    (core, p.id)
}

#[cfg(unix)]
#[test]
fn sign_in_script_exports_the_profile_config_dir_and_runs_the_quoted_login_argv() {
    let h = Harness::new();
    let bin = h.install_fake("gh", json!({}));
    let (core, pid) = sign_in(&h, "gh");
    let launch = &h.launches()[0];
    let dir = core.data_root().tool_dir(&pid, "gh").unwrap();
    assert!(launch.content.starts_with("#!/bin/sh\n"));
    assert!(launch.content.contains("/usr/bin/env -i"));
    assert!(
        launch
            .content
            .contains(&sh_quote(&format!("GH_CONFIG_DIR={}", dir.display())))
    );
    assert!(launch.content.contains(&format!(
        "{} \\\n  'auth' \\\n  'login' \\\n  '--insecure-storage'",
        sh_quote(&bin.display().to_string())
    )));
    assert!(launch.content.contains("read _"));
}

#[test]
fn sign_in_script_names_the_profile_with_metacharacters_neutralised() {
    let h = Harness::new();
    h.install_fake("claude", json!({}));
    sign_in(&h, "claude");
    assert!(
        h.launches()[0]
            .content
            .contains("Vision: profile Work ? Play, Claude Code sign-in")
    );
}

#[test]
fn sign_in_script_lives_in_the_private_tmp_dir() {
    let h = Harness::new();
    h.install_fake("claude", json!({}));
    let (core, _) = sign_in(&h, "claude");
    assert_eq!(
        h.launches()[0].script.parent(),
        Some(core.data_root().tmp().as_path())
    );
}

#[cfg(unix)]
#[test]
fn sign_in_script_is_user_only_executable() {
    use std::os::unix::fs::PermissionsExt;
    let h = Harness::new();
    h.install_fake("claude", json!({}));
    sign_in(&h, "claude");
    let mode = std::fs::metadata(&h.launches()[0].script)
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o700);
}

#[test]
fn launch_scripts_are_removed_on_next_start() {
    let h = Harness::new();
    h.install_fake("claude", json!({}));
    let (core, _) = sign_in(&h, "claude");
    drop(core);
    h.core();
    assert!(!h.launches()[0].script.exists());
}

#[test]
fn sign_in_for_a_missing_binary_is_not_installed_and_opens_nothing() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let err = core
        .tool_sign_in(ToolArgs {
            profile_id: p.id,
            tool_id: "codex".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotInstalled);
    assert!(h.launches().is_empty());
}

#[test]
fn sign_out_without_a_logout_command_is_invalid_input() {
    let h = Harness::new();
    h.install_fake("aws", json!({}));
    let core = h.core();
    let p = create_profile(&core, "Work");
    let err = core
        .tool_sign_out(ToolArgs {
            profile_id: p.id,
            tool_id: "aws".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
}

#[test]
fn profile_terminal_exports_every_tools_config_variable() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.profile_open_terminal(ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    let c = &h.launches()[0].content;
    for var in [
        "CLAUDE_CONFIG_DIR=",
        "CODEX_HOME=",
        "GH_CONFIG_DIR=",
        "CLOUDSDK_CONFIG=",
        "AZURE_CONFIG_DIR=",
        "AWS_CONFIG_FILE=",
        "AWS_SHARED_CREDENTIALS_FILE=",
    ] {
        assert!(c.contains(var), "{var} missing");
    }
}

// ---- quoting ---------------------------------------------------------------------------

/// Deterministic xorshift generator (fixed seed, no randomness in tests).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

const NASTY: &[&str] = &[
    "'", "\"", " ", "$", "`", "\n", "\\", "-", "--", "$(id)", "${HOME}", ";", "&", "|", "*", "?",
    "~", "!", "#", "\t", "a", "é", "'\\''", ">", "<", "(", ")", "{", "}", "%", "^",
];

fn adversarial_args(seed: u64, count: usize) -> Vec<String> {
    let mut rng = Rng(seed);
    (0..count)
        .map(|_| {
            let len = (rng.next() % 12) as usize;
            (0..len)
                .map(|_| NASTY[(rng.next() as usize) % NASTY.len()])
                .collect::<String>()
        })
        .collect()
}

#[cfg(unix)]
fn sh_roundtrip(args: &[String]) -> Vec<String> {
    // printf prints each word followed by NUL; any break-out would change the word list.
    let mut script = String::from("printf '%s\\0'");
    for a in args {
        script.push(' ');
        script.push_str(&sh_quote(a));
    }
    let out = std::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .env_clear()
        .output()
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8(out.stdout).unwrap();
    text.split_terminator('\0').map(str::to_owned).collect()
}

#[cfg(unix)]
#[test]
fn sh_quote_round_trips_adversarial_arguments_through_a_real_shell() {
    let args = adversarial_args(0x5eed_1234_abcd_0001, 400);
    assert_eq!(sh_roundtrip(&args), args);
}

#[cfg(unix)]
#[test]
fn sh_quote_keeps_named_attack_strings_literal() {
    let args: Vec<String> = [
        "it's",
        "a b",
        "$HOME",
        "`touch /tmp/pwned`",
        "$(touch /tmp/pwned)",
        "line1\nline2",
        "-rf",
        "--help",
        "\"double\"",
        "",
        "'; rm -rf / #",
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    assert_eq!(sh_roundtrip(&args), args);
}

#[cfg(unix)]
#[test]
fn rendered_script_passes_adversarial_argv_and_env_values_through_unchanged() {
    let h = Harness::new();
    let dump = h.path("argv.txt");
    let fake = h.install_fake("echoargs", json!({"log_args": dump.to_str().unwrap()}));
    let args = adversarial_args(0x0bad_cafe_0000_0042, 30);
    let mut argv = vec![fake.display().to_string()];
    argv.extend(args.iter().cloned());
    let script = render_posix(&LaunchScript {
        title: "t".into(),
        env: vec![("X_VALUE".into(), args.join("").into())],
        argv,
        keep_open: false,
    })
    .unwrap();
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .status()
        .unwrap();
    assert!(status.success());
    let logged: Vec<String> = serde_json::from_str(common::read(&dump).trim()).unwrap();
    assert_eq!(logged, args);
}
