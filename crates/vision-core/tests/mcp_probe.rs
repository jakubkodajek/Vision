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

// ---- BUG-4 .. BUG-7: stdio probe robustness ---------------------------------------------

#[test]
fn a_banner_line_before_json_rpc_is_skipped() {
    let v = run_stdio(&Harness::new(), json!({"mode": "banner"}));
    assert_eq!(v.health.status, McpHealthStatus::Ok);
}

#[test]
fn a_server_ping_during_initialize_is_answered_with_an_empty_result() {
    let v = run_stdio(&Harness::new(), json!({"mode": "ping-first"}));
    assert_eq!(v.health.status, McpHealthStatus::Ok);
}

#[test]
fn an_unsupported_server_request_is_answered_with_method_not_found() {
    let v = run_stdio(&Harness::new(), json!({"mode": "server-request"}));
    assert_eq!(v.health.status, McpHealthStatus::Ok);
}

#[test]
fn a_repeated_cursor_ends_the_tool_listing() {
    let v = run_stdio(&Harness::new(), json!({"mode": "same-cursor"}));
    assert_eq!(v.health.status, McpHealthStatus::Ok);
}

#[test]
fn tools_repeated_across_pages_are_listed_once() {
    let v = run_stdio(&Harness::new(), json!({"mode": "same-cursor"}));
    assert_eq!(
        v.health
            .tools
            .iter()
            .map(|t| t.name.as_str())
            .collect::<Vec<_>>(),
        vec!["echo"]
    );
}

#[test]
fn an_early_exit_reports_the_exit_code() {
    let v = run_stdio(&Harness::new(), json!({"mode": "stderr-exit"}));
    let msg = v.health.message.unwrap_or_default();
    assert!(msg.contains("exit code 3"), "{msg}");
}

#[test]
fn an_early_exit_reports_the_last_non_empty_stderr_line() {
    let v = run_stdio(&Harness::new(), json!({"mode": "stderr-exit"}));
    let msg = v.health.message.unwrap_or_default();
    assert!(
        msg.contains("GITHUB_TOKEN is required") && !msg.contains("Starting server"),
        "{msg}"
    );
}

#[test]
fn a_missing_command_says_it_was_not_found() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "does-not-exist");
    let msg = test(&core, &p.id, &s.id).health.message.unwrap_or_default();
    assert!(msg.contains("not found"), "{msg}");
}

// ---- BUG-1 / BUG-2 / AC16: a probe never resurrects or reverts data ---------------------

/// Starts `mcp_test` of a slow server on another thread, waits until the server process is
/// running, runs `during`, and returns the probe's result.
fn race(
    during: impl FnOnce(&Core, &str, &str),
) -> (
    vision_core::ipc::IpcResult<McpServerView>,
    Core,
    String,
    Harness,
) {
    let h = Harness::new();
    let pids = h.path("pids.txt");
    h.install_fake(
        "fake-mcp",
        json!({"mcp": {"mode": "ok", "init_delay_ms": 1500, "pid_file": pids.to_str().unwrap()}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "fake-mcp");
    let result = std::thread::scope(|scope| {
        let probing = scope.spawn(|| {
            core.mcp_test(McpServerArgs {
                profile_id: p.id.clone(),
                server_id: s.id.clone(),
            })
        });
        let started = Instant::now();
        while !pids.exists() && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        during(&core, &p.id, &s.id);
        probing.join().unwrap()
    });
    (result, core, p.id, h)
}

fn rename(core: &Core, pid: &str, id: &str) {
    core.mcp_save(McpSaveArgs {
        profile_id: pid.into(),
        server: McpServerInput {
            id: Some(id.into()),
            name: "renamed".into(),
            transport: McpTransportInput::Stdio {
                command: "fake-mcp".into(),
                args: vec![],
                env: vec![],
            },
            tool_ids: vec![],
            enabled: false,
        },
    })
    .unwrap();
}

fn listed(core: &Core, pid: &str) -> Vec<McpServerView> {
    core.mcp_list(vision_core::ipc::ProfileScopeArgs {
        profile_id: pid.into(),
    })
    .unwrap()
}

#[test]
fn a_probe_finishing_after_an_edit_keeps_the_edit() {
    let (_, core, pid, _h) = race(rename);
    assert_eq!(
        listed(&core, &pid)
            .iter()
            .map(|s| (s.name.clone(), s.enabled))
            .collect::<Vec<_>>(),
        vec![("renamed".to_owned(), false)]
    );
}

#[test]
fn a_probe_finishing_after_an_edit_stores_no_stale_health() {
    let (_, core, pid, _h) = race(rename);
    assert_eq!(
        listed(&core, &pid)[0].health.status,
        McpHealthStatus::Untested
    );
}

#[test]
fn a_probe_finishing_after_an_edit_returns_the_current_server() {
    let (result, _, _, _h) = race(rename);
    assert_eq!(result.unwrap().name, "renamed");
}

#[test]
fn a_probe_finishing_after_a_delete_does_not_resurrect_the_server() {
    let (_, core, pid, _h) = race(|core, pid, id| {
        core.mcp_delete(McpServerArgs {
            profile_id: pid.into(),
            server_id: id.into(),
        })
        .unwrap();
    });
    assert!(listed(&core, &pid).is_empty());
}

#[test]
fn a_probe_finishing_after_a_delete_is_not_found() {
    let (result, _, _, _h) = race(|core, pid, id| {
        core.mcp_delete(McpServerArgs {
            profile_id: pid.into(),
            server_id: id.into(),
        })
        .unwrap();
    });
    assert_eq!(
        result.unwrap_err().code,
        vision_core::ipc::ErrorCode::NotFound
    );
}

// ---- HTTP: redirects, silent streams, server requests in SSE ----------------------------

#[test]
fn an_http_redirect_names_its_target() {
    let (v, _) = run_http(
        Arc::new(|_: &Request| {
            response(
                "302 Found",
                "text/plain",
                "Location: https://login.example.com/next\r\n",
                "",
            )
        }),
        vec![],
    );
    let msg = v.health.message.unwrap_or_default();
    assert!(msg.contains("https://login.example.com/next"), "{msg}");
}

#[test]
fn a_silent_event_stream_times_out_with_a_message() {
    let (v, _) = run_http(
        Arc::new(|_: &Request| {
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n".to_owned()
        }),
        vec![],
    );
    let msg = v.health.message.unwrap_or_default();
    assert!(
        v.health.status == McpHealthStatus::Error && msg.contains("stayed open"),
        "{msg}"
    );
}

fn sse_ping_handler() -> Handler {
    let inner = mcp_handler(true);
    Arc::new(move |req: &Request| {
        let msg: Value = serde_json::from_str(&req.body).unwrap_or(Value::Null);
        if msg["method"] == "initialize" {
            let rpc = json!({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "http-fake", "version": "9"}}});
            let body = format!(
                "event: message\ndata: {{\"jsonrpc\":\"2.0\",\"id\":\"srv-ping-1\",\"method\":\"ping\"}}\n\nevent: message\ndata: {rpc}\n\n"
            );
            return response(
                "200 OK",
                "text/event-stream",
                "Mcp-Session-Id: sess-123\r\n",
                &body,
            );
        }
        inner(req)
    })
}

#[test]
fn a_ping_inside_an_event_stream_is_answered_with_an_empty_result() {
    let (_, log) = run_http(sse_ping_handler(), vec![]);
    let answered = log.lock().unwrap().iter().any(|r| {
        serde_json::from_str::<Value>(&r.body).ok()
            == Some(json!({"jsonrpc": "2.0", "id": "srv-ping-1", "result": {}}))
    });
    assert!(answered);
}

#[test]
fn a_ping_inside_an_event_stream_does_not_break_the_probe() {
    let (v, _) = run_http(sse_ping_handler(), vec![]);
    assert_eq!(v.health.status, McpHealthStatus::Ok);
}

#[test]
fn keepalive_comments_do_not_extend_the_probe_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://127.0.0.1:{}/mcp",
        listener.local_addr().unwrap().port()
    );
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n",
                );
                for _ in 0..100 {
                    if stream.write_all(b"d\r\n: keepalive\n\n\r\n").is_err() {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            });
        }
    });
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = http_server(&core, &p.id, &url, vec![]);
    let started = Instant::now();
    let v = test(&core, &p.id, &s.id);
    assert!(
        v.health.status == McpHealthStatus::Error && started.elapsed() < Duration::from_secs(9),
        "{:?} after {:?}",
        v.health.message,
        started.elapsed()
    );
}

#[test]
fn other_commands_stay_responsive_during_a_slow_probe() {
    let h = Harness::new();
    let pids = h.path("pids.txt");
    h.install_fake(
        "fake-mcp",
        json!({"mcp": {"mode": "ok", "init_delay_ms": 2000, "pid_file": pids.to_str().unwrap()}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "fake-mcp");
    let listed_in = std::thread::scope(|scope| {
        let probing = scope.spawn(|| test(&core, &p.id, &s.id));
        let started = Instant::now();
        while !pids.exists() && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let t = Instant::now();
        core.mcp_list(vision_core::ipc::ProfileScopeArgs {
            profile_id: p.id.clone(),
        })
        .unwrap();
        let listed_in = t.elapsed();
        probing.join().unwrap();
        listed_in
    });
    assert!(listed_in < Duration::from_millis(500), "{listed_in:?}");
}

// ---- A5: saving or toggling without changing what runs keeps the health -------------------

fn tested_server(h: &Harness) -> (Core, String, McpServerView) {
    h.install_fake("fake-mcp", json!({ "mcp": {"mode": "ok"} }));
    let core = h.core();
    let p = create_profile(&core, "Work");
    let s = stdio_server(&core, &p.id, "fake-mcp");
    let v = test(&core, &p.id, &s.id);
    (core, p.id, v)
}

fn resave(core: &Core, pid: &str, id: &str, command: &str, enabled: bool) -> McpServerView {
    core.mcp_save(McpSaveArgs {
        profile_id: pid.into(),
        server: McpServerInput {
            id: Some(id.into()),
            name: "fake".into(),
            transport: McpTransportInput::Stdio {
                command: command.into(),
                args: vec![],
                env: vec![],
            },
            tool_ids: vec![],
            enabled,
        },
    })
    .unwrap()
}

#[test]
fn saving_with_only_enabled_changed_keeps_the_health() {
    let h = Harness::new();
    let (core, pid, v) = tested_server(&h);
    let saved = resave(&core, &pid, &v.id, "fake-mcp", false);
    assert_eq!(saved.health, v.health);
}

#[test]
fn saving_a_changed_command_resets_the_health() {
    let h = Harness::new();
    let (core, pid, v) = tested_server(&h);
    let saved = resave(&core, &pid, &v.id, "other-mcp", true);
    assert_eq!(saved.health.status, McpHealthStatus::Untested);
}

#[test]
fn set_enabled_changes_only_enabled_and_keeps_the_health() {
    let h = Harness::new();
    let (core, pid, v) = tested_server(&h);
    let toggled = core
        .mcp_set_enabled(vision_core::ipc::McpSetEnabledArgs {
            profile_id: pid,
            server_id: v.id.clone(),
            enabled: false,
        })
        .unwrap();
    assert_eq!(
        (toggled.enabled, toggled.health, toggled.transport),
        (false, v.health, v.transport)
    );
}

#[test]
fn set_enabled_of_an_unknown_server_is_not_found() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let e = core
        .mcp_set_enabled(vision_core::ipc::McpSetEnabledArgs {
            profile_id: p.id,
            server_id: "m_aaaaaaaaaaaa".into(),
            enabled: true,
        })
        .unwrap_err();
    assert_eq!(e.code, vision_core::ErrorCode::NotFound);
}
