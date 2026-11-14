//! [`Core`]: the facade the desktop shell calls. It owns the data root, the databases and
//! the side-effect trait objects, and exposes one method per IPC command (spec §2.6).
//!
//! All methods are blocking; the shell runs them on a blocking thread pool.
//!
//! Concurrency rules (BUG-1/2/10): every profile-scoped command enters that profile's gate
//! ([`crate::gate`]) for its whole duration, so `profile_delete` waits for it and nothing
//! recreates files of a deleted profile. Long operations (process runs, probes, dialogs)
//! never hold a database lock, and their results are written back with targeted updates
//! guarded by a revision check, never by writing back a whole row read before the operation.

use std::collections::{BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::approvals::{self, ApprovalKind, Confirmer};
use crate::db::{self, APP_MIGRATIONS, Db, PROFILE_MIGRATIONS};
use crate::env::{self, build_env, lookup, resolve_binary};
use crate::gate::{Entered, Gates};
use crate::ids;
use crate::ipc::{
    AppInfo, Bootstrap, CustomToolInput, CustomToolSaveArgs, ErrorCode, IpcError, IpcResult,
    KeyValueInput, McpHealth, McpSaveArgs, McpServerArgs, McpServerView, McpTransportInput,
    McpTransportView, Platform, Profile, ProfileCreateArgs, ProfileDeleteArgs, ProfileScopeArgs,
    ProfileSetActiveArgs, ProfileUpdateArgs, SyncFailure, SyncReport, SyncSkip, ToolArgs,
    ToolIdArgs, ToolSpecView, ToolStatus, ToolView, ValueInput,
};
use crate::mcp::{
    self, EntryKind, McpProbe, ProbeTarget, ResolvedServer, ResolvedTransport, SpecMcpProbe,
    StoredEntry,
};
use crate::paths::{DataRoot, create_private_dir, write_private_executable};
use crate::process::{CommandOutput, CommandRunner, CommandSpec, SystemCommandRunner};
use crate::profiles;
use crate::redact::redact;
use crate::secrets::{OsSecretStore, SecretScope, SecretStore, SecretString, secret_account};
use crate::terminal::{
    LaunchScript, ScriptFlavor, SystemTerminalLauncher, SystemUrlOpener, TerminalLauncher,
    UrlOpener, render,
};
use crate::time::now_rfc3339;
use crate::tools::{self, CODEX_CONFIG, ToolSpec};

/// Time limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    /// Status commands (spec: 20 s).
    pub status: Duration,
    /// `--version` commands.
    pub version: Duration,
    /// MCP health checks (spec: 20 s overall).
    pub mcp_probe: Duration,
    /// Each `claude mcp` command during sync.
    pub sync: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            status: Duration::from_secs(20),
            version: Duration::from_secs(10),
            mcp_probe: Duration::from_secs(20),
            sync: Duration::from_secs(30),
        }
    }
}

/// Where the child-process `PATH` comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathSource {
    /// Use exactly this value (tests).
    Fixed(OsString),
    /// Ask the user's login shell once, lazily (spec §2.4 PATH resolution).
    LoginShell,
}

/// The side effects the core uses.
#[derive(Clone)]
pub struct CoreDeps {
    /// Headless process runner.
    pub runner: Arc<dyn CommandRunner>,
    /// System terminal.
    pub terminal: Arc<dyn TerminalLauncher>,
    /// System browser.
    pub opener: Arc<dyn UrlOpener>,
    /// OS credential store.
    pub secrets: Arc<dyn SecretStore>,
    /// MCP health check client.
    pub probe: Arc<dyn McpProbe>,
    /// Native confirmation of user-defined commands before their first run.
    pub confirmer: Arc<dyn Confirmer>,
    /// Snapshot of the app's environment; only allowlisted variables reach children.
    pub parent_env: Vec<(OsString, OsString)>,
    /// `PATH` source.
    pub path: PathSource,
    /// Time limits.
    pub timeouts: Timeouts,
}

impl std::fmt::Debug for CoreDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print parent_env: it may hold secrets.
        f.debug_struct("CoreDeps")
            .field("path", &self.path)
            .field("timeouts", &self.timeouts)
            .finish_non_exhaustive()
    }
}

impl CoreDeps {
    /// Real implementations for the desktop app. `confirmer` is the native dialog the shell
    /// provides (the core has no UI dependency).
    #[must_use]
    pub fn system(confirmer: Arc<dyn Confirmer>) -> Self {
        let parent_env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        Self {
            runner: Arc::new(SystemCommandRunner),
            terminal: Arc::new(SystemTerminalLauncher {
                gui_env: parent_env.clone(),
            }),
            opener: Arc::new(SystemUrlOpener {
                gui_env: parent_env.clone(),
            }),
            secrets: Arc::new(OsSecretStore),
            probe: Arc::new(SpecMcpProbe),
            confirmer,
            parent_env,
            path: PathSource::LoginShell,
            timeouts: Timeouts::default(),
        }
    }
}

/// A stored MCP server (internal).
#[derive(Debug, Clone)]
struct StoredServer {
    id: String,
    name: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    entries: Vec<StoredEntry>,
    tool_ids: Vec<String>,
    enabled: bool,
    health: McpHealth,
    created_at: String,
    revision: i64,
}

impl StoredServer {
    fn scope(&self) -> SecretScope {
        if self.transport == "http" {
            SecretScope::Header
        } else {
            SecretScope::Env
        }
    }

    fn secret_accounts(&self, profile_id: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter(|e| e.secret)
            .map(|e| secret_account(profile_id, &self.id, self.scope(), &e.key))
            .collect()
    }

    fn has_secrets(&self) -> bool {
        self.entries.iter().any(|e| e.secret)
    }

    fn stdio_fingerprint(&self) -> String {
        let keys: Vec<String> = self.entries.iter().map(|e| e.key.clone()).collect();
        approvals::mcp_stdio_fingerprint(
            self.command.as_deref().unwrap_or(""),
            &self.args,
            &keys,
            &self.tool_ids,
        )
    }

    fn view(&self) -> McpServerView {
        let entries = self.entries.iter().map(StoredEntry::view).collect();
        McpServerView {
            id: self.id.clone(),
            name: self.name.clone(),
            transport: if self.transport == "http" {
                McpTransportView::Http {
                    url: self.url.clone().unwrap_or_default(),
                    headers: entries,
                }
            } else {
                McpTransportView::Stdio {
                    command: self.command.clone().unwrap_or_default(),
                    args: self.args.clone(),
                    env: entries,
                }
            },
            tool_ids: self.tool_ids.clone(),
            enabled: self.enabled,
            health: self.health.clone(),
        }
    }
}

fn json_col<T: serde::de::DeserializeOwned>(s: &str) -> rusqlite::Result<T> {
    serde_json::from_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn to_json<T: serde::Serialize>(v: &T) -> IpcResult<String> {
    serde_json::to_string(v).map_err(|_| IpcError::internal("Could not encode data"))
}

const SERVER_COLS: &str = "id, name, transport, command, args_json, url, entries_json, tool_ids_json, enabled, health_json, created_at, revision";

fn row_to_server(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredServer> {
    Ok(StoredServer {
        id: r.get(0)?,
        name: r.get(1)?,
        transport: r.get(2)?,
        command: r.get(3)?,
        args: json_col(&r.get::<_, String>(4)?)?,
        url: r.get(5)?,
        entries: json_col(&r.get::<_, String>(6)?)?,
        tool_ids: json_col(&r.get::<_, String>(7)?)?,
        enabled: r.get(8)?,
        health: json_col(&r.get::<_, String>(9)?)?,
        created_at: r.get(10)?,
        revision: r.get(11)?,
    })
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// `(scheme, host, port)` of an http(s) URL, for deciding whether a stored secret may follow
/// an edited URL.
fn origin(url: &str) -> Option<(String, String, u16)> {
    let uri: ureq::http::Uri = url.parse().ok()?;
    let scheme = uri.scheme_str()?.to_ascii_lowercase();
    let host = uri.host()?.to_ascii_lowercase();
    let port = uri
        .port_u16()
        .unwrap_or(if scheme == "https" { 443 } else { 80 });
    Some((scheme, host, port))
}

/// First non-empty output line of a `claude mcp` command, cleaned and redacted.
fn output_line(o: &CommandOutput) -> Option<String> {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&o.stderr),
        String::from_utf8_lossy(&o.stdout)
    );
    text.lines()
        .map(|l| tools::clean_text(&redact(l), 200))
        .find(|l| !l.is_empty())
}

fn output_contains(o: &CommandOutput, needles: &[&str]) -> bool {
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&o.stdout),
        String::from_utf8_lossy(&o.stderr)
    )
    .to_lowercase();
    needles.iter().any(|n| text.contains(n))
}

/// What `claude mcp remove` says for a name it does not know (verified with Claude Code
/// 2.1: `No MCP server named "x" in user scope`, exit 1).
const REMOVE_MISSING: &[&str] = &["no mcp server named", "no mcp server found"];
/// What `claude mcp add-json` says for a name that exists (`MCP server x already exists in
/// user config`, exit 1).
const ADD_EXISTS: &[&str] = &["already exists"];

/// Whether a `claude mcp remove` result means the name is gone: exit 0, or the CLI says it
/// does not know the name.
fn remove_done(out: &IpcResult<CommandOutput>) -> bool {
    match out {
        Ok(o) if o.timed_out => false,
        Ok(o) => o.exit_code == Some(0) || output_contains(o, REMOVE_MISSING),
        Err(_) => false,
    }
}

/// How long launch scripts are kept in `tmp/` (a terminal may still be reading one).
pub const LAUNCH_SCRIPT_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Removes launch scripts in `tmp` older than [`LAUNCH_SCRIPT_MAX_AGE`]. Only files named
/// `launch_*` are touched, so a second instance cannot delete a script another one just
/// wrote.
fn clean_tmp(tmp: &Path) {
    let Ok(entries) = std::fs::read_dir(tmp) else {
        return;
    };
    let now = SystemTime::now();
    for e in entries.flatten() {
        let is_script = e.file_name().to_string_lossy().starts_with("launch_");
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age > LAUNCH_SCRIPT_MAX_AGE);
        if is_script && old && e.file_type().is_ok_and(|t| t.is_file()) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// The core facade. Create one per data root with [`Core::open`].
pub struct Core {
    root: DataRoot,
    app_db: Db,
    profile_dbs: Mutex<HashMap<String, Arc<Db>>>,
    gates: Gates,
    /// Serialises MCP server writes (save, delete, health write-back, tool-id cleanup).
    mcp_write: Mutex<()>,
    /// Serialises `mcp_sync_claude` (it runs several `claude mcp` commands in sequence).
    sync: Mutex<()>,
    /// One confirmation dialog at a time.
    confirm: Mutex<()>,
    deps: CoreDeps,
    path: OnceLock<OsString>,
}

impl std::fmt::Debug for Core {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Core")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

fn lock<T>(m: &Mutex<T>) -> IpcResult<MutexGuard<'_, T>> {
    m.lock().map_err(|_| IpcError::internal("Lock poisoned"))
}

impl Core {
    /// Opens (creating if needed) the data root: removes stale launch scripts from `tmp/`,
    /// creates the private directories, opens and migrates `app.db`, and removes what a
    /// deleted profile left behind (directories without a row, and their secrets).
    ///
    /// # Errors
    /// `schema_too_new` if `app.db` comes from a newer build; `io`/`internal` otherwise.
    pub fn open(data_root: impl Into<PathBuf>, deps: CoreDeps) -> IpcResult<Self> {
        let root = DataRoot::new(data_root)?;
        create_private_dir(root.root())?;
        create_private_dir(&root.tmp())?;
        clean_tmp(&root.tmp());
        create_private_dir(&root.profiles())?;
        let app_db = db::open(&root.app_db(), APP_MIGRATIONS, &root.backups(), "app")?;
        let path = OnceLock::new();
        if let PathSource::Fixed(p) = &deps.path {
            let _ = path.set(p.clone());
        }
        let core = Self {
            root,
            app_db,
            profile_dbs: Mutex::new(HashMap::new()),
            gates: Gates::default(),
            mcp_write: Mutex::new(()),
            sync: Mutex::new(()),
            confirm: Mutex::new(()),
            deps,
            path,
        };
        core.remove_orphans()?;
        Ok(core)
    }

    /// The data root.
    #[must_use]
    pub fn data_root(&self) -> &DataRoot {
        &self.root
    }

    /// The `PATH` used for child processes (resolved once).
    pub fn resolved_path(&self) -> &OsStr {
        self.path
            .get_or_init(|| env::resolve_path(self.deps.runner.as_ref(), &self.deps.parent_env))
    }

    /// Resolves `PATH` ahead of the first command (call from a background thread).
    pub fn warm_up(&self) {
        let _ = self.resolved_path();
    }

    fn env_with(&self, extra: &[(OsString, OsString)]) -> IpcResult<Vec<(OsString, OsString)>> {
        build_env(&self.deps.parent_env, self.resolved_path(), extra)
    }

    // -----------------------------------------------------------------------------------
    // Internal lookups
    // -----------------------------------------------------------------------------------

    fn profile(&self, id: &str) -> IpcResult<Profile> {
        ids::validate_profile_id(id)?;
        profiles::get(&*self.app_db.lock()?, id)
    }

    /// Enters the profile's gate and returns the profile; the gate is left when the guard
    /// drops. Every profile-scoped command starts with this.
    fn scope(&self, id: &str) -> IpcResult<(Entered<'_>, Profile)> {
        ids::validate_profile_id(id)?;
        let entered = self.gates.enter(id)?;
        let p = profiles::get(&*self.app_db.lock()?, id)?;
        Ok((entered, p))
    }

    /// The profile's database. Call only inside the profile's gate (after [`Core::scope`]),
    /// which guarantees the row exists, so this never recreates a deleted profile's
    /// directory.
    fn profile_db(&self, id: &str) -> IpcResult<Arc<Db>> {
        let mut map = lock(&self.profile_dbs)?;
        if let Some(db) = map.get(id) {
            return Ok(Arc::clone(db));
        }
        let dir = self.root.profile_dir(id)?;
        create_private_dir(&dir)?;
        let db = Arc::new(db::open(
            &self.root.profile_db(id)?,
            PROFILE_MIGRATIONS,
            &self.root.backups(),
            &format!("profile-{id}"),
        )?);
        map.insert(id.to_owned(), Arc::clone(&db));
        Ok(db)
    }

    fn forget_profile_db(&self, id: &str) {
        if let Ok(mut map) = self.profile_dbs.lock() {
            map.remove(id);
        }
    }

    /// Stored custom tools. One that no longer validates (rules tightened after it was
    /// saved, or its variable collides with an earlier tool's) is returned with `invalid`
    /// set instead of failing the whole list.
    fn custom_tools_in(conn: &Connection) -> IpcResult<Vec<ToolSpec>> {
        let mut st =
            conn.prepare("SELECT spec_json FROM custom_tools ORDER BY created_at, rowid")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        let mut taken: Vec<String> = Vec::new();
        for json in rows {
            let input: CustomToolInput = serde_json::from_str(&json?)
                .map_err(|_| IpcError::internal("A stored custom tool could not be read"))?;
            match tools::custom_tool_spec(&input, &taken) {
                Ok(spec) => {
                    taken.push(input.config_var.clone());
                    out.push(spec);
                }
                Err(e) => out.push(tools::invalid_custom_tool_spec(&input, e.message)),
            }
        }
        Ok(out)
    }

    fn custom_tools(&self) -> IpcResult<Vec<ToolSpec>> {
        Self::custom_tools_in(&*self.app_db.lock()?)
    }

    fn all_tools(&self) -> IpcResult<Vec<ToolSpec>> {
        let mut v = tools::builtin_tools();
        v.extend(self.custom_tools()?);
        Ok(v)
    }

    fn tool(&self, id: &str) -> IpcResult<ToolSpec> {
        ids::validate_tool_id(id)?;
        self.all_tools()?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| IpcError::not_found("Tool not found"))
    }

    /// Creates `tools/<id>/` (0700) and, for Codex, its `config.toml` if absent.
    fn ensure_tool_home(&self, profile_id: &str, spec: &ToolSpec) -> IpcResult<PathBuf> {
        let dir = self.root.tool_dir(profile_id, &spec.id)?;
        create_private_dir(&dir)?;
        if spec.builtin && spec.id == "codex" {
            let cfg = dir.join("config.toml");
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&cfg)
            {
                Ok(mut f) => {
                    use std::io::Write;
                    f.write_all(CODEX_CONFIG.as_bytes())?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(dir)
    }

    /// Config and fixed variables of `specs` for a profile. Invalid custom tools are left
    /// out.
    fn tool_vars(
        &self,
        profile_id: &str,
        specs: &[&ToolSpec],
    ) -> IpcResult<Vec<(OsString, OsString)>> {
        let mut out = Vec::new();
        for spec in specs.iter().filter(|s| s.invalid.is_none()) {
            let dir = self.ensure_tool_home(profile_id, spec)?;
            for (var, path) in spec.env_for(&dir) {
                out.push((OsString::from(var), path.into_os_string()));
            }
            for (k, v) in &spec.extra_env {
                out.push((OsString::from(k), OsString::from(v)));
            }
        }
        Ok(out)
    }

    fn resolve_tool_binary(&self, spec: &ToolSpec) -> Option<PathBuf> {
        resolve_binary(&spec.binary, self.resolved_path())
    }

    fn launch(
        &self,
        title: String,
        env: Vec<(OsString, OsString)>,
        argv: Vec<String>,
        keep_open: bool,
    ) -> IpcResult<()> {
        let flavor = ScriptFlavor::current();
        let content = render(
            &LaunchScript {
                title,
                env: env.clone(),
                argv,
                keep_open,
            },
            flavor,
        )?;
        let tmp = self.root.tmp();
        create_private_dir(&tmp)?;
        let file = tmp.join(format!(
            "{}.{}",
            ids::generate("launch_")?,
            flavor.extension()
        ));
        write_private_executable(&file, content.as_bytes())?;
        self.deps.terminal.launch(&file, &env)
    }

    // -----------------------------------------------------------------------------------
    // Approvals (SEC-1)
    // -----------------------------------------------------------------------------------

    /// Ensures `hash` is the approved fingerprint of the subject, asking the confirmer
    /// (native dialog) if it is not. Nothing may run before this returns `Ok`.
    fn require_approval(
        &self,
        kind: ApprovalKind,
        subject: &str,
        profile_scope: &str,
        hash: &str,
        title: &str,
        message: impl FnOnce() -> String,
    ) -> IpcResult<()> {
        if approvals::is_approved(&*self.app_db.lock()?, kind, subject, profile_scope, hash)? {
            return Ok(());
        }
        let _one_dialog = lock(&self.confirm)?;
        // Approved while this call waited for another dialog.
        if approvals::is_approved(&*self.app_db.lock()?, kind, subject, profile_scope, hash)? {
            return Ok(());
        }
        if !self.deps.confirmer.confirm(title, &message()) {
            return Err(approvals::not_approved());
        }
        approvals::store(&*self.app_db.lock()?, kind, subject, profile_scope, hash)
    }

    /// Approval of a custom tool's whole definition before any of its commands runs.
    fn approve_custom_tool(&self, p: &Profile, spec: &ToolSpec, bin: &Path) -> IpcResult<()> {
        if spec.builtin {
            return Ok(());
        }
        let var = spec
            .config_env
            .first()
            .map(|c| c.var.clone())
            .unwrap_or_default();
        self.require_approval(
            ApprovalKind::CustomTool,
            &spec.id,
            "",
            &spec.fingerprint(),
            "Run this custom tool?",
            || {
                approvals::message(
                    &[
                        ("Profile", &p.name),
                        ("Custom tool", &format!("{} ({})", spec.name, spec.id)),
                        ("Program", &lossy(bin)),
                        ("Config variable", &var),
                    ],
                    &[
                        ("Version check arguments", spec.version.clone()),
                        ("Status arguments", spec.status.clone().unwrap_or_default()),
                        ("Sign-in arguments", spec.login.clone()),
                        (
                            "Sign-out arguments",
                            spec.logout.clone().unwrap_or_default(),
                        ),
                    ],
                    "Vision will run this program with these arguments when you check, sign in \
                     or sign out of this tool, in every profile. Choose Cancel unless you added \
                     this tool yourself. Any change to the tool asks again.",
                )
            },
        )
    }

    /// Approval of a stdio MCP server's definition before it is spawned.
    fn approve_stdio_server(&self, p: &Profile, s: &StoredServer, program: &Path) -> IpcResult<()> {
        self.require_approval(
            ApprovalKind::McpStdio,
            &s.id,
            &p.id,
            &s.stdio_fingerprint(),
            "Start this MCP server?",
            || {
                approvals::message(
                    &[
                        ("Profile", &p.name),
                        ("MCP server", &s.name),
                        ("Program", &lossy(program)),
                    ],
                    &[
                        ("Arguments", s.args.clone()),
                        (
                            "Environment variables (values not shown)",
                            s.entries.iter().map(|e| e.key.clone()).collect(),
                        ),
                        ("Shared tool logins", s.tool_ids.clone()),
                    ],
                    "Vision will start this program to test the server. Choose Cancel unless \
                     you added this server yourself. Any change to the command, arguments, \
                     variable names or shared logins asks again.",
                )
            },
        )
    }

    // -----------------------------------------------------------------------------------
    // Secrets bookkeeping (BUG-11)
    // -----------------------------------------------------------------------------------

    fn index_secret(&self, profile_id: &str, account: &str) -> IpcResult<()> {
        self.app_db.lock()?.execute(
            "INSERT OR IGNORE INTO secret_index (account, profile_id) VALUES (?1, ?2)",
            params![account, profile_id],
        )?;
        Ok(())
    }

    /// Deletes a secret from the store and, on success, from the index.
    fn delete_secret(&self, account: &str) -> IpcResult<()> {
        self.deps.secrets.delete(account)?;
        self.app_db
            .lock()?
            .execute("DELETE FROM secret_index WHERE account = ?1", [account])?;
        Ok(())
    }

    /// Best-effort deletion of every secret indexed for `profile_id` plus `extra`; entries
    /// that cannot be deleted (store unavailable) stay indexed and are retried on the next
    /// start.
    fn delete_profile_secrets(&self, profile_id: &str, extra: &[String]) {
        let indexed: Vec<String> = self
            .app_db
            .lock()
            .ok()
            .and_then(|conn| {
                let mut st = conn
                    .prepare("SELECT account FROM secret_index WHERE profile_id = ?1")
                    .ok()?;
                let rows = st.query_map([profile_id], |r| r.get::<_, String>(0)).ok()?;
                Some(rows.flatten().collect())
            })
            .unwrap_or_default();
        let all: BTreeSet<&String> = indexed.iter().chain(extra.iter()).collect();
        for account in all {
            let _ = self.delete_secret(account);
        }
    }

    /// Startup cleanup of what deleted profiles left behind: `profiles/<id>/` directories
    /// without a row (only names that are valid profile ids), and indexed secrets of
    /// profiles that no longer exist.
    fn remove_orphans(&self) -> IpcResult<()> {
        let known: BTreeSet<String> = profiles::list(&*self.app_db.lock()?)?
            .into_iter()
            .map(|p| p.id)
            .collect();
        if let Ok(entries) = std::fs::read_dir(self.root.profiles()) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if ids::validate_profile_id(&name).is_err() || known.contains(&name) {
                    continue;
                }
                // Secrets of a profile deleted before the index existed live only in its
                // profile.db.
                let legacy = Self::legacy_secret_accounts(&self.root, &name);
                self.delete_profile_secrets(&name, &legacy);
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
        let orphaned: Vec<String> = {
            let conn = self.app_db.lock()?;
            let mut st = conn.prepare("SELECT DISTINCT profile_id FROM secret_index")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.flatten().filter(|p| !known.contains(p)).collect()
        };
        for p in orphaned {
            self.delete_profile_secrets(&p, &[]);
        }
        Ok(())
    }

    /// Secret accounts referenced by a profile.db, if it can be opened (best effort).
    fn legacy_secret_accounts(root: &DataRoot, profile_id: &str) -> Vec<String> {
        let Ok(path) = root.profile_db(profile_id) else {
            return Vec::new();
        };
        if !path.is_file() {
            return Vec::new();
        }
        let Ok(db) = db::open(
            &path,
            PROFILE_MIGRATIONS,
            &root.backups(),
            &format!("profile-{profile_id}"),
        ) else {
            return Vec::new();
        };
        Self::load_servers(&db)
            .map(|servers| {
                servers
                    .iter()
                    .flat_map(|s| s.secret_accounts(profile_id))
                    .collect()
            })
            .unwrap_or_default()
    }

    // -----------------------------------------------------------------------------------
    // App
    // -----------------------------------------------------------------------------------

    /// `app_info`.
    #[must_use]
    pub fn app_info(&self) -> AppInfo {
        crate::app_info()
    }

    /// `bootstrap`: profiles, active profile id and platform.
    ///
    /// # Errors
    /// Database errors.
    pub fn bootstrap(&self) -> IpcResult<Bootstrap> {
        let conn = self.app_db.lock()?;
        let list = profiles::list(&conn)?;
        let active = profiles::get_setting(&conn, profiles::ACTIVE_PROFILE_KEY)?
            .filter(|id| list.iter().any(|p| &p.id == id));
        Ok(Bootstrap {
            profiles: list,
            active_profile_id: active,
            platform: Platform::current(),
        })
    }

    // -----------------------------------------------------------------------------------
    // Profiles
    // -----------------------------------------------------------------------------------

    /// `profile_create`: creates the directory tree (0700) and then the row; a failure
    /// rolls back both. The first profile becomes active.
    ///
    /// # Errors
    /// `invalid_input` for a bad name, `conflict` for a duplicate.
    pub fn profile_create(&self, args: ProfileCreateArgs) -> IpcResult<Profile> {
        let name = profiles::normalize_name(&args.name)?;
        {
            let conn = self.app_db.lock()?;
            if profiles::list(&conn)?
                .iter()
                .any(|p| profiles::name_key(&p.name) == profiles::name_key(&name))
            {
                return Err(IpcError::conflict(
                    "A profile with this name already exists",
                ));
            }
        }
        let profile = Profile {
            id: ids::generate("p_")?,
            name,
            kind: args.kind,
            accent: args.accent,
            created_at: now_rfc3339(),
        };
        let dir = self.root.profile_dir(&profile.id)?;
        let result = (|| -> IpcResult<()> {
            create_private_dir(&dir)?;
            create_private_dir(&dir.join("tools"))?;
            drop(db::open(
                &self.root.profile_db(&profile.id)?,
                PROFILE_MIGRATIONS,
                &self.root.backups(),
                &format!("profile-{}", profile.id),
            )?);
            let conn = self.app_db.lock()?;
            let tx = conn.unchecked_transaction()?;
            profiles::insert(&tx, &profile)?;
            if profiles::get_setting(&tx, profiles::ACTIVE_PROFILE_KEY)?.is_none() {
                profiles::set_setting(&tx, profiles::ACTIVE_PROFILE_KEY, Some(&profile.id))?;
            }
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
        Ok(profile)
    }

    /// `profile_update`: changes the given fields (read and write under one lock, so two
    /// concurrent updates of different fields both apply).
    ///
    /// # Errors
    /// `not_found`, `invalid_input`, `conflict`.
    pub fn profile_update(&self, args: ProfileUpdateArgs) -> IpcResult<Profile> {
        ids::validate_profile_id(&args.id)?;
        let name = args
            .name
            .as_deref()
            .map(profiles::normalize_name)
            .transpose()?;
        let conn = self.app_db.lock()?;
        let mut p = profiles::get(&conn, &args.id)?;
        if let Some(n) = name {
            p.name = n;
        }
        if let Some(k) = args.kind {
            p.kind = k;
        }
        if let Some(a) = args.accent {
            p.accent = a;
        }
        profiles::update(&conn, &p)?;
        Ok(p)
    }

    /// `profile_delete`: requires the profile's name (compared in NFC form). Waits for
    /// operations in flight on the profile, then deletes the row, the profile's approvals,
    /// its secrets (from the app-level index, so an unreadable `profile.db` does not orphan
    /// them; if the credential store is unavailable the delete still succeeds and the
    /// secrets are retried on the next start) and the whole profile directory.
    ///
    /// # Errors
    /// `invalid_input` when the confirmation does not match (nothing changes); `not_found`.
    pub fn profile_delete(&self, args: ProfileDeleteArgs) -> IpcResult<()> {
        let p = self.profile(&args.id)?;
        if crate::text::nfc(&args.confirm_name) != crate::text::nfc(&p.name) {
            return Err(IpcError::invalid_input(
                "The confirmation does not match the profile name",
            ));
        }
        if !self.gates.close(&p.id)? {
            return Err(IpcError::not_found("Profile not found"));
        }
        let (row_deleted, result) = self.delete_profile_closed(&p);
        self.gates.reopen(&p.id, row_deleted);
        result
    }

    /// The delete itself, with the profile's gate closed. Returns whether the row is gone.
    fn delete_profile_closed(&self, p: &Profile) -> (bool, IpcResult<()>) {
        let legacy = Self::legacy_secret_accounts_of_open(self, &p.id);
        self.forget_profile_db(&p.id);
        let tx_result = (|| -> IpcResult<()> {
            let conn = self.app_db.lock()?;
            let tx = conn.unchecked_transaction()?;
            profiles::delete(&tx, &p.id)?;
            approvals::forget_profile(&tx, &p.id)?;
            let active = profiles::get_setting(&tx, profiles::ACTIVE_PROFILE_KEY)?;
            if active.as_deref() == Some(p.id.as_str()) {
                let next = profiles::list(&tx)?.into_iter().next().map(|p| p.id);
                profiles::set_setting(&tx, profiles::ACTIVE_PROFILE_KEY, next.as_deref())?;
            }
            tx.commit()?;
            Ok(())
        })();
        if let Err(e) = tx_result {
            return (false, Err(e));
        }
        // Best effort: a missing credential store must not make a profile undeletable.
        self.delete_profile_secrets(&p.id, &legacy);
        let dir = match self.root.profile_dir(&p.id) {
            Ok(d) => d,
            Err(e) => return (true, Err(e)),
        };
        let removed = match std::fs::remove_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(IpcError::io(format!(
                "The profile was removed but some of its files could not be deleted: {e}"
            ))),
        };
        (true, removed)
    }

    /// Secret accounts listed in the profile's database (cached connection or a fresh one).
    fn legacy_secret_accounts_of_open(&self, profile_id: &str) -> Vec<String> {
        let cached = self
            .profile_dbs
            .lock()
            .ok()
            .and_then(|m| m.get(profile_id).cloned());
        match cached {
            Some(db) => Self::load_servers(&db)
                .map(|servers| {
                    servers
                        .iter()
                        .flat_map(|s| s.secret_accounts(profile_id))
                        .collect()
                })
                .unwrap_or_default(),
            None => Self::legacy_secret_accounts(&self.root, profile_id),
        }
    }

    /// `profile_set_active`.
    ///
    /// # Errors
    /// `not_found`.
    pub fn profile_set_active(&self, args: ProfileSetActiveArgs) -> IpcResult<()> {
        ids::validate_profile_id(&args.id)?;
        let conn = self.app_db.lock()?;
        profiles::get(&conn, &args.id)?;
        profiles::set_setting(&conn, profiles::ACTIVE_PROFILE_KEY, Some(&args.id))
    }

    /// `profile_open_terminal`: a shell with every tool's variables for the profile.
    ///
    /// # Errors
    /// `not_found`, `terminal_unavailable`.
    pub fn profile_open_terminal(&self, args: ProfileScopeArgs) -> IpcResult<()> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let all = self.all_tools()?;
        let refs: Vec<&ToolSpec> = all.iter().collect();
        let env = self.env_with(&self.tool_vars(&p.id, &refs)?)?;
        let argv = if cfg!(windows) {
            let comspec = lookup(&self.deps.parent_env, "ComSpec").map_or_else(
                || r"C:\Windows\System32\cmd.exe".to_owned(),
                |s| s.to_string_lossy().into_owned(),
            );
            vec![comspec, "/k".to_owned()]
        } else {
            let shell = lookup(&self.deps.parent_env, "SHELL")
                .map(PathBuf::from)
                .filter(|s| s.is_absolute() && s.is_file())
                .unwrap_or_else(|| PathBuf::from("/bin/sh"));
            vec![lossy(&shell), "-i".to_owned()]
        };
        self.launch(
            format!("Vision: profile {} terminal", p.name),
            env,
            argv,
            false,
        )
    }

    // -----------------------------------------------------------------------------------
    // Tools
    // -----------------------------------------------------------------------------------

    fn cached(&self, db: &Db, spec: &ToolSpec) -> IpcResult<ToolView> {
        let row: Option<(String, Option<String>, Option<String>, String)> = db
            .lock()?
            .query_row(
                "SELECT status_json, version, binary_path, checked_at FROM tool_status WHERE tool_id = ?1",
                [&spec.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        Ok(match row {
            Some((status, version, binary_path, checked_at)) => ToolView {
                spec: spec.view(),
                status: serde_json::from_str::<ToolStatus>(&status).ok(),
                version,
                binary_path,
                checked_at: Some(checked_at),
            },
            None => ToolView {
                spec: spec.view(),
                status: None,
                version: None,
                binary_path: None,
                checked_at: None,
            },
        })
    }

    /// `tools_list`: every tool with its cached status. Spawns no process and never asks
    /// for an approval.
    ///
    /// # Errors
    /// `not_found` for an unknown profile.
    pub fn tools_list(&self, args: ProfileScopeArgs) -> IpcResult<Vec<ToolView>> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let db = self.profile_db(&p.id)?;
        self.all_tools()?
            .iter()
            .map(|t| self.cached(&db, t))
            .collect()
    }

    fn run_tool(
        &self,
        bin: &Path,
        args: &[String],
        env: &[(OsString, OsString)],
        cwd: &Path,
        timeout: Duration,
    ) -> IpcResult<CommandOutput> {
        self.deps.runner.run(&CommandSpec {
            program: bin.to_path_buf(),
            args: args.iter().map(OsString::from).collect(),
            env: env.to_vec(),
            cwd: Some(cwd.to_path_buf()),
            timeout,
            max_output_bytes: 256 * 1024,
        })
    }

    /// `tool_check`: resolves the binary, runs `--version` and the status command with the
    /// profile environment, caches and returns the result. A custom tool runs only after its
    /// definition was approved in the native dialog.
    ///
    /// If the tool is deleted or edited while the check runs, the result is not cached:
    /// `not_found`, or the cached view of the new definition, is returned instead.
    ///
    /// # Errors
    /// `not_found` for an unknown profile or tool; `invalid_input` for a stored custom tool
    /// that no longer validates; `not_approved` when the user declines.
    pub fn tool_check(&self, args: ToolArgs) -> IpcResult<ToolView> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let db = self.profile_db(&p.id)?;
        let spec = self.tool(&args.tool_id)?;
        spec.ensure_runnable()?;
        let (status, version, bin) = match self.resolve_tool_binary(&spec) {
            None => (ToolStatus::NotInstalled, None, None),
            Some(bin) => {
                self.approve_custom_tool(&p, &spec, &bin)?;
                let dir = self.ensure_tool_home(&p.id, &spec)?;
                let env = self.env_with(&self.tool_vars(&p.id, &[&spec])?)?;
                let to = self.deps.timeouts;
                let version = self
                    .run_tool(&bin, &spec.version, &env, &dir, to.version)
                    .ok()
                    .and_then(|o| tools::parse_version(&o));
                let status = match &spec.status {
                    None => ToolStatus::Unknown {
                        message: "This tool has no status command".to_owned(),
                    },
                    Some(argv) => match self.run_tool(&bin, argv, &env, &dir, to.status) {
                        Ok(out) => {
                            let out = match &spec.status_fallback {
                                Some(fb) if tools::gh_needs_fallback(&out) => self
                                    .run_tool(&bin, fb, &env, &dir, to.status)
                                    .unwrap_or(out),
                                _ => out,
                            };
                            tools::parse_status(spec.status_parser, &out, &dir)
                        }
                        Err(e) if e.code == ErrorCode::NotInstalled => ToolStatus::NotInstalled,
                        Err(e) => ToolStatus::Unknown { message: e.message },
                    },
                };
                (status, version, Some(lossy(&bin)))
            }
        };
        // The check ran unlocked: cache it only if the tool is still the one that ran.
        let current = self.tool(&args.tool_id)?;
        if current != spec {
            return self.cached(&db, &current);
        }
        let checked_at = now_rfc3339();
        db.lock()?.execute(
            "INSERT OR REPLACE INTO tool_status (tool_id, status_json, version, binary_path, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![spec.id, to_json(&status)?, version, bin, checked_at],
        )?;
        Ok(ToolView {
            spec: spec.view(),
            status: Some(status),
            version,
            binary_path: bin,
            checked_at: Some(checked_at),
        })
    }

    fn tool_terminal(&self, args: &ToolArgs, sign_in: bool) -> IpcResult<()> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let spec = self.tool(&args.tool_id)?;
        spec.ensure_runnable()?;
        let tool_args = if sign_in {
            spec.login.clone()
        } else {
            spec.logout.clone().ok_or_else(|| {
                IpcError::invalid_input(format!("{} has no sign-out command", spec.name))
            })?
        };
        let bin = self.resolve_tool_binary(&spec).ok_or_else(|| {
            IpcError::new(
                ErrorCode::NotInstalled,
                format!("{} is not installed", spec.name),
            )
        })?;
        self.approve_custom_tool(&p, &spec, &bin)?;
        let env = self.env_with(&self.tool_vars(&p.id, &[&spec])?)?;
        let mut argv = vec![lossy(&bin)];
        argv.extend(tool_args);
        let what = if sign_in { "sign-in" } else { "sign-out" };
        self.launch(
            format!("Vision: profile {}, {} {what}", p.name, spec.name),
            env,
            argv,
            true,
        )
    }

    /// `tool_sign_in`: opens the system terminal running the tool's login command.
    ///
    /// # Errors
    /// `not_found`, `not_installed`, `terminal_unavailable`, `not_approved`.
    pub fn tool_sign_in(&self, args: ToolArgs) -> IpcResult<()> {
        self.tool_terminal(&args, true)
    }

    /// `tool_sign_out`: opens the system terminal running the tool's logout command.
    ///
    /// # Errors
    /// `invalid_input` when the tool has none; otherwise as [`Core::tool_sign_in`].
    pub fn tool_sign_out(&self, args: ToolArgs) -> IpcResult<()> {
        self.tool_terminal(&args, false)
    }

    /// `tool_open_install_page`: opens the registry's `install_url`.
    ///
    /// # Errors
    /// `not_found` when the tool or its page is unknown.
    pub fn tool_open_install_page(&self, args: ToolIdArgs) -> IpcResult<()> {
        let spec = self.tool(&args.tool_id)?;
        let url = spec
            .install_url
            .ok_or_else(|| IpcError::not_found("This tool has no install page"))?;
        tools::validate_https_url(&url)?;
        self.deps.opener.open(&url)
    }

    /// `custom_tool_save`: validates and stores (creates or replaces) a custom tool. Its
    /// config variable must not be used by another custom tool. Saving never runs anything;
    /// a changed definition needs a new approval before it runs.
    ///
    /// # Errors
    /// `invalid_input`, `conflict` (preset id).
    pub fn custom_tool_save(&self, args: CustomToolSaveArgs) -> IpcResult<ToolSpecView> {
        let conn = self.app_db.lock()?;
        let taken: Vec<String> = Self::custom_tools_in(&conn)?
            .iter()
            .filter(|t| t.id != args.tool.id && t.invalid.is_none())
            .flat_map(|t| t.config_env.iter().map(|c| c.var.clone()))
            .collect();
        let spec = tools::custom_tool_spec(&args.tool, &taken)?;
        let mut stored = args.tool.clone();
        stored.name = spec.name.clone();
        stored.description = Some(spec.description.clone()).filter(|d| !d.is_empty());
        conn.execute(
            "INSERT INTO custom_tools (id, spec_json, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET spec_json = excluded.spec_json",
            params![spec.id, to_json(&stored)?, now_rfc3339()],
        )?;
        Ok(spec.view())
    }

    /// `custom_tool_delete`: deletes the tool, its approval, and in every profile its
    /// `tools/<id>/` directory (its login files, so a later tool with the same id starts
    /// signed out), its cached status and its id in every MCP server's shared logins.
    ///
    /// # Errors
    /// `invalid_input` for presets, `not_found`.
    pub fn custom_tool_delete(&self, args: ToolIdArgs) -> IpcResult<()> {
        ids::validate_tool_id(&args.tool_id)?;
        if tools::builtin_tools().iter().any(|t| t.id == args.tool_id) {
            return Err(IpcError::invalid_input("Built-in tools cannot be deleted"));
        }
        let profile_ids: Vec<String> = {
            let conn = self.app_db.lock()?;
            let tx = conn.unchecked_transaction()?;
            let n = tx.execute("DELETE FROM custom_tools WHERE id = ?1", [&args.tool_id])?;
            if n == 0 {
                return Err(IpcError::not_found("Tool not found"));
            }
            approvals::forget(&tx, ApprovalKind::CustomTool, &args.tool_id)?;
            tx.commit()?;
            profiles::list(&conn)?.into_iter().map(|p| p.id).collect()
        };
        for pid in profile_ids {
            // A profile deleted meanwhile has nothing left to clean.
            let Ok((_in, _p)) = self.scope(&pid) else {
                continue;
            };
            self.forget_tool_in_profile(&pid, &args.tool_id)?;
        }
        Ok(())
    }

    fn forget_tool_in_profile(&self, profile_id: &str, tool_id: &str) -> IpcResult<()> {
        let db = self.profile_db(profile_id)?;
        db.lock()?
            .execute("DELETE FROM tool_status WHERE tool_id = ?1", [tool_id])?;
        {
            let _w = lock(&self.mcp_write)?;
            for mut s in Self::load_servers(&db)? {
                if s.tool_ids.iter().any(|t| t == tool_id) {
                    s.tool_ids.retain(|t| t != tool_id);
                    db.lock()?.execute(
                        "UPDATE mcp_servers SET tool_ids_json = ?1, revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                        params![to_json(&s.tool_ids)?, now_rfc3339(), s.id],
                    )?;
                }
            }
        }
        match std::fs::remove_dir_all(self.root.tool_dir(profile_id, tool_id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }

    // -----------------------------------------------------------------------------------
    // MCP
    // -----------------------------------------------------------------------------------

    fn load_servers(db: &Db) -> IpcResult<Vec<StoredServer>> {
        let conn = db.lock()?;
        let mut st = conn.prepare(&format!(
            "SELECT {SERVER_COLS} FROM mcp_servers ORDER BY created_at, rowid"
        ))?;
        let rows = st.query_map([], row_to_server)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    fn load_server(db: &Db, id: &str) -> IpcResult<StoredServer> {
        ids::validate_server_id(id)?;
        db.lock()?
            .query_row(
                &format!("SELECT {SERVER_COLS} FROM mcp_servers WHERE id = ?1"),
                [id],
                row_to_server,
            )
            .optional()?
            .ok_or_else(|| IpcError::not_found("MCP server not found"))
    }

    /// Creates or updates a server (every update bumps `revision`). Used by `mcp_save` only.
    fn write_server(db: &Db, s: &StoredServer) -> IpcResult<()> {
        db.lock()?.execute(
            "INSERT INTO mcp_servers (id, name, name_key, transport, command, args_json, url, entries_json, tool_ids_json, enabled, health_json, created_at, updated_at, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
               transport = excluded.transport, command = excluded.command, args_json = excluded.args_json,
               url = excluded.url, entries_json = excluded.entries_json, tool_ids_json = excluded.tool_ids_json,
               enabled = excluded.enabled, health_json = excluded.health_json, updated_at = excluded.updated_at,
               revision = mcp_servers.revision + 1",
            params![
                s.id,
                s.name,
                s.name.to_lowercase(),
                s.transport,
                s.command,
                to_json(&s.args)?,
                s.url,
                to_json(&s.entries)?,
                to_json(&s.tool_ids)?,
                s.enabled,
                to_json(&s.health)?,
                s.created_at,
                now_rfc3339(),
            ],
        )?;
        Ok(())
    }

    /// `mcp_list`.
    ///
    /// # Errors
    /// `not_found` for an unknown profile.
    pub fn mcp_list(&self, args: ProfileScopeArgs) -> IpcResult<Vec<McpServerView>> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let db = self.profile_db(&p.id)?;
        Ok(Self::load_servers(&db)?
            .iter()
            .map(StoredServer::view)
            .collect())
    }

    /// `mcp_save`: validates, stores secret values in the credential store (only a
    /// reference in `profile.db`), and creates or updates the server. Health resets to
    /// `untested`.
    ///
    /// A secret entry without a new value keeps its stored value, except when the
    /// destination changed (transport kind, HTTP origin, or stdio command or arguments):
    /// then every such secret must be entered again. Shared tool logins of the stored server
    /// that no longer exist (a deleted custom tool) are dropped; new unknown ids are
    /// rejected.
    ///
    /// # Errors
    /// `invalid_input`, `conflict` (duplicate name), `not_found`, `secret_store_unavailable`
    /// (nothing is written in that case).
    pub fn mcp_save(&self, args: McpSaveArgs) -> IpcResult<McpServerView> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let profile_id = p.id;
        let db = self.profile_db(&profile_id)?;
        let input = args.server;
        mcp::validate_name(&input.name)?;
        let (transport, command, cmd_args, url, entries, kind) = match &input.transport {
            McpTransportInput::Stdio { command, args, env } => {
                mcp::validate_command(command)?;
                mcp::validate_args(args)?;
                mcp::validate_entries(env, EntryKind::Env)?;
                (
                    "stdio",
                    Some(command.clone()),
                    args.clone(),
                    None,
                    env,
                    SecretScope::Env,
                )
            }
            McpTransportInput::Http { url, headers } => {
                mcp::validate_url(url)?;
                mcp::validate_entries(headers, EntryKind::Header)?;
                (
                    "http",
                    None,
                    Vec::new(),
                    Some(url.clone()),
                    headers,
                    SecretScope::Header,
                )
            }
        };
        let _w = lock(&self.mcp_write)?;
        let existing = match &input.id {
            Some(id) => Some(Self::load_server(&db, id)?),
            None => None,
        };
        let all = self.all_tools()?;
        let mut tool_ids = Vec::new();
        for t in &input.tool_ids {
            if !all.iter().any(|k| &k.id == t) {
                if existing.as_ref().is_some_and(|e| e.tool_ids.contains(t)) {
                    // The tool was deleted after the server was saved: drop it.
                    continue;
                }
                return Err(IpcError::invalid_input(format!(
                    "Unknown tool '{}'",
                    tools::clean_text(t, 40)
                )));
            }
            if !tool_ids.contains(t) {
                tool_ids.push(t.clone());
            }
        }
        if transport == "stdio" {
            // A server variable may not redirect a shared tool login (the environment
            // builder refuses duplicates).
            for e in entries {
                if let Some(t) = all.iter().filter(|t| tool_ids.contains(&t.id)).find(|t| {
                    t.config_env
                        .iter()
                        .any(|c| c.var.eq_ignore_ascii_case(&e.key))
                }) {
                    return Err(IpcError::invalid_input(format!(
                        "'{}' is set by the shared {} login; remove the variable or stop sharing that login",
                        e.key, t.name
                    )));
                }
            }
        }
        let id = match &existing {
            Some(s) => s.id.clone(),
            None => ids::generate("m_")?,
        };
        let taken: Option<String> = db
            .lock()?
            .query_row(
                "SELECT id FROM mcp_servers WHERE name_key = ?1",
                [input.name.to_lowercase()],
                |r| r.get(0),
            )
            .optional()?;
        if taken.is_some_and(|t| t != id) {
            return Err(IpcError::conflict(
                "An MCP server with this name already exists in this profile",
            ));
        }
        let destination_changed = existing.as_ref().is_some_and(|e| {
            e.transport != transport
                || (transport == "http"
                    && origin(e.url.as_deref().unwrap_or("")) != url.as_deref().and_then(origin))
                || (transport == "stdio" && (e.command != command || e.args != cmd_args))
        });
        let old_secret_accounts: BTreeSet<String> = existing
            .as_ref()
            .map(|s| s.secret_accounts(&profile_id).into_iter().collect())
            .unwrap_or_default();
        let mut stored_entries = Vec::new();
        let mut to_set: Vec<(String, &SecretString)> = Vec::new();
        let mut new_accounts = BTreeSet::new();
        for KeyValueInput { key, value } in entries {
            match value {
                ValueInput::Plain { value } => stored_entries.push(StoredEntry {
                    key: key.clone(),
                    secret: false,
                    value: Some(value.clone()),
                }),
                ValueInput::Secret { value } => {
                    let account = secret_account(&profile_id, &id, kind, key);
                    match value {
                        Some(v) => to_set.push((account.clone(), v)),
                        None if destination_changed => {
                            return Err(IpcError::invalid_input(format!(
                                "Enter the secret '{key}' again: the server's address or command changed, so the stored value is not sent to it"
                            )));
                        }
                        None if old_secret_accounts.contains(&account) => {}
                        None => {
                            return Err(IpcError::invalid_input(format!(
                                "Enter a value for the secret '{key}'"
                            )));
                        }
                    }
                    new_accounts.insert(account);
                    stored_entries.push(StoredEntry {
                        key: key.clone(),
                        secret: true,
                        value: None,
                    });
                }
            }
        }
        // Secrets first: if the store is unavailable nothing else is written. Each account
        // is indexed before it is written, so profile_delete can always find it.
        let mut written: Vec<String> = Vec::new();
        let rollback = |written: &[String]| {
            for a in written {
                if !old_secret_accounts.contains(a) {
                    let _ = self.delete_secret(a);
                }
            }
        };
        for (account, value) in &to_set {
            let r = self
                .index_secret(&profile_id, account)
                .and_then(|()| self.deps.secrets.set(account, value));
            if let Err(e) = r {
                rollback(&written);
                if !old_secret_accounts.contains(account) {
                    let _ = self.app_db.lock().map(|c| {
                        c.execute("DELETE FROM secret_index WHERE account = ?1", [account])
                    });
                }
                return Err(e);
            }
            written.push(account.clone());
        }
        let server = StoredServer {
            id: id.clone(),
            name: input.name.clone(),
            transport: transport.to_owned(),
            command,
            args: cmd_args,
            url,
            entries: stored_entries,
            tool_ids,
            enabled: input.enabled,
            health: McpHealth::untested(),
            created_at: existing
                .as_ref()
                .map_or_else(now_rfc3339, |s| s.created_at.clone()),
            revision: 0,
        };
        if let Err(e) = Self::write_server(&db, &server) {
            rollback(&written);
            return Err(e);
        }
        for stale in old_secret_accounts.difference(&new_accounts) {
            let _ = self.delete_secret(stale);
        }
        Ok(server.view())
    }

    /// `mcp_delete`: deletes the server's secrets, its approval and the server.
    ///
    /// # Errors
    /// `not_found`; `secret_store_unavailable` (the server is kept so it can be retried).
    pub fn mcp_delete(&self, args: McpServerArgs) -> IpcResult<()> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let db = self.profile_db(&p.id)?;
        let _w = lock(&self.mcp_write)?;
        let s = Self::load_server(&db, &args.server_id)?;
        for account in s.secret_accounts(&p.id) {
            self.delete_secret(&account)?;
        }
        db.lock()?
            .execute("DELETE FROM mcp_servers WHERE id = ?1", [&s.id])?;
        self.app_db.lock()?.execute(
            "DELETE FROM approvals WHERE kind = 'mcp_stdio' AND subject = ?1 AND profile_id = ?2",
            params![s.id, p.id],
        )?;
        Ok(())
    }

    fn resolve_entries(
        &self,
        profile_id: &str,
        s: &StoredServer,
    ) -> IpcResult<Result<Vec<(String, SecretString)>, String>> {
        let mut out = Vec::new();
        for e in &s.entries {
            if e.secret {
                let account = secret_account(profile_id, &s.id, s.scope(), &e.key);
                match self.deps.secrets.get(&account)? {
                    Some(v) => out.push((e.key.clone(), v)),
                    None => {
                        return Ok(Err(format!(
                            "The stored secret for '{}' is missing; edit the server and enter it again",
                            e.key
                        )));
                    }
                }
            } else {
                out.push((
                    e.key.clone(),
                    SecretString::new(e.value.clone().unwrap_or_default()),
                ));
            }
        }
        Ok(Ok(out))
    }

    fn server_tool_vars(
        &self,
        profile_id: &str,
        s: &StoredServer,
    ) -> IpcResult<Vec<(OsString, OsString)>> {
        let all = self.all_tools()?;
        let specs: Vec<&ToolSpec> = all.iter().filter(|t| s.tool_ids.contains(&t.id)).collect();
        self.tool_vars(profile_id, &specs)
    }

    /// `mcp_test`: health check through [`McpProbe`]; stores and returns the result. A
    /// stdio server is spawned only after its definition was approved in the native dialog.
    ///
    /// Only the health of the probed definition is written: if the server is deleted while
    /// the probe runs the result is discarded and `not_found` returned; if it is edited, the
    /// result is discarded and the current server (health `untested`) returned.
    ///
    /// # Errors
    /// `not_found`, `secret_store_unavailable`, `not_approved`.
    pub fn mcp_test(&self, args: McpServerArgs) -> IpcResult<McpServerView> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let db = self.profile_db(&p.id)?;
        let s = Self::load_server(&db, &args.server_id)?;
        let outcome = match self.resolve_entries(&p.id, &s)? {
            Err(msg) => mcp::ProbeOutcome::error(msg),
            Ok(values) => {
                let target = if s.transport == "http" {
                    Some(ProbeTarget::Http {
                        url: s.url.clone().unwrap_or_default(),
                        headers: values,
                    })
                } else {
                    let cmd = s.command.clone().unwrap_or_default();
                    let program = if Path::new(&cmd).is_absolute() {
                        Some(PathBuf::from(&cmd)).filter(|p| env::is_executable(p))
                    } else {
                        resolve_binary(&cmd, self.resolved_path())
                    };
                    match program {
                        None => None,
                        Some(program) => {
                            self.approve_stdio_server(&p, &s, &program)?;
                            let mut extra = self.server_tool_vars(&p.id, &s)?;
                            extra.extend(
                                values
                                    .iter()
                                    .map(|(k, v)| (OsString::from(k), OsString::from(v.expose()))),
                            );
                            Some(ProbeTarget::Stdio {
                                program,
                                args: s.args.clone(),
                                env: self.env_with(&extra)?,
                                cwd: Some(self.root.profile_dir(&p.id)?),
                            })
                        }
                    }
                };
                match target {
                    Some(t) => self.deps.probe.probe(&t, self.deps.timeouts.mcp_probe),
                    None => mcp::ProbeOutcome::error(format!(
                        "The command '{}' was not found",
                        tools::clean_text(s.command.as_deref().unwrap_or(""), 80)
                    )),
                }
            }
        };
        let health = McpHealth {
            status: outcome.status,
            message: outcome.message,
            tools: outcome.tools,
            server_name: outcome.server_name,
            server_version: outcome.server_version,
            checked_at: Some(now_rfc3339()),
        };
        let _w = lock(&self.mcp_write)?;
        db.lock()?.execute(
            "UPDATE mcp_servers SET health_json = ?1 WHERE id = ?2 AND revision = ?3",
            params![to_json(&health)?, s.id, s.revision],
        )?;
        // Deleted meanwhile: not_found. Edited meanwhile: the current row, untouched.
        Ok(Self::load_server(&db, &s.id)?.view())
    }

    fn resolve_server(
        &self,
        profile_id: &str,
        s: &StoredServer,
    ) -> IpcResult<Result<ResolvedServer, String>> {
        let values = match self.resolve_entries(profile_id, s)? {
            Ok(v) => v,
            Err(m) => return Ok(Err(m)),
        };
        let pairs: Vec<(String, String)> = values
            .iter()
            .map(|(k, v)| (k.clone(), v.expose().to_owned()))
            .collect();
        let transport = if s.transport == "http" {
            ResolvedTransport::Http {
                url: s.url.clone().unwrap_or_default(),
                headers: pairs,
            }
        } else {
            let mut env: Vec<(String, String)> = self
                .server_tool_vars(profile_id, s)?
                .into_iter()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
                .collect();
            for (k, v) in pairs {
                env.retain(|(ek, _)| ek != &k);
                env.push((k, v));
            }
            ResolvedTransport::Stdio {
                command: s.command.clone().unwrap_or_default(),
                args: s.args.clone(),
                env,
            }
        };
        Ok(Ok(ResolvedServer {
            name: s.name.clone(),
            transport,
        }))
    }

    /// `mcp_render_claude_config(profile)`: the `{"mcpServers": {...}}` document for the
    /// profile's enabled servers, with secret values resolved (for a per-run
    /// `--mcp-config` file; never sent over IPC). Servers whose secrets are missing are
    /// left out.
    ///
    /// # Errors
    /// `not_found`, `secret_store_unavailable`.
    pub fn mcp_render_claude_config(&self, profile_id: &str) -> IpcResult<Value> {
        let (_in, p) = self.scope(profile_id)?;
        let db = self.profile_db(&p.id)?;
        let mut resolved = Vec::new();
        for s in Self::load_servers(&db)?.iter().filter(|s| s.enabled) {
            if let Ok(r) = self.resolve_server(&p.id, s)? {
                resolved.push(r);
            }
        }
        Ok(mcp::render_claude_config(&resolved))
    }

    fn claude(&self, profile_id: &str) -> IpcResult<(PathBuf, Vec<(OsString, OsString)>)> {
        let spec = self.tool("claude")?;
        let bin = self.resolve_tool_binary(&spec).ok_or_else(|| {
            IpcError::new(ErrorCode::NotInstalled, "Claude Code is not installed")
        })?;
        let env = self.env_with(&self.tool_vars(profile_id, &[&spec])?)?;
        Ok((bin, env))
    }

    /// `mcp_sync_claude`: applies the enabled servers to the profile's Claude Code user
    /// scope and removes Vision-managed names that are no longer enabled.
    ///
    /// - Servers with any secret value are never synced (a secret would be visible in the
    ///   `claude mcp add-json` command line); they are listed in `skipped`, and removed from
    ///   Claude Code if Vision synced them before.
    /// - A name Vision manages is updated with `claude mcp remove` then `add-json`; a new
    ///   name is only added. If Claude Code already has a server of that name that Vision did
    ///   not create, it is reported in `failed` and left alone.
    /// - A remove counts as done only on exit 0 or when Claude Code says the name does not
    ///   exist; otherwise it is reported in `failed` and the name stays tracked for a retry.
    ///
    /// # Errors
    /// `not_found`, `not_installed` (Claude Code missing), `secret_store_unavailable`.
    pub fn mcp_sync_claude(&self, args: ProfileScopeArgs) -> IpcResult<SyncReport> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let _one_sync = lock(&self.sync)?;
        let db = self.profile_db(&p.id)?;
        let (bin, env) = self.claude(&p.id)?;
        let cwd = self.root.profile_dir(&p.id)?;
        let servers = Self::load_servers(&db)?;
        let managed: BTreeSet<String> = {
            let conn = db.lock()?;
            let mut st = conn.prepare("SELECT name FROM mcp_managed ORDER BY name")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let run = |a: &[&str]| {
            let a: Vec<String> = a.iter().map(|s| (*s).to_owned()).collect();
            self.run_tool(&bin, &a, &env, &cwd, self.deps.timeouts.sync)
        };
        let describe = |what: &str, out: &IpcResult<CommandOutput>| match out {
            Ok(o) if o.timed_out => format!("claude mcp {what} did not finish in time"),
            Ok(o) => {
                let code = o
                    .exit_code
                    .map_or_else(|| "none".to_owned(), |c| c.to_string());
                match output_line(o) {
                    Some(l) => format!("claude mcp {what} failed (exit code {code}): {l}"),
                    None => format!("claude mcp {what} failed (exit code {code})"),
                }
            }
            Err(e) => e.message.clone(),
        };
        let mut report = SyncReport {
            synced: Vec::new(),
            removed: Vec::new(),
            failed: Vec::new(),
            skipped: Vec::new(),
        };
        let mut keep: BTreeSet<&str> = BTreeSet::new();
        for s in servers.iter().filter(|s| s.enabled) {
            if s.has_secrets() {
                report.skipped.push(SyncSkip {
                    name: s.name.clone(),
                    reason: "Not synced because it has secret values: Vision never puts a secret \
                             on a command line, where other programs on this computer could read it"
                        .to_owned(),
                });
                continue;
            }
            keep.insert(s.name.as_str());
            let resolved = match self.resolve_server(&p.id, s)? {
                Ok(r) => r,
                Err(message) => {
                    report.failed.push(SyncFailure {
                        name: s.name.clone(),
                        message,
                    });
                    continue;
                }
            };
            let entry = mcp::render_claude_entry(&resolved).to_string();
            let is_managed = managed.contains(&s.name);
            if is_managed {
                let out = run(&["mcp", "remove", "--scope", "user", &s.name]);
                if !remove_done(&out) {
                    report.failed.push(SyncFailure {
                        name: s.name.clone(),
                        message: describe("remove", &out),
                    });
                    continue;
                }
            }
            let out = run(&["mcp", "add-json", "--scope", "user", &s.name, &entry]);
            match &out {
                Ok(o) if o.exit_code == Some(0) && !o.timed_out => {
                    db.lock()?.execute(
                        "INSERT OR IGNORE INTO mcp_managed (name) VALUES (?1)",
                        [&s.name],
                    )?;
                    report.synced.push(s.name.clone());
                }
                Ok(o) if !is_managed && !o.timed_out && output_contains(o, ADD_EXISTS) => {
                    report.failed.push(SyncFailure {
                        name: s.name.clone(),
                        message: format!(
                            "Claude Code already has a server named '{}' that Vision did not add; it was left unchanged. Rename one of them to sync this server",
                            s.name
                        ),
                    });
                }
                _ => report.failed.push(SyncFailure {
                    name: s.name.clone(),
                    message: describe("add-json", &out),
                }),
            }
        }
        for name in managed.iter().filter(|n| !keep.contains(n.as_str())) {
            let out = run(&["mcp", "remove", "--scope", "user", name]);
            if remove_done(&out) {
                db.lock()?
                    .execute("DELETE FROM mcp_managed WHERE name = ?1", [name])?;
                report.removed.push(name.clone());
            } else {
                report.failed.push(SyncFailure {
                    name: name.clone(),
                    message: describe("remove", &out),
                });
            }
        }
        Ok(report)
    }

    /// `mcp_authorize`: opens the system terminal with `claude mcp login <name>` under the
    /// profile environment (http servers; sync first so Claude Code knows the server).
    ///
    /// # Errors
    /// `invalid_input` for stdio servers, `not_installed`, `terminal_unavailable`.
    pub fn mcp_authorize(&self, args: McpServerArgs) -> IpcResult<()> {
        let (_in, p) = self.scope(&args.profile_id)?;
        let db = self.profile_db(&p.id)?;
        let s = Self::load_server(&db, &args.server_id)?;
        if s.transport != "http" {
            return Err(IpcError::invalid_input(
                "Only HTTP servers can be authorized",
            ));
        }
        let (bin, env) = self.claude(&p.id)?;
        let argv = vec![lossy(&bin), "mcp".into(), "login".into(), s.name.clone()];
        self.launch(
            format!(
                "Vision: profile {}, authorize MCP server {}",
                p.name, s.name
            ),
            env,
            argv,
            true,
        )
    }
}
