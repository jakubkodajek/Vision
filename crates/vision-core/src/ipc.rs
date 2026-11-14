//! IPC contract (`docs/specs/real-app-foundation.md` §2.6): every request and response
//! type that crosses the Tauri boundary, plus [`IpcError`].
//!
//! Wire format rules: field names are `snake_case` exactly as in the spec; enums with data
//! are internally tagged (`kind` or `status`) so they become TypeScript discriminated
//! unions. TypeScript declarations are generated from these types with `ts-rs`
//! ([`typescript_bindings`]) into `src/ipc/bindings.ts`.

use std::fmt;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::secrets::SecretString;

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

/// Machine-readable error category returned by every command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// The request was malformed or failed validation.
    InvalidInput,
    /// A referenced profile, tool or server does not exist.
    NotFound,
    /// The request conflicts with existing data (for example a duplicate name).
    Conflict,
    /// The tool's binary was not found on `PATH`.
    NotInstalled,
    /// An operation did not finish within its time limit.
    Timeout,
    /// A file-system operation failed.
    Io,
    /// A database was written by a newer Vision; it was left untouched.
    SchemaTooNew,
    /// The OS credential store is not available; nothing was written.
    SecretStoreUnavailable,
    /// No system terminal could be opened.
    TerminalUnavailable,
    /// An unexpected internal error.
    Internal,
}

/// Error returned by every command. `message` is safe to show to the user: it never
/// contains secret values or environment dumps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct IpcError {
    /// Error category.
    pub code: ErrorCode,
    /// Human-readable, user-safe description.
    pub message: String,
}

impl IpcError {
    /// Creates an error with the given code and message.
    #[must_use]
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// Validation failure.
    #[must_use]
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    /// Missing entity.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    /// Conflicting data.
    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Conflict, message)
    }

    /// Unexpected internal failure.
    #[must_use]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    /// File-system failure.
    #[must_use]
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for IpcError {}

impl From<rusqlite::Error> for IpcError {
    fn from(e: rusqlite::Error) -> Self {
        // SQLite messages name tables and constraints, never bound values.
        Self::internal(format!("Database error: {e}"))
    }
}

impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> Self {
        // std::io::Error carries no path, so the message cannot leak one.
        Self::io(format!("File system error: {e}"))
    }
}

/// Shorthand for results returned by the core.
pub type IpcResult<T> = Result<T, IpcError>;

// ---------------------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------------------

/// Static information about the running core, exposed to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct AppInfo {
    /// Product name.
    pub name: &'static str,
    /// Version of the core crate.
    pub version: &'static str,
}

/// Operating system the core runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    /// macOS.
    Macos,
    /// Windows.
    Windows,
    /// Linux.
    Linux,
    /// Any other OS.
    Other,
}

impl Platform {
    /// The platform this binary was compiled for.
    #[must_use]
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Macos
        } else if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Other
        }
    }
}

/// Everything the UI needs on start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct Bootstrap {
    /// All profiles, oldest first.
    pub profiles: Vec<Profile>,
    /// The active profile, if any.
    pub active_profile_id: Option<String>,
    /// The OS the app runs on.
    pub platform: Platform,
}

// ---------------------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------------------

/// What a profile is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProfileKind {
    /// Work account context.
    Work,
    /// Personal account context.
    Personal,
    /// Anything else.
    Other,
}

/// Fixed accent palette of a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Accent {
    /// Iris.
    Iris,
    /// Teal.
    Teal,
    /// Amber.
    Amber,
    /// Rose.
    Rose,
    /// Green.
    Green,
}

/// A profile: an isolated set of tool logins and MCP servers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct Profile {
    /// Core-generated id (`p_` + 12 base32 characters).
    pub id: String,
    /// Display name, unique case-insensitively.
    pub name: String,
    /// Kind.
    pub kind: ProfileKind,
    /// Accent.
    pub accent: Accent,
    /// Creation time, RFC 3339 UTC.
    pub created_at: String,
}

/// Arguments of `profile_create`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ProfileCreateArgs {
    /// Name: trimmed, 1 to 40 characters, no control characters.
    pub name: String,
    /// Kind.
    pub kind: ProfileKind,
    /// Accent.
    pub accent: Accent,
}

/// Arguments of `profile_update`. Omitted fields stay unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ProfileUpdateArgs {
    /// Profile id.
    pub id: String,
    /// New name.
    #[ts(optional)]
    pub name: Option<String>,
    /// New kind.
    #[ts(optional)]
    pub kind: Option<ProfileKind>,
    /// New accent.
    #[ts(optional)]
    pub accent: Option<Accent>,
}

/// Arguments of `profile_delete`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ProfileDeleteArgs {
    /// Profile id.
    pub id: String,
    /// Must equal the profile's name exactly.
    pub confirm_name: String,
}

/// Arguments of `profile_set_active`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ProfileSetActiveArgs {
    /// Profile id.
    pub id: String,
}

/// Arguments of commands scoped to one profile (`profile_open_terminal`, `tools_list`,
/// `mcp_list`, `mcp_sync_claude`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ProfileScopeArgs {
    /// Profile id.
    pub profile_id: String,
}

// ---------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------

/// Whether a config variable points at a directory or a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ConfigEnvKind {
    /// A directory.
    Dir,
    /// A file.
    File,
}

/// How a tool's status output is interpreted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum StatusParser {
    /// `claude auth status` JSON.
    Claude,
    /// `codex login status` text.
    Codex,
    /// `gh auth status --json hosts` (text fallback).
    Gh,
    /// `gcloud auth list --format=json`.
    Gcloud,
    /// `az account show --output json`.
    Azure,
    /// `aws configure list`.
    Aws,
    /// Exit code 0 means signed in.
    ExitCode,
}

/// Whether per-profile isolation via config variables has been verified for the tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum Isolation {
    /// Verified with two profiles.
    Verified,
    /// Not verified yet.
    Unverified,
    /// The tool has no config variable; logins are shared.
    None,
}

/// One config variable of a tool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct ConfigEnvView {
    /// Variable name, e.g. `CLAUDE_CONFIG_DIR`.
    pub var: String,
    /// Directory or file.
    pub kind: ConfigEnvKind,
    /// Path relative to the profile's `tools/<id>/` directory (empty: the directory itself).
    pub rel: String,
}

/// A tool registry entry as shown to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct ToolSpecView {
    /// Tool id, `^[a-z][a-z0-9_-]{0,31}$`.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Short description.
    pub description: String,
    /// Binary name resolved on `PATH`.
    pub binary: String,
    /// Official install page (https), if any.
    pub install_url: Option<String>,
    /// Config variables pointing at the profile's directory.
    pub config_env: Vec<ConfigEnvView>,
    /// Sign-in argv (after the binary), run in the system terminal.
    pub login: Vec<String>,
    /// Sign-out argv, or `null` when the tool has none.
    pub logout: Option<Vec<String>>,
    /// Status argv, or `null` when the tool has none.
    pub status: Option<Vec<String>>,
    /// How status output is interpreted.
    pub status_parser: StatusParser,
    /// Isolation note.
    pub isolation: Isolation,
    /// `true` for presets, `false` for custom tools.
    pub builtin: bool,
}

/// Sign-in status of a tool in a profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolStatus {
    /// The binary was not found on `PATH`.
    NotInstalled,
    /// Installed, nobody signed in.
    SignedOut,
    /// Signed in.
    SignedIn {
        /// Account label (email, login, organisation), `null` if the tool does not say.
        account: Option<String>,
        /// Present when the login may not be isolated to this profile.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        warning: Option<String>,
    },
    /// The status could not be determined.
    Unknown {
        /// What went wrong (first line of output, or a timeout note).
        message: String,
    },
}

/// A tool with its cached status in one profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct ToolView {
    /// Registry entry.
    pub spec: ToolSpecView,
    /// Cached status; `null` when the tool was never checked in this profile.
    pub status: Option<ToolStatus>,
    /// Version line from the last check.
    pub version: Option<String>,
    /// Absolute binary path from the last check.
    pub binary_path: Option<String>,
    /// Time of the last check, RFC 3339 UTC.
    pub checked_at: Option<String>,
}

/// Arguments of `tool_check`, `tool_sign_in`, `tool_sign_out`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ToolArgs {
    /// Profile id.
    pub profile_id: String,
    /// Tool id.
    pub tool_id: String,
}

/// Arguments of `tool_open_install_page` and `custom_tool_delete`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct ToolIdArgs {
    /// Tool id.
    pub tool_id: String,
}

/// A user-defined tool (app scope). Its status parser is `exit_code`, isolation `unverified`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct CustomToolInput {
    /// Tool id, `^[a-z][a-z0-9_-]{0,31}$`, not a preset id. Saving an existing id updates it.
    pub id: String,
    /// Display name, 1 to 40 characters.
    pub name: String,
    /// Optional description.
    #[serde(default)]
    #[ts(optional)]
    pub description: Option<String>,
    /// Binary name: no path separators or shell metacharacters.
    pub binary: String,
    /// Install page; must be `https://`.
    #[serde(default)]
    #[ts(optional)]
    pub install_url: Option<String>,
    /// Config variable name, `^[A-Z_][A-Z0-9_]{0,63}$`.
    pub config_var: String,
    /// Whether the variable points at a directory or a file.
    pub config_kind: ConfigEnvKind,
    /// Sign-in argv after the binary.
    pub login: Vec<String>,
    /// Status argv after the binary.
    #[serde(default)]
    #[ts(optional)]
    pub status: Option<Vec<String>>,
    /// Sign-out argv after the binary.
    #[serde(default)]
    #[ts(optional)]
    pub logout: Option<Vec<String>>,
}

/// Arguments of `custom_tool_save`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct CustomToolSaveArgs {
    /// The tool.
    pub tool: CustomToolInput,
}

// ---------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------

/// A value entered for an env variable or header.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ValueInput {
    /// Stored in the profile database and shown back.
    Plain {
        /// The value.
        value: String,
    },
    /// Stored in the OS credential store, never shown back.
    Secret {
        /// New value; omit to keep the stored value of an existing entry with this key.
        #[serde(default)]
        #[ts(as = "Option<String>", optional)]
        value: Option<SecretString>,
    },
}

/// An env variable (stdio) or header (http) entry.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct KeyValueInput {
    /// Variable or header name.
    pub key: String,
    /// Its value.
    pub value: ValueInput,
}

/// A stored value as shown to the UI. Secret values are never returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ValueView {
    /// Plain value.
    Plain {
        /// The value.
        value: String,
    },
    /// Secret value held in the OS credential store.
    Secret {
        /// Always `true` for a saved secret.
        has_value: bool,
    },
}

/// A stored env variable or header.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct KeyValueView {
    /// Variable or header name.
    pub key: String,
    /// Its value.
    pub value: ValueView,
}

/// Transport settings of a server being saved.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpTransportInput {
    /// A local child process speaking newline-delimited JSON-RPC.
    Stdio {
        /// Command: a bare name resolved on `PATH`, or an absolute path.
        command: String,
        /// Arguments.
        args: Vec<String>,
        /// Extra environment variables.
        env: Vec<KeyValueInput>,
    },
    /// Streamable HTTP.
    Http {
        /// `https://` URL, or `http://` for localhost, 127.0.0.1 or [::1].
        url: String,
        /// Extra request headers.
        headers: Vec<KeyValueInput>,
    },
}

/// Transport settings of a stored server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpTransportView {
    /// Local child process.
    Stdio {
        /// Command.
        command: String,
        /// Arguments.
        args: Vec<String>,
        /// Environment variables.
        env: Vec<KeyValueView>,
    },
    /// Streamable HTTP.
    Http {
        /// URL.
        url: String,
        /// Request headers.
        headers: Vec<KeyValueView>,
    },
}

/// An MCP server to create (no `id`) or update (with `id`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct McpServerInput {
    /// Existing server id when editing; omit to create.
    #[serde(default)]
    #[ts(optional)]
    pub id: Option<String>,
    /// Name, `^[a-zA-Z0-9_-]{1,64}$`, not starting with `-`, unique per profile.
    pub name: String,
    /// Transport settings.
    pub transport: McpTransportInput,
    /// Tool logins whose config variables the server's environment gets.
    pub tool_ids: Vec<String>,
    /// Whether the server is synced to Claude Code.
    pub enabled: bool,
}

/// Result of the last health check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum McpHealthStatus {
    /// Never tested.
    Untested,
    /// Initialised and listed tools.
    Ok,
    /// The server answered HTTP 401/403: use Authorize.
    NeedsAuth,
    /// Anything else went wrong.
    Error,
}

/// One tool offered by an MCP server. Text is untrusted: render as plain text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct McpToolInfo {
    /// Tool name.
    pub name: String,
    /// Tool description (truncated, control characters removed).
    pub description: Option<String>,
}

/// Health of an MCP server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct McpHealth {
    /// Outcome.
    pub status: McpHealthStatus,
    /// User-safe explanation for `needs_auth` and `error`.
    pub message: Option<String>,
    /// Tools listed by the server.
    pub tools: Vec<McpToolInfo>,
    /// `serverInfo.name` from `initialize`.
    pub server_name: Option<String>,
    /// `serverInfo.version` from `initialize`.
    pub server_version: Option<String>,
    /// Time of the check, RFC 3339 UTC.
    pub checked_at: Option<String>,
}

impl McpHealth {
    /// Health of a server that was never tested.
    #[must_use]
    pub fn untested() -> Self {
        Self {
            status: McpHealthStatus::Untested,
            message: None,
            tools: Vec::new(),
            server_name: None,
            server_version: None,
            checked_at: None,
        }
    }
}

/// A stored MCP server. Contains no secret values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct McpServerView {
    /// Server id (`m_` + 12 base32 characters).
    pub id: String,
    /// Name.
    pub name: String,
    /// Transport settings.
    pub transport: McpTransportView,
    /// Tool logins shared with the server.
    pub tool_ids: Vec<String>,
    /// Whether the server is synced to Claude Code.
    pub enabled: bool,
    /// Last health check.
    pub health: McpHealth,
}

/// Arguments of `mcp_save`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct McpSaveArgs {
    /// Profile id.
    pub profile_id: String,
    /// Server.
    pub server: McpServerInput,
}

/// Arguments of `mcp_delete`, `mcp_test`, `mcp_authorize`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS)]
pub struct McpServerArgs {
    /// Profile id.
    pub profile_id: String,
    /// Server id.
    pub server_id: String,
}

/// A server that could not be synced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct SyncFailure {
    /// Server name.
    pub name: String,
    /// User-safe reason.
    pub message: String,
}

/// Result of `mcp_sync_claude`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct SyncReport {
    /// Names added or updated in the profile's Claude Code user scope.
    pub synced: Vec<String>,
    /// Vision-managed names removed (deleted or disabled servers).
    pub removed: Vec<String>,
    /// Names that failed.
    pub failed: Vec<SyncFailure>,
}

// ---------------------------------------------------------------------------------------
// TypeScript generation
// ---------------------------------------------------------------------------------------

fn decl<T: TS>(out: &mut String, cfg: &ts_rs::Config) {
    if let Some(docs) = T::docs() {
        out.push_str(&docs);
    }
    out.push_str("export ");
    out.push_str(&T::decl(cfg));
    out.push_str("\n\n");
}

/// Returns the content of `src/ipc/bindings.ts`: one exported TypeScript declaration per
/// IPC type, in a stable order.
#[must_use]
pub fn typescript_bindings() -> String {
    let cfg = ts_rs::Config::new();
    let mut out = String::from(
        "// Generated by `make bindings` from crates/vision-core/src/ipc.rs. DO NOT EDIT.\n\
         // `make lint` fails when this file is stale.\n\n",
    );
    decl::<ErrorCode>(&mut out, &cfg);
    decl::<IpcError>(&mut out, &cfg);
    decl::<AppInfo>(&mut out, &cfg);
    decl::<Platform>(&mut out, &cfg);
    decl::<Bootstrap>(&mut out, &cfg);
    decl::<ProfileKind>(&mut out, &cfg);
    decl::<Accent>(&mut out, &cfg);
    decl::<Profile>(&mut out, &cfg);
    decl::<ProfileCreateArgs>(&mut out, &cfg);
    decl::<ProfileUpdateArgs>(&mut out, &cfg);
    decl::<ProfileDeleteArgs>(&mut out, &cfg);
    decl::<ProfileSetActiveArgs>(&mut out, &cfg);
    decl::<ProfileScopeArgs>(&mut out, &cfg);
    decl::<ConfigEnvKind>(&mut out, &cfg);
    decl::<StatusParser>(&mut out, &cfg);
    decl::<Isolation>(&mut out, &cfg);
    decl::<ConfigEnvView>(&mut out, &cfg);
    decl::<ToolSpecView>(&mut out, &cfg);
    decl::<ToolStatus>(&mut out, &cfg);
    decl::<ToolView>(&mut out, &cfg);
    decl::<ToolArgs>(&mut out, &cfg);
    decl::<ToolIdArgs>(&mut out, &cfg);
    decl::<CustomToolInput>(&mut out, &cfg);
    decl::<CustomToolSaveArgs>(&mut out, &cfg);
    decl::<ValueInput>(&mut out, &cfg);
    decl::<KeyValueInput>(&mut out, &cfg);
    decl::<ValueView>(&mut out, &cfg);
    decl::<KeyValueView>(&mut out, &cfg);
    decl::<McpTransportInput>(&mut out, &cfg);
    decl::<McpTransportView>(&mut out, &cfg);
    decl::<McpServerInput>(&mut out, &cfg);
    decl::<McpHealthStatus>(&mut out, &cfg);
    decl::<McpToolInfo>(&mut out, &cfg);
    decl::<McpHealth>(&mut out, &cfg);
    decl::<McpServerView>(&mut out, &cfg);
    decl::<McpSaveArgs>(&mut out, &cfg);
    decl::<McpServerArgs>(&mut out, &cfg);
    decl::<SyncFailure>(&mut out, &cfg);
    decl::<SyncReport>(&mut out, &cfg);
    let trimmed = out.trim_end().len();
    out.truncate(trimmed);
    out.push('\n');
    out
}
