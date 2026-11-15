//! Tool registry, status parsers and custom-tool validation (spec §2.4, F-011, F-012).
//!
//! Vision never reads a CLI's credentials (ADR-0004): it only sets the config variables and
//! interprets the CLI's own status command. Parsers are defensive: unknown JSON fields are
//! ignored and unparseable output yields [`ToolStatus::Unknown`], never a panic.

use std::path::Path;

use serde_json::Value;

use crate::ids;
use crate::ipc::{
    ConfigEnvKind, ConfigEnvView, CustomToolInput, IpcError, IpcResult, Isolation, StatusParser,
    ToolSpecView, ToolStatus,
};
use crate::process::CommandOutput;
use crate::redact::redact;
use crate::text;

/// One config variable of a tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigEnv {
    /// Variable name.
    pub var: String,
    /// Directory or file.
    pub kind: ConfigEnvKind,
    /// Relative to `tools/<id>/`; empty means the directory itself.
    pub rel: String,
}

/// A registry entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolSpec {
    /// Tool id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Description.
    pub description: String,
    /// Binary resolved on `PATH`.
    pub binary: String,
    /// Official install page.
    pub install_url: Option<String>,
    /// Config variables.
    pub config_env: Vec<ConfigEnv>,
    /// Fixed non-secret variables.
    pub extra_env: Vec<(String, String)>,
    /// Sign-in argv.
    pub login: Vec<String>,
    /// Sign-out argv.
    pub logout: Option<Vec<String>>,
    /// Status argv.
    pub status: Option<Vec<String>>,
    /// Status argv for older CLI versions that reject `status` (gh without `--json`).
    pub status_fallback: Option<Vec<String>>,
    /// Status parser.
    pub status_parser: StatusParser,
    /// Version argv.
    pub version: Vec<String>,
    /// Isolation state.
    pub isolation: Isolation,
    /// Preset or custom.
    pub builtin: bool,
    /// For a stored custom tool that no longer validates: why. Such a tool is never run and
    /// its variable is never exported.
    pub invalid: Option<String>,
}

impl ToolSpec {
    /// Errors with `invalid_input` when this is a stored custom tool that no longer
    /// validates (it must be edited before it can run).
    ///
    /// # Errors
    /// `invalid_input` with the reason.
    pub fn ensure_runnable(&self) -> IpcResult<()> {
        match &self.invalid {
            Some(reason) => Err(IpcError::invalid_input(format!(
                "{} cannot be used until it is edited: {reason}",
                self.name
            ))),
            None => Ok(()),
        }
    }

    /// Approval fingerprint of a custom tool's executable definition.
    #[must_use]
    pub fn fingerprint(&self) -> String {
        let (var, kind) = self.config_env.first().map_or(("", "dir"), |c| {
            (
                c.var.as_str(),
                match c.kind {
                    ConfigEnvKind::Dir => "dir",
                    ConfigEnvKind::File => "file",
                },
            )
        });
        crate::approvals::custom_tool_fingerprint(
            &self.binary,
            var,
            kind,
            &self.version,
            &self.login,
            self.status.as_deref(),
            self.logout.as_deref(),
        )
    }

    /// The UI view.
    #[must_use]
    pub fn view(&self) -> ToolSpecView {
        ToolSpecView {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            binary: self.binary.clone(),
            install_url: self.install_url.clone(),
            config_env: self
                .config_env
                .iter()
                .map(|c| ConfigEnvView {
                    var: c.var.clone(),
                    kind: c.kind,
                    rel: c.rel.clone(),
                })
                .collect(),
            login: self.login.clone(),
            logout: self.logout.clone(),
            status: self.status.clone(),
            status_parser: self.status_parser,
            isolation: self.isolation,
            builtin: self.builtin,
            invalid: self.invalid.clone(),
            // Custom tools: the core fills this in from the stored approval.
            approved: self.builtin,
        }
    }

    /// Config variables with their values for a tool directory.
    #[must_use]
    pub fn env_for(&self, tool_dir: &Path) -> Vec<(String, std::path::PathBuf)> {
        self.config_env
            .iter()
            .map(|c| {
                let p = if c.rel.is_empty() {
                    tool_dir.to_path_buf()
                } else {
                    tool_dir.join(&c.rel)
                };
                (c.var.clone(), p)
            })
            .collect()
    }
}

fn argv(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|s| (*s).to_owned()).collect()
}

fn dir_env(var: &str) -> ConfigEnv {
    ConfigEnv {
        var: var.to_owned(),
        kind: ConfigEnvKind::Dir,
        rel: String::new(),
    }
}

/// The built-in presets (spec §2.4 table).
#[must_use]
pub fn builtin_tools() -> Vec<ToolSpec> {
    let base = |id: &str, name: &str, description: &str, binary: &str, url: &str| ToolSpec {
        id: id.to_owned(),
        name: name.to_owned(),
        description: description.to_owned(),
        binary: binary.to_owned(),
        install_url: Some(url.to_owned()),
        config_env: Vec::new(),
        extra_env: Vec::new(),
        login: Vec::new(),
        logout: None,
        status: None,
        status_fallback: None,
        status_parser: StatusParser::ExitCode,
        version: argv(&["--version"]),
        isolation: Isolation::Verified,
        builtin: true,
        invalid: None,
    };
    vec![
        ToolSpec {
            config_env: vec![dir_env("CLAUDE_CONFIG_DIR")],
            login: argv(&["auth", "login"]),
            logout: Some(argv(&["auth", "logout"])),
            status: Some(argv(&["auth", "status"])),
            status_parser: StatusParser::Claude,
            ..base(
                "claude",
                "Claude Code",
                "Anthropic's coding agent CLI, signed in with your Claude subscription.",
                "claude",
                "https://code.claude.com/docs/en/setup",
            )
        },
        ToolSpec {
            config_env: vec![dir_env("CODEX_HOME")],
            login: argv(&["login"]),
            logout: Some(argv(&["logout"])),
            status: Some(argv(&["login", "status"])),
            status_parser: StatusParser::Codex,
            ..base(
                "codex",
                "Codex",
                "OpenAI's coding agent CLI, signed in with your ChatGPT account.",
                "codex",
                "https://github.com/openai/codex",
            )
        },
        ToolSpec {
            config_env: vec![dir_env("GH_CONFIG_DIR")],
            login: argv(&["auth", "login", "--insecure-storage"]),
            logout: Some(argv(&["auth", "logout"])),
            status: Some(argv(&["auth", "status", "--json", "hosts"])),
            status_fallback: Some(argv(&["auth", "status"])),
            status_parser: StatusParser::Gh,
            ..base(
                "gh",
                "GitHub CLI",
                "GitHub's CLI. The token is stored in this profile's directory.",
                "gh",
                "https://cli.github.com/",
            )
        },
        ToolSpec {
            config_env: vec![dir_env("CLOUDSDK_CONFIG")],
            login: argv(&["auth", "login"]),
            logout: Some(argv(&["auth", "revoke", "--all"])),
            status: Some(argv(&["auth", "list", "--format=json"])),
            status_parser: StatusParser::Gcloud,
            isolation: Isolation::Unverified,
            ..base(
                "gcloud",
                "Google Cloud CLI",
                "Google Cloud's gcloud CLI.",
                "gcloud",
                "https://cloud.google.com/sdk/docs/install",
            )
        },
        ToolSpec {
            config_env: vec![dir_env("AZURE_CONFIG_DIR")],
            login: argv(&["login"]),
            logout: Some(argv(&["logout"])),
            status: Some(argv(&["account", "show", "--output", "json"])),
            status_parser: StatusParser::Azure,
            isolation: Isolation::Unverified,
            ..base(
                "azure",
                "Azure CLI",
                "Microsoft Azure's az CLI.",
                "az",
                "https://learn.microsoft.com/cli/azure/install-azure-cli",
            )
        },
        ToolSpec {
            config_env: vec![
                ConfigEnv {
                    var: "AWS_CONFIG_FILE".to_owned(),
                    kind: ConfigEnvKind::File,
                    rel: "config".to_owned(),
                },
                ConfigEnv {
                    var: "AWS_SHARED_CREDENTIALS_FILE".to_owned(),
                    kind: ConfigEnvKind::File,
                    rel: "credentials".to_owned(),
                },
            ],
            login: argv(&["configure"]),
            logout: None,
            status: Some(argv(&["configure", "list"])),
            status_parser: StatusParser::Aws,
            isolation: Isolation::Unverified,
            ..base(
                "aws",
                "AWS CLI",
                "Amazon Web Services' aws CLI.",
                "aws",
                "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
            )
        },
    ]
}

/// Content written to `tools/codex/config.toml` when it does not exist, so the Codex login
/// stays in the profile directory.
pub const CODEX_CONFIG: &str = "# Written by Vision: keep the Codex login inside this profile directory.\ncli_auth_credentials_store = \"file\"\n";

// ---------------------------------------------------------------------------------------
// Custom tools
// ---------------------------------------------------------------------------------------

/// Suffixes a custom tool's config variable must end with: it has to look like a config
/// location, not like a behaviour switch (`*_OPTIONS`, `*_COMMAND`, `BROWSER`, ...).
const CONFIG_VAR_SUFFIXES: &[&str] = &[
    "_CONFIG_DIR",
    "_CONFIG_HOME",
    "_HOME",
    "_CONFIG",
    "_CONFIG_FILE",
    "_DIR",
];

/// Variable families other programs read, which a custom tool must never redirect.
const RESERVED_VAR_PREFIXES: &[&str] = &[
    "XDG_",
    "GIT_",
    "PYTHON",
    "NODE_",
    "NPM_",
    "LD_",
    "DYLD_",
    "ANTHROPIC_",
    "CLAUDE_",
    "OPENAI_",
    "CODEX_",
    "GH_",
    "GITHUB_",
    "AWS_",
    "AZURE_",
    "CLOUDSDK_",
    "GOOGLE_",
    "SSH_",
];

/// Well-known config variables of other programs that do not follow the suffix rule but are
/// accepted as they are (still subject to the reserved and taken checks).
const WELL_KNOWN_CONFIG_VARS: &[&str] = &["KUBECONFIG", "DOCKER_CONFIG", "HELM_CONFIG_HOME"];

/// Single variables a custom tool must never redirect.
const RESERVED_VARS: &[&str] = &["ZDOTDIR", "HOME", "PATH", "PATHEXT", "TMPDIR"];

/// Programs that run arbitrary code given as arguments; a custom tool's binary may not be one
/// of them (compared case-insensitively, `.exe` stripped; `python*` matches any version).
const INTERPRETERS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "env",
    "node",
    "deno",
    "bun",
    "ruby",
    "perl",
    "php",
    "osascript",
    "powershell",
    "pwsh",
    "cmd",
    "wscript",
    "cscript",
    "sudo",
    "doas",
    "xargs",
    "nohup",
    "open",
    "xdg-open",
];

/// Validates a custom tool binary: [`validate_binary`] and not a shell or interpreter.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_custom_binary(b: &str) -> IpcResult<()> {
    validate_binary(b)?;
    let lower = b.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    if INTERPRETERS.contains(&stem) || stem.starts_with("python") {
        return Err(IpcError::invalid_input(
            "The binary cannot be a shell or script interpreter (sh, bash, python, node, env, powershell, cmd, ...): use the tool's own program",
        ));
    }
    Ok(())
}

/// Validates a binary name: a bare file name of `[A-Za-z0-9._+-]`, no path separators or
/// shell metacharacters, not starting with `-` or `.`.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_binary(b: &str) -> IpcResult<()> {
    let ok = !b.is_empty()
        && b.len() <= 64
        && !b.starts_with(['-', '.'])
        && b.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'+' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(IpcError::invalid_input(
            "The binary must be a plain program name (letters, digits, '.', '_', '+', '-'), without a path or shell characters",
        ))
    }
}

/// Validates an `https://` URL without credentials, whitespace or control characters.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_https_url(u: &str) -> IpcResult<()> {
    let bad = || IpcError::invalid_input("The install page must be an https:// address");
    if u.len() > 2048 || u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(bad());
    }
    let rest = u.strip_prefix("https://").ok_or_else(bad)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err(bad());
    }
    let uri: ureq::http::Uri = u.parse().map_err(|_| bad())?;
    if uri.scheme_str() != Some("https") || uri.host().is_none_or(str::is_empty) {
        return Err(bad());
    }
    Ok(())
}

/// Validates an argv list (after the binary).
///
/// # Errors
/// `invalid_input` for too many or too long arguments, or NUL / control characters.
pub fn validate_argv(label: &str, args: &[String], allow_empty: bool) -> IpcResult<()> {
    if (!allow_empty && args.is_empty()) || args.len() > 32 {
        return Err(IpcError::invalid_input(format!(
            "{label} needs 1 to 32 arguments"
        )));
    }
    for a in args {
        if a.is_empty() || a.len() > 512 || a.chars().any(char::is_control) {
            return Err(IpcError::invalid_input(format!(
                "{label}: each argument must be 1 to 512 characters without control characters"
            )));
        }
    }
    Ok(())
}

/// Validates a custom tool's config variable.
///
/// The name must match `^[A-Z][A-Z0-9_]{0,47}$`, end with one of `_CONFIG_DIR`,
/// `_CONFIG_HOME`, `_HOME`, `_CONFIG`, `_CONFIG_FILE`, `_DIR`, and must not be an
/// allowlisted base variable, a variable of a built-in tool, one of `taken` (other custom
/// tools' variables), or in a reserved family (`XDG_*`, `GIT_*`, `PYTHON*`, `NODE_*`,
/// `NPM_*`, `LD_*`, `DYLD_*`, `ANTHROPIC_*`, `CLAUDE_*`, `OPENAI_*`, `CODEX_*`, `GH_*`,
/// `GITHUB_*`, `AWS_*`, `AZURE_*`, `CLOUDSDK_*`, `GOOGLE_*`, `SSH_*`, `ZDOTDIR`, `HOME`).
/// Well-known homes of other software such as `JAVA_HOME` are accepted, and so are exactly
/// `KUBECONFIG`, `DOCKER_CONFIG` and `HELM_CONFIG_HOME`.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn validate_config_var(v: &str, taken: &[String]) -> IpcResult<()> {
    let b = v.as_bytes();
    let shape = !b.is_empty()
        && b.len() <= 48
        && b[0].is_ascii_uppercase()
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
        && (WELL_KNOWN_CONFIG_VARS.contains(&v)
            || CONFIG_VAR_SUFFIXES
                .iter()
                .any(|s| v.len() > s.len() && v.ends_with(s)));
    if !shape {
        return Err(IpcError::invalid_input(
            "The config variable must be an upper-case name ending in _CONFIG_DIR, _CONFIG_HOME, _HOME, _CONFIG, _CONFIG_FILE or _DIR, like MYTOOL_CONFIG_DIR (KUBECONFIG is also accepted)",
        ));
    }
    let builtin = builtin_tools()
        .iter()
        .flat_map(|t| t.config_env.iter().map(|c| c.var.clone()))
        .any(|b| b.eq_ignore_ascii_case(v));
    let reserved = RESERVED_VARS.contains(&v)
        || RESERVED_VAR_PREFIXES.iter().any(|p| v.starts_with(p))
        || crate::env::is_allowed(v, true);
    if builtin || reserved {
        return Err(IpcError::invalid_input(
            "This config variable is used by the system or by another program, so a custom tool cannot set it",
        ));
    }
    if taken.iter().any(|t| t.eq_ignore_ascii_case(v)) {
        return Err(IpcError::invalid_input(
            "Another custom tool already uses this config variable",
        ));
    }
    Ok(())
}

/// Validates a custom tool and turns it into a registry entry. `taken` holds the config
/// variables of the other custom tools.
///
/// Every error carries the input it belongs to in [`IpcError::field`] (`id`, `name`,
/// `description`, `binary`, `install_url`, `config_var`, `login`, `status`, `logout`).
///
/// # Errors
/// `invalid_input` for any invalid field, `conflict` when the id is a preset id.
pub fn custom_tool_spec(input: &CustomToolInput, taken: &[String]) -> IpcResult<ToolSpec> {
    let on = |field: &'static str| move |e: IpcError| e.with_field(field);
    ids::validate_tool_id(&input.id).map_err(on("id"))?;
    if builtin_tools().iter().any(|t| t.id == input.id) {
        return Err(IpcError::conflict("This id belongs to a built-in tool").with_field("id"));
    }
    let name = text::display_text("The name", &input.name, 40).map_err(on("name"))?;
    let description = match &input.description {
        Some(d) if !d.trim().is_empty() => {
            text::display_text("The description", d, 200).map_err(on("description"))?
        }
        _ => String::new(),
    };
    validate_custom_binary(&input.binary).map_err(on("binary"))?;
    if let Some(u) = &input.install_url
        && !u.is_empty()
    {
        validate_https_url(u).map_err(on("install_url"))?;
    }
    validate_config_var(&input.config_var, taken).map_err(on("config_var"))?;
    validate_argv("Sign-in command", &input.login, false).map_err(on("login"))?;
    if let Some(s) = &input.status {
        validate_argv("Status command", s, false).map_err(on("status"))?;
    }
    if let Some(s) = &input.logout {
        validate_argv("Sign-out command", s, false).map_err(on("logout"))?;
    }
    Ok(ToolSpec {
        name,
        description,
        ..unchecked_custom_tool_spec(input, None)
    })
}

/// A registry entry for a stored custom tool that no longer validates: listed (with
/// `reason`) so the user can fix it, but never run and never exported.
#[must_use]
pub fn invalid_custom_tool_spec(input: &CustomToolInput, reason: String) -> ToolSpec {
    unchecked_custom_tool_spec(input, Some(reason))
}

fn unchecked_custom_tool_spec(input: &CustomToolInput, invalid: Option<String>) -> ToolSpec {
    ToolSpec {
        id: input.id.clone(),
        name: clean_text(&input.name, 40),
        description: clean_text(input.description.as_deref().unwrap_or(""), 200),
        binary: input.binary.clone(),
        install_url: input.install_url.clone().filter(|u| !u.is_empty()),
        config_env: vec![ConfigEnv {
            var: input.config_var.clone(),
            kind: input.config_kind,
            rel: match input.config_kind {
                ConfigEnvKind::Dir => String::new(),
                ConfigEnvKind::File => "config".to_owned(),
            },
        }],
        extra_env: Vec::new(),
        login: input.login.clone(),
        logout: input.logout.clone(),
        status: input.status.clone(),
        status_fallback: None,
        status_parser: StatusParser::ExitCode,
        version: argv(&["--version"]),
        isolation: Isolation::Unverified,
        builtin: false,
        invalid,
    }
}

// ---------------------------------------------------------------------------------------
// Status parsers
// ---------------------------------------------------------------------------------------

/// Maximum length of labels and messages taken from CLI output.
const MAX_LABEL: usize = 160;

/// Cleans untrusted text from CLI or server output: control and format (bidi, zero-width)
/// characters removed, length capped.
#[must_use]
pub fn clean_text(s: &str, max: usize) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control() && !text::is_format(*c))
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.chars().count() > max {
        let mut t: String = trimmed.chars().take(max).collect();
        t.push('…');
        t
    } else {
        trimmed.to_owned()
    }
}

fn first_line(out: &CommandOutput) -> String {
    let all = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let line = all
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    if line.is_empty() {
        match out.exit_code {
            Some(c) => format!("The status command printed nothing (exit code {c})"),
            None => "The status command printed nothing".to_owned(),
        }
    } else {
        clean_text(&redact(line), MAX_LABEL)
    }
}

fn unknown(out: &CommandOutput) -> ToolStatus {
    ToolStatus::Unknown {
        message: first_line(out),
    }
}

fn signed_in(account: Option<String>, warning: Option<String>) -> ToolStatus {
    ToolStatus::SignedIn {
        account: account
            .map(|a| clean_text(&a, MAX_LABEL))
            .filter(|a| !a.is_empty()),
        warning,
    }
}

fn json_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn parse_json(out: &CommandOutput) -> Option<Value> {
    serde_json::from_slice::<Value>(&out.stdout).ok()
}

fn same_dir(a: &str, b: &Path) -> bool {
    let a = Path::new(a.trim_end_matches(['/', '\\']));
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Parses `claude auth status` (JSON; exit 0 signed in, 1 signed out).
fn parse_claude(out: &CommandOutput, tool_dir: &Path) -> ToolStatus {
    match out.exit_code {
        Some(0) => {}
        Some(1) => {
            // Exit 1 means not signed in; accept it with or without JSON.
            return ToolStatus::SignedOut;
        }
        _ => return unknown(out),
    }
    let Some(v) = parse_json(out) else {
        return unknown(out);
    };
    if v.get("loggedIn").and_then(Value::as_bool) == Some(false) {
        return ToolStatus::SignedOut;
    }
    let account = json_str(&v, "email")
        .or_else(|| json_str(&v, "orgName"))
        .or_else(|| json_str(&v, "organization"))
        .or_else(|| json_str(&v, "organizationName"))
        .map(str::to_owned);
    let mut warnings = Vec::new();
    if let Some(dir) = json_str(&v, "configDirectory")
        && !same_dir(dir, tool_dir)
    {
        warnings.push("Claude Code reports a different config directory than this profile's, so the login may be shared with other profiles");
    }
    if let Some(m) = json_str(&v, "authMethod")
        && m != "claude.ai"
    {
        warnings.push("Signed in without a claude.ai subscription login; this kind of login may not be isolated per profile");
    }
    let warning = if warnings.is_empty() {
        None
    } else {
        Some(warnings.join(". "))
    };
    signed_in(account, warning)
}

/// Parses `codex login status` text (exit codes undocumented).
fn parse_codex(out: &CommandOutput) -> ToolStatus {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
    .to_lowercase();
    // Negative phrases first; a positive answer must start a line ("Logged in using ..."),
    // so an error such as "Error: token expired, you are no longer logged in" or
    // "Could not check whether you are logged in" is not mistaken for a sign-in.
    if [
        "not logged in",
        "not signed in",
        "no longer logged in",
        "logged out",
    ]
    .iter()
    .any(|p| text.contains(p))
    {
        return ToolStatus::SignedOut;
    }
    if text
        .lines()
        .any(|l| l.trim_start().starts_with("logged in"))
    {
        // Never echo the line: with an API key it contains a key prefix.
        if text.contains("api key") {
            return signed_in(
                Some("API key".to_owned()),
                Some("Codex uses an API key, not a ChatGPT sign-in".to_owned()),
            );
        }
        if text.contains("chatgpt") {
            return signed_in(Some("ChatGPT account".to_owned()), None);
        }
        return signed_in(None, None);
    }
    unknown(out)
}

/// Parses `gh auth status --json hosts`.
fn parse_gh_json(out: &CommandOutput) -> Option<ToolStatus> {
    let v = parse_json(out)?;
    let hosts = v.get("hosts")?.as_object()?;
    let mut active = Vec::new();
    let mut failing = false;
    for (host, entries) in hosts {
        for e in entries.as_array().into_iter().flatten() {
            let state = json_str(e, "state").unwrap_or("success");
            let is_active = e.get("active").and_then(Value::as_bool).unwrap_or(true);
            if !is_active {
                continue;
            }
            if state == "success" {
                let login = json_str(e, "login").unwrap_or("unknown");
                active.push(format!("{login} ({host})"));
            } else {
                failing = true;
            }
        }
    }
    Some(if !active.is_empty() {
        signed_in(Some(active.join(", ")), None)
    } else if failing {
        ToolStatus::Unknown {
            message: "GitHub CLI reports a login that does not work any more; sign in again"
                .to_owned(),
        }
    } else {
        ToolStatus::SignedOut
    })
}

/// Parses the text of older `gh auth status`.
fn parse_gh_text(out: &CommandOutput) -> ToolStatus {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    for line in text.lines() {
        let l = line.trim().trim_start_matches(['✓', '-', ' ']);
        // "Logged in to github.com account octocat (...)" or "Logged in to github.com as octocat (...)"
        if let Some(rest) = l.strip_prefix("Logged in to ") {
            let mut parts = rest.split_whitespace();
            let host = parts.next().unwrap_or("github.com");
            let _kw = parts.next();
            let login = parts.next().unwrap_or("unknown");
            return signed_in(Some(format!("{login} ({host})")), None);
        }
    }
    let lower = text.to_lowercase();
    if lower.contains("not logged into any") || lower.contains("gh auth login") {
        return ToolStatus::SignedOut;
    }
    unknown(out)
}

/// Returns whether gh rejected `--json` (older version), so the text fallback should run.
#[must_use]
pub fn gh_needs_fallback(out: &CommandOutput) -> bool {
    out.exit_code != Some(0) && {
        let e = String::from_utf8_lossy(&out.stderr).to_lowercase();
        e.contains("unknown flag") || e.contains("unknown shorthand flag")
    }
}

/// Parses `gcloud auth list --format=json`.
fn parse_gcloud(out: &CommandOutput) -> ToolStatus {
    if out.exit_code != Some(0) {
        return unknown(out);
    }
    let Some(Value::Array(items)) = parse_json(out) else {
        return unknown(out);
    };
    let active = items
        .iter()
        .find(|i| json_str(i, "status").is_some_and(|s| s.eq_ignore_ascii_case("ACTIVE")));
    match active {
        Some(a) => signed_in(json_str(a, "account").map(str::to_owned), None),
        None => ToolStatus::SignedOut,
    }
}

/// Parses `az account show --output json`.
fn parse_azure(out: &CommandOutput) -> ToolStatus {
    if out.exit_code == Some(0) {
        let Some(v) = parse_json(out) else {
            return unknown(out);
        };
        let user = v.get("user").and_then(|u| json_str(u, "name"));
        let sub = json_str(&v, "name");
        let account = match (user, sub) {
            (Some(u), Some(s)) => Some(format!("{u} ({s})")),
            (Some(u), None) => Some(u.to_owned()),
            (None, Some(s)) => Some(s.to_owned()),
            (None, None) => None,
        };
        return signed_in(account, None);
    }
    let err = String::from_utf8_lossy(&out.stderr).to_lowercase();
    if err.contains("az login") || err.contains("no subscription") {
        return ToolStatus::SignedOut;
    }
    unknown(out)
}

/// Parses `aws configure list` (offline table).
fn parse_aws(out: &CommandOutput) -> ToolStatus {
    if out.exit_code != Some(0) {
        return unknown(out);
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut saw_table = false;
    let mut profile: Option<String> = None;
    let mut key_source: Option<String> = None;
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        match cols.first().copied() {
            Some("Name") => saw_table = true,
            Some("profile") if cols.len() >= 2 && cols[1] != "<not" => {
                profile = Some(cols[1].to_owned())
            }
            Some("access_key") if cols.len() >= 3 && cols[1] != "<not" => {
                key_source = Some(cols[2].to_owned());
            }
            _ => {}
        }
    }
    if !saw_table {
        return unknown(out);
    }
    match key_source {
        // Never echo the (masked) key itself.
        Some(src) => {
            let label = match profile {
                Some(p) => format!("profile {p}, credentials from {src}"),
                None => format!("credentials from {src}"),
            };
            signed_in(Some(label), None)
        }
        None => ToolStatus::SignedOut,
    }
}

/// Parses `exit_code` tools.
fn parse_exit_code(out: &CommandOutput) -> ToolStatus {
    match out.exit_code {
        Some(0) => signed_in(None, None),
        Some(_) => ToolStatus::SignedOut,
        None => unknown(out),
    }
}

/// Interprets a status command's output. `tool_dir` is the profile's directory for the
/// tool (Claude compares it with `configDirectory`).
#[must_use]
pub fn parse_status(parser: StatusParser, out: &CommandOutput, tool_dir: &Path) -> ToolStatus {
    if out.timed_out {
        return ToolStatus::Unknown {
            message: "The status command did not finish in time".to_owned(),
        };
    }
    match parser {
        StatusParser::Claude => parse_claude(out, tool_dir),
        StatusParser::Codex => parse_codex(out),
        StatusParser::Gh => {
            if gh_needs_fallback(out) {
                unknown(out)
            } else {
                parse_gh_json(out).unwrap_or_else(|| parse_gh_text(out))
            }
        }
        StatusParser::Gcloud => parse_gcloud(out),
        StatusParser::Azure => parse_azure(out),
        StatusParser::Aws => parse_aws(out),
        StatusParser::ExitCode => parse_exit_code(out),
    }
}

/// Extracts a version from `--version` output: only after a successful exit, from stdout
/// (stderr when stdout is empty), the first token that looks like a version
/// (`\d+\.\d+(\.\d+)?` optionally followed by `-pre`/`+build` characters); otherwise none.
#[must_use]
pub fn parse_version(out: &CommandOutput) -> Option<String> {
    if out.timed_out || out.exit_code != Some(0) {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let text = if stdout.trim().is_empty() {
        String::from_utf8_lossy(&out.stderr).into_owned()
    } else {
        stdout.into_owned()
    };
    text.split(|c: char| c.is_whitespace() || matches!(c, '(' | ')' | ',' | ';' | '"' | '\''))
        .find_map(version_token)
}

/// Returns the version part of `word` (`v1.2.3`, `1.2`, `2.1.0-beta.1`), if any.
fn version_token(word: &str) -> Option<String> {
    let w = word.trim_start_matches(['v', 'V']);
    let mut dots = 0usize;
    let mut pending_dot = false;
    let mut end = 0usize;
    let mut digits = false;
    for (i, c) in w.char_indices() {
        if c.is_ascii_digit() {
            if pending_dot {
                dots += 1;
                pending_dot = false;
            }
            digits = true;
            end = i + 1;
        } else if c == '.' && digits && dots < 2 {
            pending_dot = true;
            digits = false;
        } else {
            break;
        }
    }
    if dots == 0 {
        return None;
    }
    // Keep a pre-release/build suffix made of safe characters.
    let suffix: String = w[end..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '+' | '.'))
        .take(24)
        .collect();
    let suffix = if suffix.starts_with(['-', '+']) {
        suffix.trim_end_matches('.').to_owned()
    } else {
        String::new()
    };
    Some(format!("{}{suffix}", &w[..end]))
}
