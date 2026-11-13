//! Vision desktop shell: exposes core functions to the webview as Tauri commands.

/// Returns the product name and core version.
#[tauri::command]
fn app_info() -> vision_core::AppInfo {
    vision_core::app_info()
}

/// Starts the desktop app.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("error while running Vision");
}
