//! Vision core: domain logic shared by the desktop shell. Has no Tauri dependency.

use serde::Serialize;

/// Static information about the running core, exposed to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    /// Product name.
    pub name: &'static str,
    /// Version of the core crate.
    pub version: &'static str,
}

/// Returns the product name and the core crate version.
#[must_use]
pub fn app_info() -> AppInfo {
    AppInfo {
        name: "Vision",
        version: env!("CARGO_PKG_VERSION"),
    }
}
