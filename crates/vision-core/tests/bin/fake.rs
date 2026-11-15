//! Test fixture: a fake CLI and fake MCP server, used only by vision-core's integration
//! tests. Tests copy (hard-link) this binary under a tool's name, e.g. `claude`, and write
//! `<name>.fake.json` next to it describing how to behave:
//!
//! ```json
//! { "responses": [{ "args": ["auth", "status"], "stdout": "...", "stderr": "", "exit": 0, "sleep_ms": 0,
//!                   "daemon_ms": 0, "big_stdout_bytes": 0, "big_stderr_bytes": 0 }],
//!   "default": { "stdout": "", "exit": 0 },
//!   "env_dir_response": "CLAUDE_CONFIG_DIR",
//!   "dump_env": "/path/env.txt", "log_args": "/path/args.txt",
//!   "mcp": { "mode": "ok" | "silent" | "garbage" | "huge" | "banner" | "ping-first"
//!                   | "server-request" | "same-cursor" | "stderr-exit" | "slow-init",
//!            "init_delay_ms": 0, "pid_file": "/path/pids.txt", "grandchild": true } }
//! ```
//!
//! `env_dir_response` names a variable; if `$VAR/fake-response.json` exists it is used as the
//! response (lets two profiles get different answers from one fake).
//!
//! `daemon_ms` starts a copy of the fake in its own process group (Unix) that inherits
//! stdout and stderr and sleeps that long, like an rc file that starts a background agent:
//! it escapes the runner's process-group kill and keeps the pipes open.
//! `big_stdout_bytes` / `big_stderr_bytes` write that many bytes (stderr first), more than
//! a pipe buffer holds.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

fn config() -> Value {
    let exe = std::env::current_exe().unwrap_or_default();
    let stem = exe
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path = exe.with_file_name(format!("{stem}.fake.json"));
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}))
}

fn append(path: &Path, text: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(text.as_bytes());
    }
}

fn sleep_forever() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Starts a detached copy that keeps the inherited stdout/stderr open for `ms`.
fn start_daemon(ms: u64) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let mut c = std::process::Command::new(exe);
    c.arg("--fake-sleep-ms").arg(ms.to_string());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let _ = c.spawn();
}

fn respond(r: &Value) -> ! {
    if let Some(ms) = r.get("sleep_ms").and_then(Value::as_u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
    if let Some(ms) = r.get("daemon_ms").and_then(Value::as_u64) {
        start_daemon(ms);
    }
    if let Some(n) = r.get("big_stderr_bytes").and_then(Value::as_u64) {
        let _ = std::io::stderr().write_all(&vec![b'e'; usize::try_from(n).unwrap_or(0)]);
    }
    if let Some(n) = r.get("big_stdout_bytes").and_then(Value::as_u64) {
        let _ = std::io::stdout().write_all(&vec![b'o'; usize::try_from(n).unwrap_or(0)]);
    }
    print!("{}", r.get("stdout").and_then(Value::as_str).unwrap_or(""));
    eprint!("{}", r.get("stderr").and_then(Value::as_str).unwrap_or(""));
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    let code = r.get("exit").and_then(Value::as_i64).unwrap_or(0);
    std::process::exit(i32::try_from(code).unwrap_or(1));
}

/// Reads lines until a message with `id` arrives; returns it (exits on EOF).
fn wait_for_reply(lines: &mut impl Iterator<Item = std::io::Result<String>>, id: &str) -> Value {
    for line in lines.by_ref() {
        let Ok(line) = line else { break };
        if let Ok(v) = serde_json::from_str::<Value>(&line)
            && v.get("id").and_then(Value::as_str) == Some(id)
        {
            return v;
        }
    }
    std::process::exit(0);
}

fn mcp(cfg: &Value, m: &Value) -> ! {
    let mode = m.get("mode").and_then(Value::as_str).unwrap_or("ok");
    if let Some(p) = m.get("pid_file").and_then(Value::as_str) {
        append(Path::new(p), &format!("{}\n", std::process::id()));
        if m.get("grandchild").and_then(Value::as_bool) == Some(true)
            && let Ok(exe) = std::env::current_exe()
            && let Ok(child) = std::process::Command::new(exe).arg("--fake-sleep").spawn()
        {
            append(Path::new(p), &format!("{}\n", child.id()));
        }
    }
    let mut out = std::io::stdout();
    match mode {
        "silent" => sleep_forever(),
        "garbage" => {
            let _ = writeln!(out, "this is not json at all");
            let _ = out.flush();
            sleep_forever();
        }
        "huge" => {
            let chunk = vec![b'a'; 1024 * 1024];
            for _ in 0..5 {
                let _ = out.write_all(&chunk);
            }
            let _ = writeln!(out);
            let _ = out.flush();
            sleep_forever();
        }
        "stderr-exit" => {
            eprintln!("Starting server");
            eprintln!("Error: environment variable GITHUB_TOKEN is required");
            eprintln!();
            let _ = std::io::stderr().flush();
            std::process::exit(3);
        }
        "banner" => {
            let _ = writeln!(out, "Example MCP server v1.0 running on stdio");
            let _ = out.flush();
        }
        _ => {}
    }
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    while let Some(line) = lines.next() {
        let Ok(line) = line else { break };
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = req.get("id").cloned();
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => {
                if let Some(p) = cfg.get("dump_env").and_then(Value::as_str) {
                    dump_env(Path::new(p));
                }
                if let Some(ms) = m.get("init_delay_ms").and_then(Value::as_u64) {
                    std::thread::sleep(Duration::from_millis(ms));
                }
                if mode == "ping-first" {
                    let _ = writeln!(
                        out,
                        "{}",
                        json!({"jsonrpc":"2.0","id":"srv-ping-1","method":"ping"})
                    );
                    let _ = out.flush();
                    let reply = wait_for_reply(&mut lines, "srv-ping-1");
                    if reply.get("result") != Some(&json!({})) {
                        std::process::exit(4);
                    }
                }
                if mode == "server-request" {
                    let _ = writeln!(
                        out,
                        "{}",
                        json!({"jsonrpc":"2.0","id":"srv-req-1","method":"roots/list"})
                    );
                    let _ = out.flush();
                    let reply = wait_for_reply(&mut lines, "srv-req-1");
                    if reply["error"]["code"] != json!(-32601) {
                        std::process::exit(5);
                    }
                }
                // A log notification first: clients must skip it.
                let _ = writeln!(
                    out,
                    "{}",
                    json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"starting"}})
                );
                json!({
                    "protocolVersion": req["params"]["protocolVersion"],
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "fake-mcp", "version": "1.2.3" }
                })
            }
            "tools/list" if mode == "same-cursor" => json!({
                "tools": [{ "name": "echo", "description": "Echoes its input" }],
                "nextCursor": "again"
            }),
            "tools/list" => json!({
                "tools": [
                    { "name": "echo", "description": "Echoes its input", "inputSchema": { "type": "object" } },
                    { "name": "add", "description": "Adds\u{1b}[31m two numbers", "inputSchema": { "type": "object" } }
                ]
            }),
            _ => continue,
        };
        if let Some(id) = id {
            let _ = writeln!(out, "{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

fn dump_env(path: &Path) {
    let mut s = String::from("---\n");
    for (k, v) in std::env::vars_os() {
        s.push_str(&format!(
            "{}={}\n",
            k.to_string_lossy(),
            v.to_string_lossy()
        ));
    }
    append(path, &s);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--fake-sleep") => sleep_forever(),
        Some("--fake-sleep-ms") => {
            let ms = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
            std::thread::sleep(Duration::from_millis(ms));
            std::process::exit(0);
        }
        _ => {}
    }
    let cfg = config();
    if let Some(p) = cfg.get("log_args").and_then(Value::as_str) {
        append(
            Path::new(p),
            &format!("{}\n", serde_json::to_string(&args).unwrap_or_default()),
        );
    }
    if let Some(m) = cfg.get("mcp") {
        mcp(&cfg, m);
    }
    if let Some(p) = cfg.get("dump_env").and_then(Value::as_str) {
        dump_env(Path::new(p));
    }
    if let Some(var) = cfg.get("env_dir_response").and_then(Value::as_str)
        && let Some(dir) = std::env::var_os(var)
    {
        let file = PathBuf::from(dir).join("fake-response.json");
        if let Some(r) = std::fs::read_to_string(file)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        {
            respond(&r);
        }
    }
    let responses = cfg
        .get("responses")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for r in &responses {
        let want: Vec<String> = r
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if want == args {
            respond(r);
        }
    }
    respond(cfg.get("default").unwrap_or(&json!({})));
}
