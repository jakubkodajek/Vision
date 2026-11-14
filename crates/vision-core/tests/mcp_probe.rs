//! AC9: `mcp_test` against a fake stdio MCP server, a silent server (timeout, no leftover
//! process), garbage and oversized output, and Streamable HTTP via a local test server
//! (401 → needs_auth, JSON and SSE responses, session id).
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Harness, create_profile};
use serde_json::{Value, json};
use vision_core::Core;
use vision_core::ipc::{
    KeyValueInput, McpHealthStatus, McpSaveArgs, McpServerArgs, McpServerInput, McpServerView,
    McpToolInfo, McpTransportInput, ValueInput,
};
use vision_core::secrets::SecretString;

fn stdio_server(core: &Core, pid: &str, command: &str) -> McpServerView {
    core.mcp_save(McpSaveArgs {
        profile_id: pid.into(),
        server: McpServerInput {
            id: None,
            name: "fake".into(),
            transport: McpTransportInput::Stdio {
                command: command.into(),
                args: vec![],
                env: vec![],
            },
            tool_ids: vec![],
            enabled: true,
        },
    })
    .unwrap()
}

fn test(core: &Core, pid: &str, id: &str) -> McpServerView {
    core.mcp_test(McpServerArgs {
        profile_id: pid.into(),
        server_id: id.into(),
    })
    .unwrap()
}

fn run_stdio(h: &Harness, mcp: Value) -> McpServerView {
    h.install_fake("fake-mcp", json!({ "mcp": mcp }));
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "fake-mcp");
    test(&core, &p.id, &s.id)
}

#[test]
fn stdio_server_returns_its_tools_and_server_info() {
    let v = run_stdio(&Harness::new(), json!({"mode": "ok"}));
    assert_eq!(v.health.status, McpHealthStatus::Ok);
    assert_eq!(v.health.server_name.as_deref(), Some("fake-mcp"));
    assert_eq!(v.health.server_version.as_deref(), Some("1.2.3"));
    assert_eq!(
        v.health.tools,
        vec![
            McpToolInfo {
                name: "echo".into(),
                description: Some("Echoes its input".into())
            },
            McpToolInfo {
                name: "add".into(),
                description: Some("Adds[31m two numbers".into())
            },
        ]
    );
}

#[test]
fn health_result_is_persisted() {
    let h = Harness::new();
    h.install_fake("fake-mcp", json!({ "mcp": {"mode": "ok"} }));
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "fake-mcp");
    test(&core, &p.id, &s.id);
    let listed = core
        .mcp_list(vision_core::ipc::ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    assert_eq!(listed[0].health.tools.len(), 2);
    assert!(listed[0].health.checked_at.is_some());
}

#[test]
fn garbage_output_is_an_error_not_a_crash() {
    let v = run_stdio(&Harness::new(), json!({"mode": "garbage"}));
    assert_eq!(v.health.status, McpHealthStatus::Error);
    assert!(v.health.message.unwrap().contains("not JSON-RPC"));
}

#[test]
fn five_mib_line_is_an_error_not_a_crash() {
    let v = run_stdio(&Harness::new(), json!({"mode": "huge"}));
    assert_eq!(v.health.status, McpHealthStatus::Error);
    assert!(v.health.message.unwrap().contains("larger than 1 MiB"));
}

#[test]
fn missing_command_is_an_error() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "does-not-exist");
    let v = test(&core, &p.id, &s.id);
    assert_eq!(v.health.status, McpHealthStatus::Error);
}

#[cfg(target_os = "linux")]
fn alive(pid: u32) -> bool {
    // A zombie (state Z) is dead even if nobody reaped it yet.
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => !stat
            .rsplit(')')
            .next()
            .unwrap_or("")
            .trim_start()
            .starts_with('Z'),
        Err(_) => false,
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn silent_server_times_out_in_under_25_seconds_and_leaves_no_process() {
    let mut h = Harness::new();
    h.timeouts.mcp_probe = vision_core::Timeouts::default().mcp_probe;
    let pids = h.path("pids.txt");
    let started = Instant::now();
    let v = run_stdio(
        &h,
        json!({"mode": "silent", "pid_file": pids.to_str().unwrap(), "grandchild": true}),
    );
    let elapsed = started.elapsed();
    assert_eq!(v.health.status, McpHealthStatus::Error);
    assert!(v.health.message.unwrap().contains("did not answer"));
    assert!(elapsed < Duration::from_secs(25), "{elapsed:?}");
    let ids: Vec<u32> = common::read(&pids)
        .lines()
        .map(|l| l.parse().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "server and its grandchild recorded");
    #[cfg(unix)]
    {
        let deadline = Instant::now() + Duration::from_secs(3);
        while ids.iter().any(|p| alive(*p)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        let left: Vec<u32> = ids.iter().copied().filter(|p| alive(*p)).collect();
        assert!(left.is_empty(), "still running: {left:?}");
    }
}

// ---- Streamable HTTP -------------------------------------------------------------------

struct Request {
    method: String,
    headers: Vec<(String, String)>,
    body: String,
}

type Handler = Arc<dyn Fn(&Request) -> String + Send + Sync>;

/// A tiny HTTP/1.1 server on 127.0.0.1; `handler` returns the full raw response.
fn serve(handler: Handler) -> (String, Arc<Mutex<Vec<Request>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/mcp",
        listener.local_addr().unwrap().port()
    );
    let log = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let handler = handler.clone();
            let log = log2.clone();
            std::thread::spawn(move || handle(stream, &handler, &log));
        }
    });
    (url, log)
}

fn handle(stream: TcpStream, handler: &Handler, log: &Mutex<Vec<Request>>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut stream = stream;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let method = line.split_whitespace().next().unwrap_or("").to_owned();
        let mut headers = Vec::new();
        let mut len = 0usize;
        loop {
            let mut h = String::new();
            reader.read_line(&mut h).unwrap();
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            let (k, v) = h.split_once(':').unwrap();
            if k.eq_ignore_ascii_case("content-length") {
                len = v.trim().parse().unwrap();
            }
            headers.push((k.to_ascii_lowercase(), v.trim().to_owned()));
        }
        let mut body = vec![0; len];
        reader.read_exact(&mut body).unwrap();
        let req = Request {
            method,
            headers,
            body: String::from_utf8(body).unwrap(),
        };
        let resp = handler(&req);
        log.lock().unwrap().push(req);
        if stream.write_all(resp.as_bytes()).is_err() {
            return;
        }
    }
}

fn response(status: &str, content_type: &str, extra: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{extra}\r\n{body}",
        body.len()
    )
}

fn mcp_handler(sse: bool) -> Handler {
    Arc::new(move |req: &Request| {
        if req.method == "DELETE" {
            return response("200 OK", "text/plain", "", "");
        }
        let msg: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        let id = msg.get("id").cloned();
        let result = match msg["method"].as_str() {
            Some("initialize") => {
                json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "http-fake", "version": "9"}})
            }
            Some("tools/list") => json!({"tools": [{"name": "search", "description": "Searches"}]}),
            _ => return response("202 Accepted", "text/plain", "", ""),
        };
        let rpc = json!({"jsonrpc": "2.0", "id": id, "result": result}).to_string();
        let session = "Mcp-Session-Id: sess-123\r\n";
        if sse {
            let body = format!(
                "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}}\n\nevent: message\ndata: {rpc}\n\n"
            );
            response("200 OK", "text/event-stream", session, &body)
        } else {
            response("200 OK", "application/json", session, &rpc)
        }
    })
}

fn http_server(core: &Core, pid: &str, url: &str, headers: Vec<KeyValueInput>) -> McpServerView {
    core.mcp_save(McpSaveArgs {
        profile_id: pid.into(),
        server: McpServerInput {
            id: None,
            name: "remote".into(),
            transport: McpTransportInput::Http {
                url: url.into(),
                headers,
            },
            tool_ids: vec![],
            enabled: true,
        },
    })
    .unwrap()
}

fn run_http(
    handler: Handler,
    headers: Vec<KeyValueInput>,
) -> (McpServerView, Arc<Mutex<Vec<Request>>>) {
    let (url, log) = serve(handler);
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = http_server(&core, &p.id, &url, headers);
    (test(&core, &p.id, &s.id), log)
}

#[test]
fn http_401_is_needs_auth() {
    let (v, _) = run_http(
        Arc::new(|_: &Request| {
            response(
                "401 Unauthorized",
                "application/json",
                "WWW-Authenticate: Bearer\r\n",
                "{}",
            )
        }),
        vec![],
    );
    assert_eq!(v.health.status, McpHealthStatus::NeedsAuth);
}

#[test]
fn http_403_is_needs_auth() {
    let (v, _) = run_http(
        Arc::new(|_: &Request| response("403 Forbidden", "text/plain", "", "no")),
        vec![],
    );
    assert_eq!(v.health.status, McpHealthStatus::NeedsAuth);
}

#[test]
fn http_500_is_an_error() {
    let (v, _) = run_http(
        Arc::new(|_: &Request| response("500 Internal Server Error", "text/plain", "", "boom")),
        vec![],
    );
    assert_eq!(
        (v.health.status, v.health.message.as_deref()),
        (McpHealthStatus::Error, Some("The server answered HTTP 500"))
    );
}

#[test]
fn http_json_response_lists_tools() {
    let (v, _) = run_http(mcp_handler(false), vec![]);
    assert_eq!(v.health.status, McpHealthStatus::Ok);
    assert_eq!(v.health.tools[0].name, "search");
}

#[test]
fn http_sse_response_lists_tools() {
    let (v, _) = run_http(mcp_handler(true), vec![]);
    assert_eq!(
        (v.health.status, v.health.server_name.as_deref()),
        (McpHealthStatus::Ok, Some("http-fake"))
    );
}

#[test]
fn http_requests_carry_accept_session_id_and_user_headers() {
    let secret = KeyValueInput {
        key: "Authorization".into(),
        value: ValueInput::Secret {
            value: Some(SecretString::new("Bearer t0ken")),
        },
    };
    let (_, log) = run_http(mcp_handler(false), vec![secret]);
    let log = log.lock().unwrap();
    let header = |r: &Request, k: &str| {
        r.headers
            .iter()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.clone())
    };
    assert_eq!(
        header(&log[0], "accept").as_deref(),
        Some("application/json, text/event-stream")
    );
    assert_eq!(
        header(&log[0], "authorization").as_deref(),
        Some("Bearer t0ken")
    );
    assert_eq!(header(&log[0], "mcp-session-id"), None);
    assert_eq!(
        header(&log[1], "mcp-session-id").as_deref(),
        Some("sess-123")
    );
    assert_eq!(
        header(&log[2], "mcp-protocol-version").as_deref(),
        Some("2025-06-18")
    );
}

#[test]
fn http_oversized_response_is_an_error() {
    let big = "x".repeat(2 * 1024 * 1024);
    let (v, _) = run_http(
        Arc::new(move |_: &Request| response("200 OK", "application/json", "", &big)),
        vec![],
    );
    assert_eq!(v.health.status, McpHealthStatus::Error);
}
