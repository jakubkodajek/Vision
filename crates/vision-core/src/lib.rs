//! Vision core: domain logic shared by the desktop shell. Has no Tauri dependency.
//!
//! Every side effect goes through a trait so tests never touch the real machine:
//! [`process::CommandRunner`], [`terminal::TerminalLauncher`], [`terminal::UrlOpener`],
//! [`secrets::SecretStore`] and [`mcp::McpProbe`]. [`Core`] is the facade the desktop shell
//! calls: one method per IPC command in `docs/specs/real-app-foundation.md` §2.6.

pub mod core;
pub mod db;
pub mod env;
pub mod ids;
pub mod ipc;
pub mod mcp;
pub mod paths;
pub mod process;
pub mod profiles;
pub mod secrets;
pub mod terminal;
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
