//! [`Core`]: the facade the desktop shell calls. It owns the data root, the databases and
//! the side-effect trait objects, and exposes one method per IPC command (spec §2.6).
//!
//! All methods are blocking; the shell runs them on a blocking thread pool.

use std::collections::{BTreeSet, HashMap};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use crate::db::{self, APP_MIGRATIONS, Db, PROFILE_MIGRATIONS};
use crate::env::{self, build_env, lookup, resolve_binary};
use crate::ids;
use crate::ipc::{
    AppInfo, Bootstrap, CustomToolInput, CustomToolSaveArgs, ErrorCode, IpcError, IpcResult,
    KeyValueInput, McpHealth, McpSaveArgs, McpServerArgs, McpServerView, McpTransportInput,
    McpTransportView, Platform, Profile, ProfileCreateArgs, ProfileDeleteArgs, ProfileScopeArgs,
    ProfileSetActiveArgs, ProfileUpdateArgs, SyncFailure, SyncReport, ToolArgs, ToolIdArgs,
    ToolSpecView, ToolStatus, ToolView, ValueInput,
};
use crate::mcp::{
    self, EntryKind, McpProbe, ProbeTarget, ResolvedServer, ResolvedTransport, SpecMcpProbe,
    StoredEntry,
};
use crate::paths::{DataRoot, create_private_dir, write_private_executable};
use crate::process::{CommandOutput, CommandRunner, CommandSpec, SystemCommandRunner};
use crate::profiles;
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
    /// Real implementations for the desktop app.
    #[must_use]
    pub fn system() -> Self {
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

const SERVER_COLS: &str = "id, name, transport, command, args_json, url, entries_json, tool_ids_json, enabled, health_json, created_at";

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
    })
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The core facade. Create one per data root with [`Core::open`].
pub struct Core {
    root: DataRoot,
    app_db: Db,
    profile_dbs: Mutex<HashMap<String, Arc<Db>>>,
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

impl Core {
    /// Opens (creating if needed) the data root: clears `tmp/`, creates the private
    /// directories and opens and migrates `app.db`.
    ///
    /// # Errors
    /// `schema_too_new` if `app.db` comes from a newer build; `io`/`internal` otherwise.
    pub fn open(data_root: impl Into<PathBuf>, deps: CoreDeps) -> IpcResult<Self> {
        let root = DataRoot::new(data_root)?;
        create_private_dir(root.root())?;
        match std::fs::remove_dir_all(root.tmp()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        create_private_dir(&root.tmp())?;
        create_private_dir(&root.profiles())?;
        let app_db = db::open(&root.app_db(), APP_MIGRATIONS, &root.backups(), "app")?;
        let path = OnceLock::new();
        if let PathSource::Fixed(p) = &deps.path {
            let _ = path.set(p.clone());
        }
        Ok(Self {
            root,
            app_db,
            profile_dbs: Mutex::new(HashMap::new()),
            deps,
            path,
        })
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

    fn env_with(&self, extra: &[(OsString, OsString)]) -> Vec<(OsString, OsString)> {
        build_env(&self.deps.parent_env, self.resolved_path(), extra)
    }

    // -----------------------------------------------------------------------------------
    // Internal lookups
    // -----------------------------------------------------------------------------------

    fn profile(&self, id: &str) -> IpcResult<Profile> {
        ids::validate_profile_id(id)?;
        profiles::get(&*self.app_db.lock()?, id)
    }

    fn profile_db(&self, id: &str) -> IpcResult<Arc<Db>> {
        self.profile(id)?;
        let mut map = self
            .profile_dbs
            .lock()
            .map_err(|_| IpcError::internal("Profile database lock poisoned"))?;
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

    fn custom_tools(&self) -> IpcResult<Vec<ToolSpec>> {
        let conn = self.app_db.lock()?;
        let mut st =
            conn.prepare("SELECT spec_json FROM custom_tools ORDER BY created_at, rowid")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for json in rows {
            let input: CustomToolInput = serde_json::from_str(&json?)
                .map_err(|_| IpcError::internal("A stored custom tool could not be read"))?;
            // Stored entries were validated on save; skip any that no longer validate.
            if let Ok(spec) = tools::custom_tool_spec(&input) {
                out.push(spec);
            }
        }
        Ok(out)
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

    /// Config and fixed variables of `specs` for a profile.
    fn tool_vars(
        &self,
        profile_id: &str,
        specs: &[&ToolSpec],
    ) -> IpcResult<Vec<(OsString, OsString)>> {
        let mut out = Vec::new();
        for spec in specs {
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

    /// `profile_update`: changes the given fields.
    ///
    /// # Errors
    /// `not_found`, `invalid_input`, `conflict`.
    pub fn profile_update(&self, args: ProfileUpdateArgs) -> IpcResult<Profile> {
        let mut p = self.profile(&args.id)?;
        if let Some(n) = &args.name {
            p.name = profiles::normalize_name(n)?;
        }
        if let Some(k) = args.kind {
            p.kind = k;
        }
        if let Some(a) = args.accent {
            p.accent = a;
        }
        profiles::update(&*self.app_db.lock()?, &p)?;
        Ok(p)
    }

    /// `profile_delete`: requires the exact name; deletes the profile's MCP secrets, the
    /// row and the whole profile directory.
    ///
    /// # Errors
    /// `invalid_input` when the confirmation does not match (nothing changes).
    pub fn profile_delete(&self, args: ProfileDeleteArgs) -> IpcResult<()> {
        let p = self.profile(&args.id)?;
        if args.confirm_name != p.name {
            return Err(IpcError::invalid_input(
                "The confirmation does not match the profile name",
            ));
        }
        // Secrets first (best effort: a missing credential store must not make a profile
        // undeletable; secrets can only exist if a store was available when saved).
        if let Ok(db) = self.profile_db(&p.id)
            && let Ok(servers) = Self::load_servers(&db)
        {
            for s in &servers {
                for account in s.secret_accounts(&p.id) {
                    let _ = self.deps.secrets.delete(&account);
                }
            }
        }
        self.forget_profile_db(&p.id);
        {
            let conn = self.app_db.lock()?;
            let tx = conn.unchecked_transaction()?;
            profiles::delete(&tx, &p.id)?;
            let active = profiles::get_setting(&tx, profiles::ACTIVE_PROFILE_KEY)?;
            if active.as_deref() == Some(p.id.as_str()) {
                let next = profiles::list(&tx)?.into_iter().next().map(|p| p.id);
                profiles::set_setting(&tx, profiles::ACTIVE_PROFILE_KEY, next.as_deref())?;
            }
            tx.commit()?;
        }
        match std::fs::remove_dir_all(self.root.profile_dir(&p.id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(IpcError::io(format!(
                "The profile was removed but some of its files could not be deleted: {e}"
            ))),
        }
    }

    /// `profile_set_active`.
    ///
    /// # Errors
    /// `not_found`.
    pub fn profile_set_active(&self, args: ProfileSetActiveArgs) -> IpcResult<()> {
        self.profile(&args.id)?;
        profiles::set_setting(
            &*self.app_db.lock()?,
            profiles::ACTIVE_PROFILE_KEY,
            Some(&args.id),
        )
    }

    /// `profile_open_terminal`: a shell with every tool's variables for the profile.
    ///
    /// # Errors
    /// `not_found`, `terminal_unavailable`.
    pub fn profile_open_terminal(&self, args: ProfileScopeArgs) -> IpcResult<()> {
        let p = self.profile(&args.profile_id)?;
        let all = self.all_tools()?;
        let refs: Vec<&ToolSpec> = all.iter().collect();
        let env = self.env_with(&self.tool_vars(&p.id, &refs)?);
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

    /// `tools_list`: every tool with its cached status. Spawns no process.
    ///
    /// # Errors
    /// `not_found` for an unknown profile.
    pub fn tools_list(&self, args: ProfileScopeArgs) -> IpcResult<Vec<ToolView>> {
        let db = self.profile_db(&args.profile_id)?;
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
    /// profile environment, caches and returns the result.
    ///
    /// # Errors
    /// `not_found` for an unknown profile or tool.
    pub fn tool_check(&self, args: ToolArgs) -> IpcResult<ToolView> {
        let db = self.profile_db(&args.profile_id)?;
        let spec = self.tool(&args.tool_id)?;
        let (status, version, bin) = match self.resolve_tool_binary(&spec) {
            None => (ToolStatus::NotInstalled, None, None),
            Some(bin) => {
                let dir = self.ensure_tool_home(&args.profile_id, &spec)?;
                let env = self.env_with(&self.tool_vars(&args.profile_id, &[&spec])?);
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
        let p = self.profile(&args.profile_id)?;
        let spec = self.tool(&args.tool_id)?;
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
        let env = self.env_with(&self.tool_vars(&p.id, &[&spec])?);
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
    /// `not_found`, `not_installed`, `terminal_unavailable`.
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

    /// `custom_tool_save`: validates and stores (creates or replaces) a custom tool.
    ///
    /// # Errors
    /// `invalid_input`, `conflict` (preset id).
    pub fn custom_tool_save(&self, args: CustomToolSaveArgs) -> IpcResult<ToolSpecView> {
        let spec = tools::custom_tool_spec(&args.tool)?;
        let mut stored = args.tool.clone();
        stored.name = spec.name.clone();
        self.app_db.lock()?.execute(
            "INSERT INTO custom_tools (id, spec_json, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET spec_json = excluded.spec_json",
            params![spec.id, to_json(&stored)?, now_rfc3339()],
        )?;
        Ok(spec.view())
    }

    /// `custom_tool_delete`.
    ///
    /// # Errors
    /// `invalid_input` for presets, `not_found`.
    pub fn custom_tool_delete(&self, args: ToolIdArgs) -> IpcResult<()> {
        ids::validate_tool_id(&args.tool_id)?;
        if tools::builtin_tools().iter().any(|t| t.id == args.tool_id) {
            return Err(IpcError::invalid_input("Built-in tools cannot be deleted"));
        }
        let n = self
            .app_db
            .lock()?
            .execute("DELETE FROM custom_tools WHERE id = ?1", [&args.tool_id])?;
        if n == 0 {
            return Err(IpcError::not_found("Tool not found"));
        }
        Ok(())
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

    fn write_server(db: &Db, s: &StoredServer) -> IpcResult<()> {
        db.lock()?.execute(
            "INSERT INTO mcp_servers (id, name, name_key, transport, command, args_json, url, entries_json, tool_ids_json, enabled, health_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key,
               transport = excluded.transport, command = excluded.command, args_json = excluded.args_json,
               url = excluded.url, entries_json = excluded.entries_json, tool_ids_json = excluded.tool_ids_json,
               enabled = excluded.enabled, health_json = excluded.health_json, updated_at = excluded.updated_at",
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
        let db = self.profile_db(&args.profile_id)?;
        Ok(Self::load_servers(&db)?
            .iter()
            .map(StoredServer::view)
            .collect())
    }

    /// `mcp_save`: validates, stores secret values in the credential store (only a
    /// reference in `profile.db`), and creates or updates the server. Health resets to
    /// `untested`.
    ///
    /// # Errors
    /// `invalid_input`, `conflict` (duplicate name), `not_found`, `secret_store_unavailable`
    /// (nothing is written in that case).
    pub fn mcp_save(&self, args: McpSaveArgs) -> IpcResult<McpServerView> {
        let profile_id = args.profile_id;
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
        let known: BTreeSet<String> = self.all_tools()?.into_iter().map(|t| t.id).collect();
        let mut tool_ids = Vec::new();
        for t in &input.tool_ids {
            if !known.contains(t) {
                return Err(IpcError::invalid_input(format!(
                    "Unknown tool '{}'",
                    tools::clean_text(t, 40)
                )));
            }
            if !tool_ids.contains(t) {
                tool_ids.push(t.clone());
            }
        }
        let existing = match &input.id {
            Some(id) => Some(Self::load_server(&db, id)?),
            None => None,
        };
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
        // Secrets first: if the store is unavailable nothing else is written.
        let mut written: Vec<String> = Vec::new();
        for (account, value) in &to_set {
            if let Err(e) = self.deps.secrets.set(account, value) {
                for a in &written {
                    if !old_secret_accounts.contains(a) {
                        let _ = self.deps.secrets.delete(a);
                    }
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
        };
        if let Err(e) = Self::write_server(&db, &server) {
            for a in &written {
                if !old_secret_accounts.contains(a) {
                    let _ = self.deps.secrets.delete(a);
                }
            }
            return Err(e);
        }
        for stale in old_secret_accounts.difference(&new_accounts) {
            let _ = self.deps.secrets.delete(stale);
        }
        Ok(server.view())
    }

    /// `mcp_delete`: deletes the server's secrets and the server.
    ///
    /// # Errors
    /// `not_found`; `secret_store_unavailable` (the server is kept so it can be retried).
    pub fn mcp_delete(&self, args: McpServerArgs) -> IpcResult<()> {
        let db = self.profile_db(&args.profile_id)?;
        let s = Self::load_server(&db, &args.server_id)?;
        for account in s.secret_accounts(&args.profile_id) {
            self.deps.secrets.delete(&account)?;
        }
        db.lock()?
            .execute("DELETE FROM mcp_servers WHERE id = ?1", [&s.id])?;
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

    /// `mcp_test`: health check through [`McpProbe`]; stores and returns the result.
    ///
    /// # Errors
    /// `not_found`, `secret_store_unavailable`.
    pub fn mcp_test(&self, args: McpServerArgs) -> IpcResult<McpServerView> {
        let db = self.profile_db(&args.profile_id)?;
        let mut s = Self::load_server(&db, &args.server_id)?;
        let outcome = match self.resolve_entries(&args.profile_id, &s)? {
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
                            let mut extra = self.server_tool_vars(&args.profile_id, &s)?;
                            extra.extend(
                                values
                                    .iter()
                                    .map(|(k, v)| (OsString::from(k), OsString::from(v.expose()))),
                            );
                            Some(ProbeTarget::Stdio {
                                program,
                                args: s.args.clone(),
                                env: self.env_with(&extra),
                                cwd: Some(self.root.profile_dir(&args.profile_id)?),
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
        s.health = McpHealth {
            status: outcome.status,
            message: outcome.message,
            tools: outcome.tools,
            server_name: outcome.server_name,
            server_version: outcome.server_version,
            checked_at: Some(now_rfc3339()),
        };
        Self::write_server(&db, &s)?;
        Ok(s.view())
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
        let db = self.profile_db(profile_id)?;
        let mut resolved = Vec::new();
        for s in Self::load_servers(&db)?.iter().filter(|s| s.enabled) {
            if let Ok(r) = self.resolve_server(profile_id, s)? {
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
        let env = self.env_with(&self.tool_vars(profile_id, &[&spec])?);
        Ok((bin, env))
    }

    /// `mcp_sync_claude`: applies the enabled servers to the profile's Claude Code user
    /// scope (`claude mcp remove` then `claude mcp add-json`) and removes Vision-managed
    /// names that are no longer enabled. Only names Vision manages are touched.
    ///
    /// # Errors
    /// `not_found`, `not_installed` (Claude Code missing), `secret_store_unavailable`.
    pub fn mcp_sync_claude(&self, args: ProfileScopeArgs) -> IpcResult<SyncReport> {
        let db = self.profile_db(&args.profile_id)?;
        let (bin, env) = self.claude(&args.profile_id)?;
        let cwd = self.root.profile_dir(&args.profile_id)?;
        let servers = Self::load_servers(&db)?;
        let managed: Vec<String> = {
            let conn = db.lock()?;
            let mut st = conn.prepare("SELECT name FROM mcp_managed ORDER BY name")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let run = |a: Vec<String>| self.run_tool(&bin, &a, &env, &cwd, self.deps.timeouts.sync);
        let describe = |what: &str, out: &IpcResult<CommandOutput>| match out {
            Ok(o) if o.timed_out => format!("claude mcp {what} did not finish in time"),
            Ok(o) => format!(
                "claude mcp {what} failed (exit code {})",
                o.exit_code
                    .map_or_else(|| "none".to_owned(), |c| c.to_string())
            ),
            Err(e) => e.message.clone(),
        };
        let mut report = SyncReport {
            synced: Vec::new(),
            removed: Vec::new(),
            failed: Vec::new(),
        };
        let enabled: Vec<&StoredServer> = servers.iter().filter(|s| s.enabled).collect();
        for s in &enabled {
            let resolved = match self.resolve_server(&args.profile_id, s)? {
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
            let _ = run(vec![
                "mcp".into(),
                "remove".into(),
                "--scope".into(),
                "user".into(),
                s.name.clone(),
            ]);
            let out = run(vec![
                "mcp".into(),
                "add-json".into(),
                "--scope".into(),
                "user".into(),
                s.name.clone(),
                entry,
            ]);
            if matches!(&out, Ok(o) if o.exit_code == Some(0)) {
                db.lock()?.execute(
                    "INSERT OR IGNORE INTO mcp_managed (name) VALUES (?1)",
                    [&s.name],
                )?;
                report.synced.push(s.name.clone());
            } else {
                report.failed.push(SyncFailure {
                    name: s.name.clone(),
                    message: describe("add-json", &out),
                });
            }
        }
        let keep: BTreeSet<&str> = enabled.iter().map(|s| s.name.as_str()).collect();
        for name in managed.iter().filter(|n| !keep.contains(n.as_str())) {
            let out = run(vec![
                "mcp".into(),
                "remove".into(),
                "--scope".into(),
                "user".into(),
                name.clone(),
            ]);
            // A completed remove (even "not found") means the name is gone.
            if matches!(&out, Ok(o) if !o.timed_out) {
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
        let p = self.profile(&args.profile_id)?;
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
