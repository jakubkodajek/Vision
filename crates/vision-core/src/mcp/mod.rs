//! MCP servers per profile (spec §2.5): validation, the stored form, Claude Code config
//! rendering and the health probe ([`McpProbe`]).

pub mod probe;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::ipc::{IpcError, IpcResult, KeyValueInput, KeyValueView, ValueInput, ValueView};

pub use probe::{McpProbe, ProbeOutcome, ProbeTarget, SpecMcpProbe};

/// Maximum size of one MCP message or HTTP response body (1 MiB).
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;

/// Validates a server name: `^[a-zA-Z0-9_-]{1,64}$` and not starting with `-` (so it can
/// never be read as an option by `claude mcp`).
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_name(n: &str) -> IpcResult<()> {
    let ok = !n.is_empty()
        && n.len() <= 64
        && !n.starts_with('-')
        && n.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(IpcError::invalid_input(
            "Server names use 1 to 64 letters, digits, '-' or '_' and do not start with '-'",
        ))
    }
}

/// Validates a server URL: `https://`, or `http://` only for `localhost`, `127.0.0.1` and
/// `[::1]`; no credentials in the URL.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_url(u: &str) -> IpcResult<()> {
    let bad = |m: &str| IpcError::invalid_input(m.to_owned());
    if u.len() > 2048 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad("The URL is too long or contains spaces"));
    }
    let (scheme, rest) = u
        .split_once("://")
        .ok_or_else(|| bad("The URL must start with https://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err(bad("The URL has no host"));
    }
    if authority.contains('@') {
        return Err(bad("Put credentials in a header, not in the URL"));
    }
    let uri: ureq::http::Uri = u.parse().map_err(|_| bad("The URL is not valid"))?;
    let host = uri.host().unwrap_or("").to_ascii_lowercase();
    match scheme {
        "https" if !host.is_empty() => Ok(()),
        "http" if matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1") => Ok(()),
        "http" => Err(bad(
            "Plain http:// is only allowed for localhost, 127.0.0.1 and [::1]; use https://",
        )),
        _ => Err(bad("The URL must start with https://")),
    }
}

/// Validates a stdio command: a bare program name or an absolute path.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_command(c: &str) -> IpcResult<()> {
    let bad = || {
        IpcError::invalid_input(
            "The command must be a program name (like npx) or an absolute path, without arguments",
        )
    };
    if c.is_empty() || c.len() > 1024 || c.chars().any(char::is_control) || c.starts_with('-') {
        return Err(bad());
    }
    if c.contains(['/', '\\']) {
        if std::path::Path::new(c).is_absolute() {
            Ok(())
        } else {
            Err(bad())
        }
    } else {
        crate::tools::validate_binary(c).map_err(|_| bad())
    }
}

/// Validates stdio arguments.
///
/// # Errors
/// `invalid_input` for more than 64 arguments, arguments over 4096 bytes or with NUL/CR/LF.
pub fn validate_args(args: &[String]) -> IpcResult<()> {
    if args.len() > 64
        || args
            .iter()
            .any(|a| a.len() > 4096 || a.contains(['\0', '\n', '\r']))
    {
        return Err(IpcError::invalid_input(
            "Use at most 64 arguments of up to 4096 characters, without line breaks",
        ));
    }
    Ok(())
}

/// Headers Vision sets itself; users cannot override them.
const RESERVED_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "content-length",
    "host",
    "mcp-session-id",
    "mcp-protocol-version",
    "transfer-encoding",
    "connection",
];

/// Which list an entry belongs to, for validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// Environment variable.
    Env,
    /// HTTP header.
    Header,
}

/// Validates env/header entries: names, duplicates, value characters.
///
/// # Errors
/// `invalid_input` for the first invalid entry.
pub fn validate_entries(entries: &[KeyValueInput], kind: EntryKind) -> IpcResult<()> {
    if entries.len() > 64 {
        return Err(IpcError::invalid_input("Use at most 64 entries"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for e in entries {
        let k = e.key.as_str();
        let name_ok = match kind {
            EntryKind::Env => {
                let b = k.as_bytes();
                !b.is_empty()
                    && b.len() <= 128
                    && (b[0].is_ascii_alphabetic() || b[0] == b'_')
                    && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
            }
            EntryKind::Header => {
                !k.is_empty()
                    && k.len() <= 64
                    && k.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                    && !RESERVED_HEADERS.contains(&k.to_ascii_lowercase().as_str())
            }
        };
        if !name_ok {
            return Err(IpcError::invalid_input(match kind {
                EntryKind::Env => {
                    "Variable names use letters, digits and '_' and do not start with a digit"
                }
                EntryKind::Header => {
                    "Header names use letters, digits, '-' or '_' (Accept, Content-Type and MCP headers are set by Vision)"
                }
            }));
        }
        let norm = if kind == EntryKind::Header {
            k.to_ascii_lowercase()
        } else {
            k.to_owned()
        };
        if !seen.insert(norm) {
            return Err(IpcError::invalid_input(format!("'{k}' is listed twice")));
        }
        let value = match &e.value {
            ValueInput::Plain { value } => Some(value.as_str()),
            ValueInput::Secret { value } => {
                value.as_ref().map(crate::secrets::SecretString::expose)
            }
        };
        if let Some(v) = value {
            let bad = v.len() > 8192
                || v.contains('\0')
                || (kind == EntryKind::Header && v.chars().any(char::is_control));
            if bad {
                // Never echo the value: it may be a secret.
                return Err(IpcError::invalid_input(format!(
                    "The value of '{k}' is too long or contains characters that are not allowed"
                )));
            }
        }
    }
    Ok(())
}

/// An env/header entry as stored in `profile.db`. Secret values are never stored here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredEntry {
    /// Name.
    pub key: String,
    /// Whether the value lives in the credential store.
    pub secret: bool,
    /// Plain value; always `None` for secrets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl StoredEntry {
    /// The UI view.
    #[must_use]
    pub fn view(&self) -> KeyValueView {
        KeyValueView {
            key: self.key.clone(),
            value: if self.secret {
                ValueView::Secret { has_value: true }
            } else {
                ValueView::Plain {
                    value: self.value.clone().unwrap_or_default(),
                }
            },
        }
    }
}

/// A server with every value resolved, ready for [`render_claude_config`].
#[derive(Clone, PartialEq, Eq)]
pub struct ResolvedServer {
    /// Server name.
    pub name: String,
    /// Transport with values.
    pub transport: ResolvedTransport,
}

impl std::fmt::Debug for ResolvedServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedServer")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

/// Resolved transport.
#[derive(Clone, PartialEq, Eq)]
pub enum ResolvedTransport {
    /// stdio: command, args, env (tool config variables first, then server variables).
    Stdio {
        /// Command as entered.
        command: String,
        /// Arguments.
        args: Vec<String>,
        /// Environment.
        env: Vec<(String, String)>,
    },
    /// http: url and headers.
    Http {
        /// URL.
        url: String,
        /// Headers.
        headers: Vec<(String, String)>,
    },
}

/// One Claude Code server entry (`command/args/env` or `type: "http", url, headers`).
#[must_use]
pub fn render_claude_entry(server: &ResolvedServer) -> Value {
    match &server.transport {
        ResolvedTransport::Stdio { command, args, env } => {
            let mut o = Map::new();
            o.insert("command".into(), json!(command));
            o.insert("args".into(), json!(args));
            if !env.is_empty() {
                let m: Map<String, Value> =
                    env.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                o.insert("env".into(), Value::Object(m));
            }
            Value::Object(o)
        }
        ResolvedTransport::Http { url, headers } => {
            let mut o = Map::new();
            o.insert("type".into(), json!("http"));
            o.insert("url".into(), json!(url));
            if !headers.is_empty() {
                let m: Map<String, Value> =
                    headers.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
                o.insert("headers".into(), Value::Object(m));
            }
            Value::Object(o)
        }
    }
}

/// Renders the `{"mcpServers": {...}}` document Claude Code accepts for `--mcp-config`.
/// Pure function; servers are emitted sorted by name.
#[must_use]
pub fn render_claude_config(servers: &[ResolvedServer]) -> Value {
    let mut sorted: Vec<&ResolvedServer> = servers.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    let mut m = Map::new();
    for s in sorted {
        m.insert(s.name.clone(), render_claude_entry(s));
    }
    json!({ "mcpServers": Value::Object(m) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_pattern() {
        for ok in ["github", "my_server-2", "A"] {
            assert!(validate_name(ok).is_ok(), "{ok}");
        }
        for bad in [
            "",
            "-h",
            "--scope",
            "a b",
            "a/b",
            "a.b",
            &"x".repeat(65),
            "ü",
        ] {
            assert!(validate_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn urls_require_https_except_loopback() {
        for ok in [
            "https://mcp.example.com/mcp",
            "http://localhost:3000/mcp",
            "http://127.0.0.1:8080",
            "http://[::1]:9000/x",
        ] {
            assert!(validate_url(ok).is_ok(), "{ok}");
        }
        for bad in [
            "http://example.com/mcp",
            "ftp://example.com",
            "https://user:pw@example.com",
            "https://",
            "javascript:alert(1)",
            "https://exa mple.com",
            "http://localhost.evil.com/",
            "file:///etc/passwd",
        ] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn commands_are_names_or_absolute_paths() {
        assert!(validate_command("npx").is_ok());
        assert!(validate_command("/usr/local/bin/server").is_ok() || cfg!(windows));
        for bad in [
            "",
            "npx -y foo",
            "./server",
            "bin/server",
            "-x",
            "a;b",
            "$(id)",
        ] {
            assert!(validate_command(bad).is_err(), "{bad}");
        }
    }
}
