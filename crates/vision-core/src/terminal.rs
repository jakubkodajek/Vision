//! Opening the system terminal for sign-in (spec §2.4, `docs/PLAN.md` §6.5) and the system
//! browser for install pages.
//!
//! The core writes a launch script into `<data root>/tmp/` and asks a [`TerminalLauncher`]
//! to open it. The only shell code Vision ever generates is this script; every value in it
//! goes through [`sh_quote`] (Unix) or [`cmd_quote`] (Windows). The script contains
//! directory paths and allowlisted variables only, never a secret.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::env::{lookup, resolve_binary};
use crate::ipc::{ErrorCode, IpcError, IpcResult};

/// Quotes `s` as one POSIX shell word: `'...'` with each `'` written as `'\''`.
///
/// Safe for any input without NUL (a NUL cannot be passed in argv at all): quotes, spaces,
/// `$`, backticks, backslashes, globs and newlines all stay literal.
#[must_use]
pub fn sh_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Quotes `s` as one argument in a Windows batch file.
///
/// The value is wrapped in double quotes (so `& | < > ^` are literal), `%` is doubled (batch
/// expansion) and trailing backslashes are doubled (`CommandLineToArgvW` rules).
///
/// # Errors
/// `invalid_input` for values containing `"`, CR, LF or NUL, which cannot be represented
/// safely in a batch file.
pub fn cmd_quote(s: &str) -> IpcResult<String> {
    if s.contains(['"', '\r', '\n', '\0']) {
        return Err(IpcError::invalid_input(
            "Values with double quotes or line breaks cannot be passed to the Windows terminal",
        ));
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        if c == '%' {
            out.push_str("%%");
        } else {
            out.push(c);
        }
    }
    let trailing = s.chars().rev().take_while(|c| *c == '\\').count();
    out.push_str(&"\\".repeat(trailing));
    out.push('"');
    Ok(out)
}

/// Reduces user-typed text (a profile or tool name) to characters that are inert in every
/// script flavour, for the informational header line.
#[must_use]
pub fn display_safe(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | ',' | ':') {
                c
            } else {
                '?'
            }
        })
        .collect()
}

/// What the generated script should do.
#[derive(Debug, Clone)]
pub struct LaunchScript {
    /// Header line, e.g. `Vision: profile Work, Claude Code sign-in`.
    pub title: String,
    /// The full environment of the command (allowlisted and built by the core).
    pub env: Vec<(OsString, OsString)>,
    /// Absolute program path followed by its arguments.
    pub argv: Vec<String>,
    /// Keep the window open after the command finishes.
    pub keep_open: bool,
}

/// Script flavour.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScriptFlavor {
    /// POSIX `sh` (macOS `.command`, Linux `.sh`).
    Posix,
    /// Windows batch (`.cmd`).
    Cmd,
}

impl ScriptFlavor {
    /// Flavour for the current OS.
    #[must_use]
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Cmd
        } else {
            Self::Posix
        }
    }

    /// File extension.
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Posix if cfg!(target_os = "macos") => "command",
            Self::Posix => "sh",
            Self::Cmd => "cmd",
        }
    }
}

fn env_pairs(env: &[(OsString, OsString)]) -> IpcResult<Vec<(String, String)>> {
    env.iter()
        .map(|(k, v)| {
            let k = k
                .to_str()
                .filter(|k| {
                    !k.is_empty()
                        && k.bytes().all(|b| {
                            b.is_ascii_alphanumeric() || b == b'_' || b == b'(' || b == b')'
                        })
                })
                .ok_or_else(|| IpcError::invalid_input("Invalid environment variable name"))?;
            let v = v
                .to_str()
                .ok_or_else(|| IpcError::invalid_input("Environment values must be valid UTF-8"))?;
            if v.contains('\0') {
                return Err(IpcError::invalid_input(
                    "Environment values cannot contain NUL",
                ));
            }
            Ok((k.to_owned(), v.to_owned()))
        })
        .collect()
}

/// Renders a POSIX `sh` launch script. The command runs under `env -i` with exactly the
/// given variables, so whatever the terminal's own environment holds cannot leak in.
///
/// # Errors
/// `invalid_input` for non-UTF-8 values or NUL bytes.
pub fn render_posix(script: &LaunchScript) -> IpcResult<String> {
    if script.argv.is_empty() || script.argv.iter().any(|a| a.contains('\0')) {
        return Err(IpcError::invalid_input("Invalid command"));
    }
    let mut s = String::from(
        "#!/bin/sh\n# Generated by Vision. Contains directory paths only, never a secret.\n",
    );
    s.push_str(&format!(
        "printf '%s\\n\\n' {}\n",
        sh_quote(&display_safe(&script.title))
    ));
    s.push_str("/usr/bin/env -i");
    // The terminal's own TERM describes the window the command runs in; this is a fixed
    // string generated by Vision, the only expansion in the script.
    s.push_str(" \\\n  \"TERM=${TERM:-xterm-256color}\"");
    for (k, v) in env_pairs(&script.env)? {
        if k == "TERM" {
            continue;
        }
        s.push_str(" \\\n  ");
        s.push_str(&sh_quote(&format!("{k}={v}")));
    }
    for a in &script.argv {
        s.push_str(" \\\n  ");
        s.push_str(&sh_quote(a));
    }
    s.push('\n');
    if script.keep_open {
        s.push_str("printf '\\n%s\\n' 'Finished. Press Enter to close this window.'\nread _\n");
    }
    Ok(s)
}

/// Renders a Windows batch launch script. The launcher starts it with exactly the built
/// environment; the script sets the same variables again for clarity.
///
/// # Errors
/// `invalid_input` for values that [`cmd_quote`] rejects.
pub fn render_cmd(script: &LaunchScript) -> IpcResult<String> {
    if script.argv.is_empty() {
        return Err(IpcError::invalid_input("Invalid command"));
    }
    let mut s = String::from(
        "@echo off\r\nrem Generated by Vision. Contains directory paths only, never a secret.\r\nsetlocal DisableDelayedExpansion\r\n",
    );
    s.push_str(&format!(
        "echo {}\r\necho.\r\n",
        display_safe(&script.title)
    ));
    for (k, v) in env_pairs(&script.env)? {
        let q = cmd_quote(&format!("{k}={v}"))?;
        s.push_str(&format!("set {q}\r\n"));
    }
    let argv: IpcResult<Vec<String>> = script.argv.iter().map(|a| cmd_quote(a)).collect();
    s.push_str(&argv?.join(" "));
    s.push_str("\r\n");
    if script.keep_open {
        s.push_str("echo.\r\npause\r\n");
    }
    Ok(s)
}

/// Renders a script in the given flavour.
///
/// # Errors
/// See [`render_posix`] and [`render_cmd`].
pub fn render(script: &LaunchScript, flavor: ScriptFlavor) -> IpcResult<String> {
    match flavor {
        ScriptFlavor::Posix => render_posix(script),
        ScriptFlavor::Cmd => render_cmd(script),
    }
}

/// Opens the system terminal on a launch script.
pub trait TerminalLauncher: Send + Sync {
    /// Opens a terminal window running `script`. `env` is the built environment (used as
    /// the process environment where the OS passes it through, i.e. on Windows).
    ///
    /// # Errors
    /// `terminal_unavailable` when no terminal can be opened.
    fn launch(&self, script: &Path, env: &[(OsString, OsString)]) -> IpcResult<()>;
}

/// Opens a URL in the system browser.
pub trait UrlOpener: Send + Sync {
    /// Opens `url` (already validated as `https://`).
    ///
    /// # Errors
    /// `internal` when the opener cannot be started.
    fn open(&self, url: &str) -> IpcResult<()>;
}

fn terminal_unavailable(msg: &str) -> IpcError {
    IpcError::new(ErrorCode::TerminalUnavailable, msg)
}

/// Spawns a GUI helper detached and reaps it in the background.
fn spawn_detached(mut cmd: Command) -> std::io::Result<()> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn()?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// The real system terminal: macOS Terminal.app, the first available Linux emulator, or a
/// new Windows console.
#[derive(Debug, Clone)]
pub struct SystemTerminalLauncher {
    /// The app's own environment, which a GUI terminal needs (`DISPLAY`, `WAYLAND_DISPLAY`,
    /// `DBUS_SESSION_BUS_ADDRESS`). The command inside still runs under `env -i`.
    pub gui_env: Vec<(OsString, OsString)>,
}

impl SystemTerminalLauncher {
    /// Linux terminal emulators tried in order, with the flag that precedes the script.
    pub const LINUX_TERMINALS: &[(&'static str, &'static str)] = &[
        ("x-terminal-emulator", "-e"),
        ("gnome-terminal", "--"),
        ("konsole", "-e"),
        ("xterm", "-e"),
    ];
}

impl TerminalLauncher for SystemTerminalLauncher {
    fn launch(&self, script: &Path, env: &[(OsString, OsString)]) -> IpcResult<()> {
        let fail = |_| terminal_unavailable("The system terminal could not be opened");
        if cfg!(target_os = "macos") {
            let mut c = Command::new("/usr/bin/open");
            c.arg("-a").arg("Terminal").arg(script);
            spawn_detached(c).map_err(fail)
        } else if cfg!(windows) {
            let system_root = lookup(env, "SystemRoot")
                .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
            let mut c = Command::new(system_root.join("System32").join("cmd.exe"));
            c.arg("/d").arg("/c").arg("start").arg("Vision").arg(script);
            c.env_clear().envs(env.iter().map(|(k, v)| (k, v)));
            spawn_detached(c).map_err(fail)
        } else {
            let path = lookup(&self.gui_env, "PATH")
                .map(OsString::from)
                .unwrap_or_default();
            for (term, flag) in Self::LINUX_TERMINALS {
                if let Some(bin) = resolve_binary(term, &path) {
                    let mut c = Command::new(bin);
                    c.arg(flag).arg(script);
                    c.env_clear().envs(self.gui_env.iter().map(|(k, v)| (k, v)));
                    return spawn_detached(c).map_err(fail);
                }
            }
            Err(terminal_unavailable(
                "No terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)",
            ))
        }
    }
}

/// The real system browser opener.
#[derive(Debug, Clone)]
pub struct SystemUrlOpener {
    /// The app's own environment (a desktop session is needed to open a browser).
    pub gui_env: Vec<(OsString, OsString)>,
}

impl UrlOpener for SystemUrlOpener {
    fn open(&self, url: &str) -> IpcResult<()> {
        let mut c = if cfg!(target_os = "macos") {
            Command::new("/usr/bin/open")
        } else if cfg!(windows) {
            let mut c = Command::new("rundll32");
            c.arg("url.dll,FileProtocolHandler");
            c
        } else {
            let path = lookup(&self.gui_env, "PATH")
                .map(OsString::from)
                .unwrap_or_default();
            let bin = resolve_binary("xdg-open", &path)
                .ok_or_else(|| IpcError::internal("xdg-open was not found"))?;
            Command::new(bin)
        };
        c.arg(url);
        c.env_clear().envs(self.gui_env.iter().map(|(k, v)| (k, v)));
        spawn_detached(c).map_err(|_| IpcError::internal("The browser could not be opened"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sh_quote_wraps_in_single_quotes() {
        assert_eq!(sh_quote("abc"), "'abc'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote("$HOME `id` \"x\""), "'$HOME `id` \"x\"'");
    }

    #[test]
    fn cmd_quote_escapes_percent_and_trailing_backslash() {
        assert_eq!(cmd_quote("a b").unwrap(), "\"a b\"");
        assert_eq!(cmd_quote("100%").unwrap(), "\"100%%\"");
        assert_eq!(cmd_quote(r"C:\dir\").unwrap(), "\"C:\\dir\\\\\"");
        assert_eq!(cmd_quote("a&b|c^d").unwrap(), "\"a&b|c^d\"");
        for bad in ["a\"b", "a\nb", "a\rb"] {
            assert!(cmd_quote(bad).is_err());
        }
    }

    #[test]
    fn display_safe_neutralises_metacharacters() {
        assert_eq!(display_safe("Work & $(rm) \"x\""), "Work ? ??rm? ?x?");
    }
}
