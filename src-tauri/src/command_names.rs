// Shared by build.rs (via include!) and lib.rs: the IPC commands of
// docs/specs/real-app-foundation.md §2.6. The capability file must list exactly these.

/// Every IPC command the webview may call, in spec order.
pub const COMMANDS: &[&str] = &[
    "app_info",
    "bootstrap",
    "profile_create",
    "profile_update",
    "profile_delete",
    "profile_set_active",
    "profile_open_terminal",
    "tools_list",
    "tool_check",
    "tool_sign_in",
    "tool_sign_out",
    "tool_open_install_page",
    "custom_tool_save",
    "custom_tool_delete",
    "mcp_list",
    "mcp_save",
    "mcp_delete",
    "mcp_test",
    "mcp_sync_claude",
    "mcp_authorize",
];
