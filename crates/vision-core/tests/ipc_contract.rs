//! AC11 (Rust side) and wire format: the committed `src/ipc/bindings.ts` equals the
//! generated bindings, and the serde shapes match the spec (snake_case fields, tagged
//! unions with `kind`/`status`).
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

use std::path::Path;

use serde_json::json;
use vision_core::ipc::{
    ErrorCode, IpcError, McpTransportInput, ToolStatus, ValueView, typescript_bindings,
};

fn committed() -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/ipc/bindings.ts");
    std::fs::read_to_string(p).unwrap_or_default()
}

#[test]
fn committed_bindings_file_is_up_to_date() {
    assert!(
        committed() == typescript_bindings(),
        "src/ipc/bindings.ts is stale: run `make bindings`"
    );
}

#[test]
fn bindings_declare_every_ipc_type() {
    let ts = typescript_bindings();
    for name in [
        "IpcError",
        "ErrorCode",
        "Bootstrap",
        "Profile",
        "ToolView",
        "ToolStatus",
        "McpServerView",
        "McpServerInput",
        "SyncReport",
        "CustomToolInput",
    ] {
        assert!(
            ts.contains(&format!("export type {name} =")),
            "{name} missing"
        );
    }
}

#[test]
fn error_serialises_as_snake_case_code_and_message() {
    let e = IpcError::new(ErrorCode::SchemaTooNew, "m");
    assert_eq!(
        serde_json::to_value(e).unwrap(),
        json!({"code": "schema_too_new", "message": "m"})
    );
}

#[test]
fn tool_status_is_tagged_by_status() {
    let s = ToolStatus::SignedIn {
        account: Some("a".into()),
        warning: None,
    };
    assert_eq!(
        serde_json::to_value(s).unwrap(),
        json!({"status": "signed_in", "account": "a"})
    );
}

#[test]
fn secret_view_is_tagged_by_kind_and_has_no_value() {
    assert_eq!(
        serde_json::to_value(ValueView::Secret { has_value: true }).unwrap(),
        json!({"kind": "secret", "has_value": true})
    );
}

#[test]
fn transport_input_deserialises_from_a_kind_tagged_object() {
    let t: McpTransportInput = serde_json::from_value(json!({
        "kind": "stdio", "command": "npx", "args": [],
        "env": [{"key": "K", "value": {"kind": "secret", "value": "v"}}]
    }))
    .unwrap();
    assert!(matches!(t, McpTransportInput::Stdio { .. }));
}

#[test]
fn secret_input_debug_output_is_redacted() {
    let t: McpTransportInput = serde_json::from_value(json!({
        "kind": "http", "url": "https://x", "headers": [{"key": "A", "value": {"kind": "secret", "value": "hunter2"}}]
    }))
    .unwrap();
    assert!(!format!("{t:?}").contains("hunter2"));
}
