//! The headless process runner (BUG-3): output survives a daemon that keeps the pipe open,
//! both streams are drained concurrently, and captured output is capped and marked.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use std::time::{Duration, Instant};

use common::Harness;
use serde_json::{Value, json};
use vision_core::process::{CommandOutput, CommandRunner, CommandSpec, SystemCommandRunner};

fn run_fake(h: &Harness, response: Value, max_output_bytes: usize) -> (CommandOutput, Duration) {
    let bin = h.install_fake("faketool", json!({ "default": response }));
    let started = Instant::now();
    let out = SystemCommandRunner
        .run(&CommandSpec {
            program: bin,
            args: vec![],
            env: h.parent_env(),
            cwd: None,
            timeout: Duration::from_secs(10),
            max_output_bytes,
        })
        .unwrap();
    (out, started.elapsed())
}

#[cfg(unix)]
#[test]
fn output_is_returned_when_a_detached_daemon_keeps_the_pipe_open() {
    let h = Harness::new();
    let (out, _) = run_fake(
        &h,
        json!({"stdout": "signed-in-as-alice\n", "daemon_ms": 4000}),
        1024,
    );
    assert_eq!(String::from_utf8_lossy(&out.stdout), "signed-in-as-alice\n");
}

#[cfg(unix)]
#[test]
fn a_detached_daemon_delays_the_result_by_less_than_a_second() {
    let h = Harness::new();
    let (_, elapsed) = run_fake(&h, json!({"stdout": "x", "daemon_ms": 4000}), 1024);
    assert!(elapsed < Duration::from_secs(1), "{elapsed:?}");
}

#[test]
fn both_streams_larger_than_a_pipe_buffer_do_not_deadlock() {
    let h = Harness::new();
    let (out, _) = run_fake(
        &h,
        json!({"big_stderr_bytes": 1_000_000, "big_stdout_bytes": 1_000_000, "exit": 0}),
        2 * 1024 * 1024,
    );
    assert_eq!(
        (
            out.exit_code,
            out.stdout.len(),
            out.stderr.len(),
            out.timed_out
        ),
        (Some(0), 1_000_000, 1_000_000, false)
    );
}

#[test]
fn captured_output_is_capped_and_marked_truncated() {
    let h = Harness::new();
    let (out, _) = run_fake(&h, json!({"big_stdout_bytes": 300_000}), 1024);
    assert_eq!((out.stdout.len(), out.truncated), (1024, true));
}

#[test]
fn output_within_the_cap_is_not_marked_truncated() {
    let h = Harness::new();
    let (out, _) = run_fake(&h, json!({"stdout": "small"}), 1024);
    assert!(!out.truncated);
}
