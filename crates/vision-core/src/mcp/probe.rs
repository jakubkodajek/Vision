//! Minimal MCP client used for health checks, written against the MCP specification
//! (2025-06-18 transports): newline-delimited JSON-RPC over stdio, and Streamable HTTP POST
//! with `Accept: application/json, text/event-stream` (JSON or SSE response,
//! `Mcp-Session-Id`). See `memory/decisions.md` for why this is not the `rmcp` SDK.
//!
//! Every exchange has an overall deadline, every message is capped at
//! [`MAX_MESSAGE_BYTES`](super::MAX_MESSAGE_BYTES), the stdio server's whole process group
//! is killed afterwards, and server-provided text is cleaned before it reaches the UI.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::MAX_MESSAGE_BYTES;
use crate::ipc::{McpHealthStatus, McpToolInfo};
use crate::process::{GroupChild, Pipes};
use crate::secrets::SecretString;
use crate::tools::clean_text;

/// MCP protocol version Vision offers in `initialize`.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// Maximum number of tools kept from `tools/list`.
pub const MAX_TOOLS: usize = 500;
const MAX_PAGES: usize = 20;

/// What to probe.
#[derive(Debug, Clone)]
pub enum ProbeTarget {
    /// A child process.
    Stdio {
        /// Absolute program path.
        program: PathBuf,
        /// Arguments.
        args: Vec<String>,
        /// Complete environment (allowlist + tool variables + server variables).
        env: Vec<(OsString, OsString)>,
        /// Working directory.
        cwd: Option<PathBuf>,
    },
    /// A Streamable HTTP endpoint.
    Http {
        /// URL (validated).
        url: String,
        /// Extra headers; values may be secrets.
        headers: Vec<(String, SecretString)>,
    },
}

/// Result of a probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeOutcome {
    /// Outcome.
    pub status: McpHealthStatus,
    /// User-safe message for `needs_auth` and `error`.
    pub message: Option<String>,
    /// Listed tools.
    pub tools: Vec<McpToolInfo>,
    /// `serverInfo.name`.
    pub server_name: Option<String>,
    /// `serverInfo.version`.
    pub server_version: Option<String>,
}

impl ProbeOutcome {
    /// An `error` outcome.
    #[must_use]
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: McpHealthStatus::Error,
            message: Some(message.into()),
            tools: Vec::new(),
            server_name: None,
            server_version: None,
        }
    }

    fn needs_auth() -> Self {
        Self {
            status: McpHealthStatus::NeedsAuth,
            message: Some(
                "The server requires authorization (HTTP 401/403). Use Authorize to sign in."
                    .to_owned(),
            ),
            ..Self::error("")
        }
    }
}

/// Talks to an MCP server.
pub trait McpProbe: Send + Sync {
    /// Runs `initialize`, `notifications/initialized` and `tools/list` within `timeout`.
    fn probe(&self, target: &ProbeTarget, timeout: Duration) -> ProbeOutcome;
}

/// The real probe.
#[derive(Debug, Default, Clone, Copy)]
pub struct SpecMcpProbe;

impl McpProbe for SpecMcpProbe {
    fn probe(&self, target: &ProbeTarget, timeout: Duration) -> ProbeOutcome {
        let deadline = Instant::now() + timeout;
        match target {
            ProbeTarget::Stdio {
                program,
                args,
                env,
                cwd,
            } => probe_stdio(program, args, env, cwd.as_deref(), deadline, timeout),
            ProbeTarget::Http { url, headers } => probe_http(url, headers, deadline, timeout),
        }
    }
}

// ---------------------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------------------

fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "Vision", "version": env!("CARGO_PKG_VERSION") }
        }
    })
}

fn initialized_notification() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

fn tools_list_request(id: u64, cursor: Option<&str>) -> Value {
    match cursor {
        Some(c) => {
            json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list", "params": { "cursor": c } })
        }
        None => json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" }),
    }
}

/// Finds the response to `id` in a message (object or batch). `Ok(None)` when the message
/// is something else (a notification or a server request).
fn match_response(msg: &Value, id: u64) -> Result<Option<Value>, String> {
    let check = |m: &Value| -> Option<Result<Value, String>> {
        if m.get("id").and_then(Value::as_u64) != Some(id) {
            return None;
        }
        if let Some(r) = m.get("result") {
            return Some(Ok(r.clone()));
        }
        if let Some(e) = m.get("error") {
            let text = e
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Some(Err(format!(
                "The server returned an error: {}",
                clean_text(text, 200)
            )));
        }
        None
    };
    match msg {
        Value::Array(items) => {
            for i in items {
                if let Some(r) = check(i) {
                    return r.map(Some);
                }
            }
            Ok(None)
        }
        Value::Object(_) => check(msg).transpose(),
        _ => Err("The server sent output that is not JSON-RPC".to_owned()),
    }
}

struct InitInfo {
    name: Option<String>,
    version: Option<String>,
    protocol: String,
    has_tools: bool,
}

fn read_init(result: &Value) -> InitInfo {
    let info = result.get("serverInfo");
    let text = |k: &str| {
        info.and_then(|i| i.get(k))
            .and_then(Value::as_str)
            .map(|s| clean_text(s, 128))
            .filter(|s| !s.is_empty())
    };
    InitInfo {
        name: text("name"),
        version: text("version"),
        protocol: result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|p| p.len() <= 32 && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
            .unwrap_or(PROTOCOL_VERSION)
            .to_owned(),
        // Servers that omit capabilities are still asked for tools.
        has_tools: result
            .get("capabilities")
            .and_then(Value::as_object)
            .is_none_or(|c| c.contains_key("tools")),
    }
}

fn read_tools(result: &Value, into: &mut Vec<McpToolInfo>) -> Option<String> {
    for t in result
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if into.len() >= MAX_TOOLS {
            break;
        }
        let Some(name) = t.get("name").and_then(Value::as_str) else {
            continue;
        };
        let name = clean_text(name, 128);
        if name.is_empty() {
            continue;
        }
        let description = t
            .get("description")
            .and_then(Value::as_str)
            .map(|d| clean_text(d, 1024))
            .filter(|d| !d.is_empty());
        into.push(McpToolInfo { name, description });
    }
    result
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty() && c.len() <= 1024)
        .map(str::to_owned)
}

/// Runs the session over a transport-specific `call` (request → response result) and
/// `notify` functions.
fn session(
    mut call: impl FnMut(&Value, u64) -> Result<Value, Failure>,
    mut notify: impl FnMut(&Value) -> Result<(), Failure>,
) -> ProbeOutcome {
    let mut run = || -> Result<ProbeOutcome, Failure> {
        let init = read_init(&call(&initialize_request(1), 1)?);
        notify(&initialized_notification())?;
        let mut tools = Vec::new();
        if init.has_tools {
            let mut cursor: Option<String> = None;
            for page in 0..MAX_PAGES {
                let id = 2 + page as u64;
                let result = call(&tools_list_request(id, cursor.as_deref()), id)?;
                cursor = read_tools(&result, &mut tools);
                if cursor.is_none() || tools.len() >= MAX_TOOLS {
                    break;
                }
            }
        }
        Ok(ProbeOutcome {
            status: McpHealthStatus::Ok,
            message: None,
            tools,
            server_name: init.name,
            server_version: init.version,
        })
    };
    match run() {
        Ok(o) => o,
        Err(Failure::NeedsAuth) => ProbeOutcome::needs_auth(),
        Err(Failure::Error(m)) => ProbeOutcome::error(m),
    }
}

enum Failure {
    NeedsAuth,
    Error(String),
}

impl From<String> for Failure {
    fn from(s: String) -> Self {
        Self::Error(s)
    }
}

fn timeout_msg(timeout: Duration) -> String {
    format!(
        "The server did not answer within {} s",
        timeout.as_secs().max(1)
    )
}

// ---------------------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------------------

enum LineEvent {
    Line(Vec<u8>),
    TooLong,
    Eof,
}

/// Reads one `\n`-terminated line of at most `cap` bytes without buffering more than that.
fn read_line_capped(r: &mut impl BufRead, cap: usize) -> std::io::Result<LineEvent> {
    let mut line = Vec::new();
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(if line.is_empty() {
                LineEvent::Eof
            } else {
                LineEvent::Line(line)
            });
        }
        let (chunk, done) = match buf.iter().position(|b| *b == b'\n') {
            Some(i) => (&buf[..i], Some(i + 1)),
            None => (buf, None),
        };
        if line.len() + chunk.len() > cap {
            return Ok(LineEvent::TooLong);
        }
        line.extend_from_slice(chunk);
        let used = done.unwrap_or(buf.len());
        r.consume(used);
        if done.is_some() {
            return Ok(LineEvent::Line(line));
        }
    }
}

fn spawn_line_reader(out: impl Read + Send + 'static) -> mpsc::Receiver<LineEvent> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut r = BufReader::with_capacity(64 * 1024, out);
        loop {
            let ev = read_line_capped(&mut r, MAX_MESSAGE_BYTES).unwrap_or(LineEvent::Eof);
            let stop = !matches!(ev, LineEvent::Line(_));
            if tx.send(ev).is_err() || stop {
                break;
            }
        }
    });
    rx
}

fn probe_stdio(
    program: &std::path::Path,
    args: &[String],
    env: &[(OsString, OsString)],
    cwd: Option<&std::path::Path>,
    deadline: Instant,
    timeout: Duration,
) -> ProbeOutcome {
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let pipes = Pipes {
        stdin: true,
        stdout: true,
        stderr: false,
    };
    let mut child = match GroupChild::spawn(program, &args, env, cwd, pipes) {
        Ok(c) => c,
        Err(e) => return ProbeOutcome::error(format!("Could not start the server: {}", e.kind())),
    };
    let (Some(stdin), Some(stdout)) = (child.take_stdin(), child.take_stdout()) else {
        child.kill_group();
        return ProbeOutcome::error("Could not connect to the server's input and output");
    };
    let rx = spawn_line_reader(stdout);
    let stdin = std::cell::RefCell::new(stdin);
    let send = |msg: &Value| -> Result<(), Failure> {
        let mut w = stdin.borrow_mut();
        let line = format!("{msg}\n");
        w.write_all(line.as_bytes())
            .and_then(|()| w.flush())
            .map_err(|_| Failure::Error("The server closed its input before answering".to_owned()))
    };
    let outcome = session(
        |msg, id| {
            send(msg)?;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err(timeout_msg(timeout).into());
                }
                match rx.recv_timeout(left) {
                    Ok(LineEvent::Line(bytes)) => {
                        if bytes.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        let v: Value = serde_json::from_slice(&bytes).map_err(|_| {
                            Failure::Error("The server sent output that is not JSON-RPC".to_owned())
                        })?;
                        if let Some(r) = match_response(&v, id)? {
                            return Ok(r);
                        }
                    }
                    Ok(LineEvent::TooLong) => {
                        return Err("The server sent a message larger than 1 MiB"
                            .to_owned()
                            .into());
                    }
                    Ok(LineEvent::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err("The server exited before answering".to_owned().into());
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => return Err(timeout_msg(timeout).into()),
                }
            }
        },
        |msg| send(msg),
    );
    child.kill_group();
    outcome
}

// ---------------------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------------------

fn is_loopback(url: &str) -> bool {
    url.parse::<ureq::http::Uri>().is_ok_and(|u| {
        matches!(
            u.host().map(str::to_ascii_lowercase).as_deref(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
    })
}

fn agent(url: &str) -> ureq::Agent {
    use ureq::tls::{RootCerts, TlsConfig};
    let proxy = if is_loopback(url) {
        None
    } else {
        ureq::Proxy::try_from_env()
    };
    ureq::Agent::config_builder()
        .proxy(proxy)
        .http_status_as_error(false)
        // Never forward headers (possibly secrets) to another location.
        .max_redirects(0)
        .max_redirects_will_error(false)
        .tls_config(
            TlsConfig::builder()
                .root_certs(RootCerts::PlatformVerifier)
                .build(),
        )
        .user_agent(concat!(
            "Vision/",
            env!("CARGO_PKG_VERSION"),
            " (MCP health check)"
        ))
        .build()
        .into()
}

fn map_ureq(e: &ureq::Error, timeout: Duration) -> Failure {
    Failure::Error(match e {
        ureq::Error::Timeout(_) => timeout_msg(timeout),
        ureq::Error::BodyExceedsLimit(_) => {
            "The server sent a response larger than 1 MiB".to_owned()
        }
        ureq::Error::HostNotFound => "The server's host name could not be resolved".to_owned(),
        ureq::Error::ConnectionFailed | ureq::Error::Io(_) => {
            "Could not connect to the server".to_owned()
        }
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => {
            "The TLS connection to the server failed".to_owned()
        }
        _ => "The HTTP request failed".to_owned(),
    })
}

/// Reads an SSE stream until the JSON-RPC response to `id` arrives.
fn read_sse(reader: impl Read, id: u64) -> Result<Value, Failure> {
    let mut r = BufReader::new(reader);
    let mut data = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let n = r.read_line(&mut line).map_err(|e| {
            if e.to_string().to_lowercase().contains("limit") {
                Failure::Error("The server sent a response larger than 1 MiB".to_owned())
            } else {
                Failure::Error("The event stream was interrupted".to_owned())
            }
        })?;
        let l = line.trim_end_matches(['\r', '\n']);
        if n == 0 || l.is_empty() {
            if !data.is_empty() {
                let v: Value = serde_json::from_str(&data).map_err(|_| {
                    Failure::Error("The server sent an event that is not JSON-RPC".to_owned())
                })?;
                if let Some(r) = match_response(&v, id)? {
                    return Ok(r);
                }
                data.clear();
            }
            if n == 0 {
                return Err(Failure::Error(
                    "The event stream ended without a response".to_owned(),
                ));
            }
            continue;
        }
        if let Some(d) = l.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(d.strip_prefix(' ').unwrap_or(d));
        }
    }
}

struct HttpSession<'a> {
    agent: ureq::Agent,
    url: &'a str,
    headers: &'a [(String, SecretString)],
    session_id: Option<String>,
    protocol: Option<String>,
    deadline: Instant,
    timeout: Duration,
}

impl HttpSession<'_> {
    fn remaining(&self) -> Result<Duration, Failure> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            Err(Failure::Error(timeout_msg(self.timeout)))
        } else {
            Ok(left)
        }
    }

    fn post(&mut self, msg: &Value) -> Result<ureq::http::Response<ureq::Body>, Failure> {
        let mut req = self
            .agent
            .post(self.url)
            .header("Content-Type", "application/json")
            .header("Accept", "application/json, text/event-stream");
        for (k, v) in self.headers {
            req = req.header(k.as_str(), v.expose());
        }
        if let Some(s) = &self.session_id {
            req = req.header("Mcp-Session-Id", s.as_str());
        }
        if let Some(p) = &self.protocol {
            req = req.header("MCP-Protocol-Version", p.as_str());
        }
        let left = self.remaining()?;
        let resp = req
            .config()
            .timeout_global(Some(left))
            .build()
            .send(msg.to_string())
            .map_err(|e| map_ureq(&e, self.timeout))?;
        let status = resp.status().as_u16();
        if status == 401 || status == 403 {
            return Err(Failure::NeedsAuth);
        }
        if !(200..300).contains(&status) {
            return Err(Failure::Error(format!("The server answered HTTP {status}")));
        }
        Ok(resp)
    }

    fn call(&mut self, msg: &Value, id: u64) -> Result<Value, Failure> {
        let mut resp = self.post(msg)?;
        if self.session_id.is_none()
            && let Some(s) = resp
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .filter(|s| {
                    !s.is_empty() && s.len() <= 256 && s.bytes().all(|b| (0x21..=0x7e).contains(&b))
                })
        {
            self.session_id = Some(s.to_owned());
        }
        let ct = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = resp
            .body_mut()
            .with_config()
            .limit(MAX_MESSAGE_BYTES as u64);
        if ct.starts_with("text/event-stream") {
            read_sse(body.reader(), id)
        } else {
            let text = body
                .read_to_string()
                .map_err(|e| map_ureq(&e, self.timeout))?;
            let v: Value = serde_json::from_str(&text).map_err(|_| {
                Failure::Error("The server sent a response that is not JSON-RPC".to_owned())
            })?;
            match_response(&v, id)?.ok_or_else(|| {
                Failure::Error("The server's response did not answer the request".to_owned())
            })
        }
    }

    fn close(&self) {
        let Some(s) = &self.session_id else { return };
        let Ok(left) = self.remaining() else { return };
        let mut req = self
            .agent
            .delete(self.url)
            .header("Mcp-Session-Id", s.as_str());
        for (k, v) in self.headers {
            req = req.header(k.as_str(), v.expose());
        }
        let _ = req
            .config()
            .timeout_global(Some(left.min(Duration::from_secs(2))))
            .build()
            .call();
    }
}

fn probe_http(
    url: &str,
    headers: &[(String, SecretString)],
    deadline: Instant,
    timeout: Duration,
) -> ProbeOutcome {
    let s = std::cell::RefCell::new(HttpSession {
        agent: agent(url),
        url,
        headers,
        session_id: None,
        protocol: None,
        deadline,
        timeout,
    });
    let outcome = session(
        |msg, id| {
            let mut sess = s.borrow_mut();
            let r = sess.call(msg, id)?;
            if id == 1 {
                sess.protocol = Some(read_init(&r).protocol);
            }
            Ok(r)
        },
        |msg| {
            let mut sess = s.borrow_mut();
            let _ = sess.post(msg)?;
            Ok(())
        },
    );
    s.borrow().close();
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capped_reader_rejects_long_lines_and_splits_lines() {
        let data = b"{\"a\":1}\n{\"b\":2}\npartial";
        let mut r = BufReader::with_capacity(4, &data[..]);
        assert!(
            matches!(read_line_capped(&mut r, 100).unwrap(), LineEvent::Line(l) if l == b"{\"a\":1}")
        );
        assert!(
            matches!(read_line_capped(&mut r, 100).unwrap(), LineEvent::Line(l) if l == b"{\"b\":2}")
        );
        assert!(
            matches!(read_line_capped(&mut r, 100).unwrap(), LineEvent::Line(l) if l == b"partial")
        );
        assert!(matches!(
            read_line_capped(&mut r, 100).unwrap(),
            LineEvent::Eof
        ));
        let long = vec![b'a'; 1000];
        let mut r = BufReader::new(&long[..]);
        assert!(matches!(
            read_line_capped(&mut r, 100).unwrap(),
            LineEvent::TooLong
        ));
    }

    #[test]
    fn sse_parser_finds_the_matching_response() {
        let stream = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\n\n\
                      data: {\"jsonrpc\":\"2.0\",\"id\":7,\n\
                      data: \"result\":{\"ok\":true}}\n\n";
        let v = read_sse(stream.as_bytes(), 7).ok().unwrap();
        assert_eq!(v, json!({"ok": true}));
    }

    #[test]
    fn json_rpc_errors_are_cleaned() {
        let msg =
            json!({"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"bad\u{1b}[31m thing"}});
        let e = match_response(&msg, 1).unwrap_err();
        assert!(!e.contains('\u{1b}'));
    }
}
