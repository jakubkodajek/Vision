//! Vision core: domain logic shared by the desktop shell. Has no Tauri dependency.
//!
//! Every side effect goes through a trait so tests never touch the real machine:
//! [`process::CommandRunner`], [`terminal::TerminalLauncher`], [`terminal::UrlOpener`],
//! [`secrets::SecretStore`] and [`mcp::McpProbe`]. [`Core`] is the facade the desktop shell
//! calls: one method per IPC command in `docs/specs/real-app-foundation.md` §2.6.

pub mod approvals;
pub mod core;
pub mod db;
pub mod env;
pub mod gate;
pub mod ids;
pub mod ipc;
pub mod mcp;
pub mod paths;
pub mod process;
pub mod profiles;
pub mod redact;
pub mod secrets;
pub mod terminal;
pub mod text;
pub mod time;
pub mod tools;

pub use crate::core::{Core, CoreDeps, PathSource, Timeouts};
pub use crate::ipc::{AppInfo, ErrorCode, IpcError};

/// Returns the product name and the core crate version.
#[must_use]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Vision",
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// The only page `app_open_releases_page` opens: Vision's GitHub Releases.
pub const RELEASES_URL: &str = "https://github.com/jakubkodajek/Vision/releases";

/// `app_open_releases_page`: opens [`RELEASES_URL`] (a fixed address, never one from the
/// UI). Works without a running [`Core`], so a `schema_too_new` start can point the user at
/// the latest version.
///
/// # Errors
/// What the opener returns.
pub fn open_releases_page(opener: &dyn terminal::UrlOpener) -> ipc::IpcResult<()> {
    opener.open(RELEASES_URL)
}
