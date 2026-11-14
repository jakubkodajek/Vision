//! Environment allowlist and PATH resolution (spec §2.4, `docs/PLAN.md` §6.6).
//!
//! The environment of every status command, terminal and MCP probe is *built* from an
//! allowlist, not filtered, so overriding credentials such as `ANTHROPIC_API_KEY`,
//! `GH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` can never reach a profile's tools.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::process::{CommandRunner, CommandSpec};

/// An environment as an ordered list of variables.
pub type EnvVars = Vec<(OsString, OsString)>;

/// Variables copied from the parent environment when present (besides `LC_*`).
/// `PATH` is not in the list: it is always set to the resolved value.
pub const ALLOWED_VARS: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
];

/// Returns whether a parent variable may pass. `case_insensitive` mirrors Windows rules.
#[must_use]
pub fn is_allowed(name: &str, case_insensitive: bool) -> bool {
    if name.starts_with("LC_") {
        return true;
    }
    if case_insensitive {
        ALLOWED_VARS.iter().any(|a| a.eq_ignore_ascii_case(name))
    } else {
        ALLOWED_VARS.contains(&name)
    }
}

/// Builds an environment: allowlisted parent variables, `PATH` = `path`, then `extra`
/// (tool config variables, MCP server variables), which override earlier entries.
///
/// Pure function; `case_insensitive` should be `cfg!(windows)`.
#[must_use]
pub fn build_env_with(
    parent: &[(OsString, OsString)],
    path: &OsStr,
    extra: &[(OsString, OsString)],
    case_insensitive: bool,
) -> EnvVars {
    let key = |k: &OsStr| -> String {
        let s = k.to_string_lossy().into_owned();
        if case_insensitive {
            s.to_ascii_uppercase()
        } else {
            s
        }
    };
    let mut out: EnvVars = Vec::new();
    let push = |k: &OsStr, v: &OsStr, out: &mut EnvVars| {
        let kk = key(k);
        out.retain(|(ek, _)| key(ek) != kk);
        out.push((k.to_owned(), v.to_owned()));
    };
    for (k, v) in parent {
        let Some(name) = k.to_str() else { continue };
        if key(k) == "PATH" {
            continue;
        }
        if is_allowed(name, case_insensitive) {
            push(k, v, &mut out);
        }
    }
    push(OsStr::new("PATH"), path, &mut out);
    for (k, v) in extra {
        push(k, v, &mut out);
    }
    out
}

/// [`build_env_with`] using the current platform's case rules.
#[must_use]
pub fn build_env(
    parent: &[(OsString, OsString)],
    path: &OsStr,
    extra: &[(OsString, OsString)],
) -> EnvVars {
    build_env_with(parent, path, extra, cfg!(windows))
}

/// Looks up a variable in an environment list.
#[must_use]
pub fn lookup<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsStr> {
    env.iter()
        .rev()
        .find(|(k, _)| {
            k.to_str().is_some_and(|k| {
                if cfg!(windows) {
                    k.eq_ignore_ascii_case(name)
                } else {
                    k == name
                }
            })
        })
        .map(|(_, v)| v.as_os_str())
}

const MARK_START: &str = "__VISION_PATH__";
const MARK_END: &str = "__END__";

/// Extracts the PATH printed between the markers by the login shell.
#[must_use]
pub fn parse_marked_path(output: &str) -> Option<String> {
    let start = output.find(MARK_START)? + MARK_START.len();
    let len = output[start..].find(MARK_END)?;
    let path = output[start..start + len].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_owned())
    }
}

/// Well-known install directories appended to `PATH` when they exist.
#[must_use]
pub fn well_known_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(h) = home {
        for rel in [
            ".local/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".claude/local",
            "google-cloud-sdk/bin",
        ] {
            v.push(h.join(rel));
        }
    }
    v
}

/// Appends the existing directories from `extra` to `base`, removing duplicates.
#[must_use]
pub fn join_path(base: &OsStr, extra: &[PathBuf]) -> OsString {
    let mut seen = BTreeSet::new();
    let mut dirs: Vec<PathBuf> = Vec::new();
    for d in std::env::split_paths(base).chain(extra.iter().filter(|d| d.is_dir()).cloned()) {
        if d.as_os_str().is_empty() {
            continue;
        }
        if seen.insert(d.clone()) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| base.to_owned())
}

/// Resolves the `PATH` for child processes.
///
/// On Unix this asks the user's login shell (`$SHELL -ilc`, 5 s timeout) and appends the
/// well-known directories that exist; any failure falls back to the parent `PATH` plus those
/// directories. On Windows the parent `PATH` is used unchanged.
#[must_use]
pub fn resolve_path(runner: &dyn CommandRunner, parent: &[(OsString, OsString)]) -> OsString {
    let parent_path = lookup(parent, "PATH")
        .map(OsStr::to_owned)
        .unwrap_or_default();
    if cfg!(windows) {
        return parent_path;
    }
    let home = lookup(parent, "HOME").map(PathBuf::from);
    let extra = well_known_dirs(home.as_deref());
    let shell = lookup(parent, "SHELL")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.is_file())
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
    let spec = CommandSpec {
        program: shell,
        args: vec![
            OsString::from("-ilc"),
            OsString::from(format!("printf '{MARK_START}%s{MARK_END}' \"$PATH\"")),
        ],
        // The user's own shell reads its own configuration with the user's environment.
        env: parent.to_vec(),
        cwd: home.filter(|h| h.is_dir()),
        timeout: Duration::from_secs(5),
        max_output_bytes: 256 * 1024,
    };
    let from_shell = runner
        .run(&spec)
        .ok()
        .filter(|o| !o.timed_out)
        .and_then(|o| parse_marked_path(&String::from_utf8_lossy(&o.stdout)));
    match from_shell {
        Some(p) => join_path(OsStr::new(&p), &extra),
        None => join_path(&parent_path, &extra),
    }
}

/// Resolves a bare binary name to an absolute path using `path` (and `PATHEXT` semantics on
/// Windows). Names containing path separators are rejected (`None`).
#[must_use]
pub fn resolve_binary(binary: &str, path: &OsStr) -> Option<PathBuf> {
    if binary.is_empty() || binary.contains('/') || binary.contains('\\') {
        return None;
    }
    let exts: Vec<String> = if cfg!(windows) {
        let has_ext = Path::new(binary).extension().is_some();
        let mut v = if has_ext {
            vec![String::new()]
        } else {
            Vec::new()
        };
        v.extend(
            [".exe", ".cmd", ".bat", ".com"]
                .iter()
                .map(|s| (*s).to_owned()),
        );
        v
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute() {
            continue;
        }
        for ext in &exts {
            let candidate = dir.join(format!("{binary}{ext}"));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Returns whether `p` is a regular file the user may execute.
#[must_use]
pub fn is_executable(p: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(p) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}
