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
}

impl ToolSpec {
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

/// Variables a custom tool may not use as its config variable.
const RESERVED_VARS: &[&str] = &[
    "PATH",
    "PATHEXT",
    "IFS",
    "ENV",
    "BASH_ENV",
    "SHELLOPTS",
    "PS4",
];

fn validate_text(label: &str, s: &str, max: usize) -> IpcResult<()> {
    let n = s.chars().count();
    if n == 0 || n > max || s.chars().any(char::is_control) {
        return Err(IpcError::invalid_input(format!(
            "{label} must be 1 to {max} characters without control characters"
        )));
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

/// Validates an environment variable name for a custom tool's config variable.
///
/// # Errors
/// `invalid_input` for names outside `^[A-Z_][A-Z0-9_]{0,63}$`, allowlisted base names,
/// loader variables (`LD_*`, `DYLD_*`) and shell-startup variables.
pub fn validate_config_var(v: &str) -> IpcResult<()> {
    let b = v.as_bytes();
    let shape = !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_uppercase() || b[0] == b'_')
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_');
    let reserved = RESERVED_VARS.contains(&v)
        || crate::env::is_allowed(v, true)
        || v.starts_with("LD_")
        || v.starts_with("DYLD_");
    if !shape || reserved {
        return Err(IpcError::invalid_input(
            "The config variable must be an upper-case name like MYTOOL_CONFIG_DIR and not a system variable",
        ));
    }
    Ok(())
}

/// Validates a custom tool and turns it into a registry entry.
///
/// # Errors
/// `invalid_input` for any invalid field, `conflict` when the id is a preset id.
pub fn custom_tool_spec(input: &CustomToolInput) -> IpcResult<ToolSpec> {
    ids::validate_tool_id(&input.id)?;
    if builtin_tools().iter().any(|t| t.id == input.id) {
        return Err(IpcError::conflict("This id belongs to a built-in tool"));
    }
    validate_text("The name", input.name.trim(), 40)?;
    if let Some(d) = &input.description
        && !d.is_empty()
    {
        validate_text("The description", d, 200)?;
    }
    validate_binary(&input.binary)?;
    if let Some(u) = &input.install_url
        && !u.is_empty()
    {
        validate_https_url(u)?;
    }
    validate_config_var(&input.config_var)?;
    validate_argv("Sign-in command", &input.login, false)?;
    if let Some(s) = &input.status {
        validate_argv("Status command", s, false)?;
    }
    if let Some(s) = &input.logout {
        validate_argv("Sign-out command", s, false)?;
    }
    Ok(ToolSpec {
        id: input.id.clone(),
        name: input.name.trim().to_owned(),
        description: input.description.clone().unwrap_or_default(),
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
    })
}

// ---------------------------------------------------------------------------------------
// Status parsers
// ---------------------------------------------------------------------------------------

/// Maximum length of labels and messages taken from CLI output.
const MAX_LABEL: usize = 160;

/// Cleans untrusted text from CLI output: control characters removed, length capped.
#[must_use]
pub fn clean_text(s: &str, max: usize) -> String {
    let cleaned: String = s.chars().filter(|c| !c.is_control()).collect();
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
        clean_text(line, MAX_LABEL)
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
    if text.contains("not logged in") || text.contains("not signed in") {
        return ToolStatus::SignedOut;
    }
    if text.contains("logged in") {
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

/// Extracts a version label from `--version` output.
#[must_use]
pub fn parse_version(out: &CommandOutput) -> Option<String> {
    if out.timed_out {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(clean_text(line, 80))
}
