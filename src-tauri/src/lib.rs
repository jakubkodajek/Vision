//! Vision desktop shell: one thin Tauri command per IPC command of
//! `docs/specs/real-app-foundation.md` §2.6. Each command delegates to
//! [`vision_core::Core`] on Tauri's blocking thread pool; all logic lives in the core.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, State};
use vision_core::ipc::{
    Accent, AppInfo, Bootstrap, CustomToolInput, CustomToolSaveArgs, McpSaveArgs, McpServerArgs,
    McpServerInput, McpServerView, Profile, ProfileCreateArgs, ProfileDeleteArgs, ProfileKind,
    ProfileScopeArgs, ProfileSetActiveArgs, ProfileUpdateArgs, SyncReport, ToolArgs, ToolIdArgs,
    ToolSpecView, ToolView,
};
use vision_core::{Core, CoreDeps, IpcError};

mod command_names;

pub use command_names::COMMANDS;

/// Environment variable that overrides the data root (development and tests).
pub const DATA_DIR_ENV: &str = "VISION_DATA_DIR";

/// Managed state: the core, or the error that prevented it from starting. A startup
/// failure (for example `schema_too_new`) does not stop the window from opening; every
/// command then returns that error so the UI can show it.
pub struct AppState {
    core: Result<Arc<Core>, IpcError>,
}

type CmdResult<T> = Result<T, IpcError>;

/// Runs `f` against the core on the blocking thread pool.
async fn with_core<T, F>(state: State<'_, AppState>, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Core) -> CmdResult<T> + Send + 'static,
{
    run_with(&state, f).await
}

/// Like [`with_core`], on a plain state reference (testable without a Tauri app).
async fn run_with<T, F>(state: &AppState, f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Core) -> CmdResult<T> + Send + 'static,
{
    let core = state.core.clone()?;
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .map_err(|_| IpcError::internal("The operation was interrupted"))?
}

/// Returns the product name and core version (works even if the core failed to start).
#[tauri::command]
fn app_info() -> AppInfo {
    vision_core::app_info()
}

/// Profiles, active profile id and platform.
#[tauri::command(rename_all = "snake_case")]
async fn bootstrap(state: State<'_, AppState>) -> CmdResult<Bootstrap> {
    with_core(state, Core::bootstrap).await
}

/// Creates a profile.
#[tauri::command(rename_all = "snake_case")]
async fn profile_create(
    state: State<'_, AppState>,
    name: String,
    kind: ProfileKind,
    accent: Accent,
) -> CmdResult<Profile> {
    with_core(state, move |c| {
        c.profile_create(ProfileCreateArgs { name, kind, accent })
    })
    .await
}

/// Updates a profile's name, kind or accent.
#[tauri::command(rename_all = "snake_case")]
async fn profile_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    kind: Option<ProfileKind>,
    accent: Option<Accent>,
) -> CmdResult<Profile> {
    with_core(state, move |c| {
        c.profile_update(ProfileUpdateArgs {
            id,
            name,
            kind,
            accent,
        })
    })
    .await
}

/// Deletes a profile after typed confirmation.
#[tauri::command(rename_all = "snake_case")]
async fn profile_delete(
    state: State<'_, AppState>,
    id: String,
    confirm_name: String,
) -> CmdResult<()> {
    with_core(state, move |c| {
        c.profile_delete(ProfileDeleteArgs { id, confirm_name })
    })
    .await
}

/// Sets the active profile.
#[tauri::command(rename_all = "snake_case")]
async fn profile_set_active(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    with_core(state, move |c| {
        c.profile_set_active(ProfileSetActiveArgs { id })
    })
    .await
}

/// Opens a terminal with the profile's tool environment.
#[tauri::command(rename_all = "snake_case")]
async fn profile_open_terminal(state: State<'_, AppState>, profile_id: String) -> CmdResult<()> {
    with_core(state, move |c| {
        c.profile_open_terminal(ProfileScopeArgs { profile_id })
    })
    .await
}

/// Lists tools with cached status (no process spawn).
#[tauri::command(rename_all = "snake_case")]
async fn tools_list(state: State<'_, AppState>, profile_id: String) -> CmdResult<Vec<ToolView>> {
    with_core(state, move |c| {
        c.tools_list(ProfileScopeArgs { profile_id })
    })
    .await
}

/// Detects the binary and runs the status command.
#[tauri::command(rename_all = "snake_case")]
async fn tool_check(
    state: State<'_, AppState>,
    profile_id: String,
    tool_id: String,
) -> CmdResult<ToolView> {
    with_core(state, move |c| {
        c.tool_check(ToolArgs {
            profile_id,
            tool_id,
        })
    })
    .await
}

/// Opens the system terminal with the tool's sign-in command.
#[tauri::command(rename_all = "snake_case")]
async fn tool_sign_in(
    state: State<'_, AppState>,
    profile_id: String,
    tool_id: String,
) -> CmdResult<()> {
    with_core(state, move |c| {
        c.tool_sign_in(ToolArgs {
            profile_id,
            tool_id,
        })
    })
    .await
}

/// Opens the system terminal with the tool's sign-out command.
#[tauri::command(rename_all = "snake_case")]
async fn tool_sign_out(
    state: State<'_, AppState>,
    profile_id: String,
    tool_id: String,
) -> CmdResult<()> {
    with_core(state, move |c| {
        c.tool_sign_out(ToolArgs {
            profile_id,
            tool_id,
        })
    })
    .await
}

/// Opens the tool's official install page in the browser.
#[tauri::command(rename_all = "snake_case")]
async fn tool_open_install_page(state: State<'_, AppState>, tool_id: String) -> CmdResult<()> {
    with_core(state, move |c| {
        c.tool_open_install_page(ToolIdArgs { tool_id })
    })
    .await
}

/// Creates or replaces a custom tool.
#[tauri::command(rename_all = "snake_case")]
async fn custom_tool_save(
    state: State<'_, AppState>,
    tool: CustomToolInput,
) -> CmdResult<ToolSpecView> {
    with_core(state, move |c| {
        c.custom_tool_save(CustomToolSaveArgs { tool })
    })
    .await
}

/// Deletes a custom tool.
#[tauri::command(rename_all = "snake_case")]
async fn custom_tool_delete(state: State<'_, AppState>, tool_id: String) -> CmdResult<()> {
    with_core(state, move |c| c.custom_tool_delete(ToolIdArgs { tool_id })).await
}

/// Lists the profile's MCP servers.
#[tauri::command(rename_all = "snake_case")]
async fn mcp_list(state: State<'_, AppState>, profile_id: String) -> CmdResult<Vec<McpServerView>> {
    with_core(state, move |c| c.mcp_list(ProfileScopeArgs { profile_id })).await
}

/// Creates or updates an MCP server.
#[tauri::command(rename_all = "snake_case")]
async fn mcp_save(
    state: State<'_, AppState>,
    profile_id: String,
    server: McpServerInput,
) -> CmdResult<McpServerView> {
    with_core(state, move |c| {
        c.mcp_save(McpSaveArgs { profile_id, server })
    })
    .await
}

/// Deletes an MCP server and its secrets.
#[tauri::command(rename_all = "snake_case")]
async fn mcp_delete(
    state: State<'_, AppState>,
    profile_id: String,
    server_id: String,
) -> CmdResult<()> {
    with_core(state, move |c| {
        c.mcp_delete(McpServerArgs {
            profile_id,
            server_id,
        })
    })
    .await
}

/// Health-checks an MCP server.
#[tauri::command(rename_all = "snake_case")]
async fn mcp_test(
    state: State<'_, AppState>,
    profile_id: String,
    server_id: String,
) -> CmdResult<McpServerView> {
    with_core(state, move |c| {
        c.mcp_test(McpServerArgs {
            profile_id,
            server_id,
        })
    })
    .await
}

/// Pushes the profile's enabled servers into its Claude Code user scope.
#[tauri::command(rename_all = "snake_case")]
async fn mcp_sync_claude(state: State<'_, AppState>, profile_id: String) -> CmdResult<SyncReport> {
    with_core(state, move |c| {
        c.mcp_sync_claude(ProfileScopeArgs { profile_id })
    })
    .await
}

/// Opens the terminal with `claude mcp login <name>`.
#[tauri::command(rename_all = "snake_case")]
async fn mcp_authorize(
    state: State<'_, AppState>,
    profile_id: String,
    server_id: String,
) -> CmdResult<()> {
    with_core(state, move |c| {
        c.mcp_authorize(McpServerArgs {
            profile_id,
            server_id,
        })
    })
    .await
}

/// The data root: `VISION_DATA_DIR` if set (must be absolute), else `app_local_data_dir()`.
fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, IpcError> {
    match std::env::var_os(DATA_DIR_ENV).filter(|v| !v.is_empty()) {
        Some(v) => {
            let p = PathBuf::from(v);
            if p.is_absolute() {
                Ok(p)
            } else {
                Err(IpcError::invalid_input(format!(
                    "{DATA_DIR_ENV} must be an absolute path"
                )))
            }
        }
        None => app
            .path()
            .app_local_data_dir()
            .map_err(|_| IpcError::internal("The app data directory could not be determined")),
    }
}

fn start_core(app: &tauri::AppHandle) -> Result<Arc<Core>, IpcError> {
    let dir = data_dir(app)?;
    Core::open(dir, CoreDeps::system()).map(Arc::new)
}

/// Starts the desktop app.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let core = start_core(app.handle());
            match &core {
                Ok(c) => {
                    // Resolve PATH via the login shell off the UI thread.
                    let c = Arc::clone(c);
                    std::thread::spawn(move || c.warm_up());
                }
                Err(e) => eprintln!("Vision core failed to start ({:?}): {}", e.code, e.message),
            }
            app.manage(AppState { core });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            bootstrap,
            profile_create,
            profile_update,
            profile_delete,
            profile_set_active,
            profile_open_terminal,
            tools_list,
            tool_check,
            tool_sign_in,
            tool_sign_out,
            tool_open_install_page,
            custom_tool_save,
            custom_tool_delete,
            mcp_list,
            mcp_save,
            mcp_delete,
            mcp_test,
            mcp_sync_claude,
            mcp_authorize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vision");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability_permissions() -> Vec<String> {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities/main.json");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        v["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn capability_lists_exactly_the_spec_commands() {
        let expected: Vec<String> = COMMANDS
            .iter()
            .map(|c| format!("allow-{}", c.replace('_', "-")))
            .collect();
        assert_eq!(capability_permissions(), expected);
    }

    #[test]
    fn handler_registers_every_listed_command() {
        let src = include_str!("lib.rs");
        let start = src.find("generate_handler![").unwrap();
        let block = &src[start..start + src[start..].find(']').unwrap()];
        let missing: Vec<&&str> = COMMANDS
            .iter()
            .filter(|c| !block.contains(&format!("{c},")))
            .collect();
        assert!(missing.is_empty(), "{missing:?}");
    }

    #[test]
    fn startup_error_is_returned_by_commands() {
        let state = AppState {
            core: Err(IpcError::new(vision_core::ErrorCode::SchemaTooNew, "newer")),
        };
        let result = tauri::async_runtime::block_on(run_with(&state, Core::bootstrap));
        assert_eq!(
            result.unwrap_err().code,
            vision_core::ErrorCode::SchemaTooNew
        );
    }
}
