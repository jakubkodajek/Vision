//! Trust-on-first-use approval of user-defined commands (custom tools and stdio MCP
//! servers), spec §2.4/§2.5.
//!
//! Before Vision runs a custom tool's commands or spawns a stdio MCP server whose exact
//! definition the user has not approved yet, the core asks a [`Confirmer`]. In the desktop
//! app that is a native OS dialog driven from Rust, which the webview cannot script, so a
//! compromised webview that saves a hostile definition still cannot run it headlessly. An
//! approval stores the SHA-256 fingerprint of the definition in `app.db`; any change to the
//! definition needs a new approval, and deleting the tool or server deletes it.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ipc::{ErrorCode, IpcError, IpcResult};
use crate::text::make_visible;

/// Asks the user to approve a command. Implemented with a native dialog in the desktop app
/// and by fakes in tests.
pub trait Confirmer: Send + Sync {
    /// Shows `title` and `message` and returns `true` only if the user explicitly approved.
    /// Must default to "no" (Cancel) and must not be driveable from the webview.
    fn confirm(&self, title: &str, message: &str) -> bool;
}

/// A confirmer that never approves (for headless use where no dialog exists).
#[derive(Debug, Default, Clone, Copy)]
pub struct DenyAll;

impl Confirmer for DenyAll {
    fn confirm(&self, _title: &str, _message: &str) -> bool {
        false
    }
}

/// What an approval is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind {
    /// A custom tool (app scope).
    CustomTool,
    /// A stdio MCP server (profile scope).
    McpStdio,
}

impl ApprovalKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::CustomTool => "custom_tool",
            Self::McpStdio => "mcp_stdio",
        }
    }
}

/// SHA-256 of `definition` (canonical JSON: `serde_json` sorts object keys), lower-case hex.
#[must_use]
pub fn fingerprint(definition: &Value) -> String {
    let digest = Sha256::digest(definition.to_string().as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Fingerprint of a custom tool: binary, config variable and kind, and every argv.
#[must_use]
pub fn custom_tool_fingerprint(
    binary: &str,
    config_var: &str,
    config_kind: &str,
    version: &[String],
    login: &[String],
    status: Option<&[String]>,
    logout: Option<&[String]>,
) -> String {
    fingerprint(&json!({
        "binary": binary,
        "config_var": config_var,
        "config_kind": config_kind,
        "version": version,
        "login": login,
        "status": status,
        "logout": logout,
    }))
}

/// Fingerprint of a stdio MCP server: command, args, env keys (not values) and shared tool
/// logins.
#[must_use]
pub fn mcp_stdio_fingerprint(
    command: &str,
    args: &[String],
    env_keys: &[String],
    tool_ids: &[String],
) -> String {
    fingerprint(&json!({
        "command": command,
        "args": args,
        "env_keys": env_keys,
        "tool_ids": tool_ids,
    }))
}

/// Returns whether `hash` is the approved fingerprint of `(kind, subject, profile_id)`.
/// `profile_id` is `""` for app-scope subjects.
///
/// # Errors
/// Database errors.
pub fn is_approved(
    conn: &Connection,
    kind: ApprovalKind,
    subject: &str,
    profile_id: &str,
    hash: &str,
) -> IpcResult<bool> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT hash FROM approvals WHERE kind = ?1 AND subject = ?2 AND profile_id = ?3",
            params![kind.as_str(), subject, profile_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(stored.as_deref() == Some(hash))
}

/// Stores (replaces) an approval.
///
/// # Errors
/// Database errors.
pub fn store(
    conn: &Connection,
    kind: ApprovalKind,
    subject: &str,
    profile_id: &str,
    hash: &str,
) -> IpcResult<()> {
    conn.execute(
        "INSERT INTO approvals (kind, subject, profile_id, hash, approved_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(kind, subject, profile_id) DO UPDATE SET hash = excluded.hash, approved_at = excluded.approved_at",
        params![kind.as_str(), subject, profile_id, hash, crate::time::now_rfc3339()],
    )?;
    Ok(())
}

/// Deletes the approvals of one subject (every profile).
///
/// # Errors
/// Database errors.
pub fn forget(conn: &Connection, kind: ApprovalKind, subject: &str) -> IpcResult<()> {
    conn.execute(
        "DELETE FROM approvals WHERE kind = ?1 AND subject = ?2",
        params![kind.as_str(), subject],
    )?;
    Ok(())
}

/// Deletes every approval scoped to a profile.
///
/// # Errors
/// Database errors.
pub fn forget_profile(conn: &Connection, profile_id: &str) -> IpcResult<()> {
    conn.execute("DELETE FROM approvals WHERE profile_id = ?1", [profile_id])?;
    Ok(())
}

/// The error returned when the user declines (or no dialog could be shown).
#[must_use]
pub fn not_approved() -> IpcError {
    IpcError::new(
        ErrorCode::NotApproved,
        "The command was not approved, so nothing was run",
    )
}

/// Most argument lines shown in one dialog; the rest is summarised.
const MAX_LINES: usize = 40;
/// Longest single line shown.
const MAX_LINE: usize = 200;

/// Builds the dialog text: the context lines, then each section's arguments one per line,
/// with invisible characters made visible and lengths capped.
#[must_use]
pub fn message(context: &[(&str, &str)], sections: &[(&str, Vec<String>)], footer: &str) -> String {
    let mut out = String::new();
    for (label, value) in context {
        out.push_str(label);
        out.push_str(": ");
        out.push_str(&make_visible(value, MAX_LINE));
        out.push('\n');
    }
    let mut shown = 0usize;
    let mut hidden = 0usize;
    for (label, lines) in sections {
        out.push('\n');
        out.push_str(label);
        out.push_str(":\n");
        if lines.is_empty() {
            out.push_str("  (none)\n");
        }
        for l in lines {
            if shown >= MAX_LINES {
                hidden += 1;
                continue;
            }
            out.push_str("  ");
            out.push_str(&make_visible(l, MAX_LINE));
            out.push('\n');
            shown += 1;
        }
    }
    if hidden > 0 {
        out.push_str(&format!("  … and {hidden} more\n"));
    }
    out.push('\n');
    out.push_str(footer);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_changes_with_any_argument() {
        let a = mcp_stdio_fingerprint("npx", &["a".into()], &[], &[]);
        let b = mcp_stdio_fingerprint("npx", &["b".into()], &[], &[]);
        assert_ne!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn message_lists_one_argument_per_line_and_escapes_bidi() {
        let m = message(
            &[("Profile", "Work")],
            &[("Arguments", vec!["-c".into(), "x\u{202e}y".into()])],
            "end",
        );
        assert!(m.contains("Arguments:\n  -c\n  x\\u{202e}y\n"), "{m}");
    }
}
