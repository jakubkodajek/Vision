/**
 * Typed client for Vision's IPC commands (docs/specs/real-app-foundation.md §2.6).
 *
 * One async function per Tauri command. Argument and result types come from
 * `./bindings` (generated from the Rust types, so nothing is validated twice). Every
 * function rejects with a {@link VisionIpcError}: errors from the core keep their
 * `code` and user-safe `message`; anything else (a missing command, a bridge failure)
 * becomes `code: "internal"`.
 *
 * Wire conventions: argument keys are snake_case exactly as in the bindings; optional
 * fields may be omitted; `null` results are returned as `null`.
 */
import { invoke } from "@tauri-apps/api/core";

import type {
  AppInfo,
  Bootstrap,
  CustomToolSaveArgs,
  ErrorCode,
  IpcError,
  McpSaveArgs,
  McpServerArgs,
  McpServerView,
  McpSetEnabledArgs,
  Profile,
  ProfileCreateArgs,
  ProfileDeleteArgs,
  ProfileScopeArgs,
  ProfileSetActiveArgs,
  ProfileUpdateArgs,
  SyncReport,
  ToolArgs,
  ToolIdArgs,
  ToolSpecView,
  ToolView,
} from "./bindings";

/** Every command name the capability file allows, in spec order. */
export const IPC_COMMANDS = [
  "app_info",
  "bootstrap",
  "app_open_releases_page",
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
  "mcp_set_enabled",
  "mcp_delete",
  "mcp_test",
  "mcp_sync_claude",
  "mcp_authorize",
] as const;

/** Name of an IPC command. */
export type IpcCommand = (typeof IPC_COMMANDS)[number];

const ERROR_CODES: readonly ErrorCode[] = [
  "invalid_input",
  "not_found",
  "conflict",
  "not_installed",
  "timeout",
  "io",
  "schema_too_new",
  "secret_store_unavailable",
  "terminal_unavailable",
  "not_approved",
  "internal",
];

/** The error every client function rejects with. `message` is safe to show to the user. */
export class VisionIpcError extends Error implements IpcError {
  /** Machine-readable error category. */
  readonly code: ErrorCode;
  /** The input the error belongs to (see `IpcError.field`), or `null` for the whole form. */
  readonly field: string | null;
  /** The env or header key an entry error belongs to, or `null`. */
  readonly entry_key: string | null;

  /**
   * @param code - Error category.
   * @param message - User-safe description.
   * @param field - Input the error belongs to.
   * @param entryKey - Env or header key the error belongs to.
   */
  constructor(code: ErrorCode, message: string, field: string | null = null, entryKey: string | null = null) {
    super(message);
    this.name = "VisionIpcError";
    this.code = code;
    this.field = field;
    this.entry_key = entryKey;
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : null;
}

/**
 * Returns whether `value` has the shape of an {@link IpcError} sent by the core.
 * @param value - Any thrown or rejected value.
 */
export function isIpcError(value: unknown): value is IpcError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.message === "string" &&
    typeof v.code === "string" &&
    (ERROR_CODES as readonly string[]).includes(v.code)
  );
}

/**
 * Normalises any thrown value into a {@link VisionIpcError}.
 * @param value - What `invoke` rejected with.
 */
export function toIpcError(value: unknown): VisionIpcError {
  if (value instanceof VisionIpcError) return value;
  if (isIpcError(value)) {
    const v = value as unknown as Record<string, unknown>;
    return new VisionIpcError(value.code, value.message, optionalText(v.field), optionalText(v.entry_key));
  }
  if (typeof value === "string" && value.length > 0) return new VisionIpcError("internal", value);
  if (value instanceof Error && value.message.length > 0) {
    return new VisionIpcError("internal", value.message);
  }
  return new VisionIpcError("internal", "Unexpected error while talking to the Vision core");
}

async function call<T>(command: IpcCommand, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e: unknown) {
    throw toIpcError(e);
  }
}

// ---- App -------------------------------------------------------------------------------

/** The longest version label the UI accepts from the core. */
export const MAX_VERSION_LENGTH = 64;

/** Whether `value` is an {@link AppInfo} with a non-empty version of at most 64 characters. */
export function isAppInfo(value: unknown): value is AppInfo {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.name === "string" &&
    typeof v.version === "string" &&
    v.version.length > 0 &&
    v.version.length <= MAX_VERSION_LENGTH
  );
}

/**
 * Product name and core version. Works even when the core failed to start. Rejects with
 * `internal` when the answer does not have the expected shape.
 */
export async function appInfo(): Promise<AppInfo> {
  const info = await call<unknown>("app_info");
  if (!isAppInfo(info)) throw new VisionIpcError("internal", "The Vision core sent an unexpected answer");
  return info;
}

/** Opens Vision's GitHub Releases page (a fixed address) in the browser. Works without a core. */
export function appOpenReleasesPage(): Promise<null> {
  return call<null>("app_open_releases_page");
}

/**
 * Profiles (oldest first), the active profile id and the platform. Call first: if the core
 * failed to start (e.g. `schema_too_new`) this rejects with that error.
 */
export function bootstrap(): Promise<Bootstrap> {
  return call<Bootstrap>("bootstrap");
}

// ---- Profiles --------------------------------------------------------------------------

/**
 * Creates a profile; the first profile becomes active.
 * Rejects with `invalid_input` (name) or `conflict` (duplicate name, case-insensitive).
 */
export function profileCreate(args: ProfileCreateArgs): Promise<Profile> {
  return call<Profile>("profile_create", args);
}

/** Updates the given fields of a profile. Rejects with `not_found`, `invalid_input`, `conflict`. */
export function profileUpdate(args: ProfileUpdateArgs): Promise<Profile> {
  return call<Profile>("profile_update", args);
}

/**
 * Deletes a profile, its directory (file-based tool logins) and its MCP secrets.
 * `confirm_name` must equal the profile name exactly, otherwise `invalid_input` and nothing
 * changes. On macOS, tell the user to sign out of Claude Code first (Keychain login).
 */
export function profileDelete(args: ProfileDeleteArgs): Promise<null> {
  return call<null>("profile_delete", args);
}

/** Persists the active profile. */
export function profileSetActive(args: ProfileSetActiveArgs): Promise<null> {
  return call<null>("profile_set_active", args);
}

/** Opens the system terminal with every tool's config variables for the profile. */
export function profileOpenTerminal(args: ProfileScopeArgs): Promise<null> {
  return call<null>("profile_open_terminal", args);
}

// ---- Tools -----------------------------------------------------------------------------

/**
 * Every tool (presets, then custom) with its cached status in the profile. Spawns no
 * process; `status` is `null` for tools never checked in this profile.
 */
export function toolsList(args: ProfileScopeArgs): Promise<ToolView[]> {
  return call<ToolView[]>("tools_list", args);
}

/**
 * Detects the binary and runs the tool's status command (up to 20 s). Poll this after
 * {@link toolSignIn} to detect when the sign-in completes. A custom tool first asks for
 * confirmation in a native dialog (once per definition); rejects with `not_approved` when
 * the user cancels, and `invalid_input` for a stored tool marked `invalid`.
 */
export function toolCheck(args: ToolArgs): Promise<ToolView> {
  return call<ToolView>("tool_check", args);
}

/**
 * Opens the system terminal running the tool's sign-in command with the profile
 * environment. Resolves once the terminal is opened, not when sign-in finishes.
 * Rejects with `not_installed`, `terminal_unavailable` or (custom tools) `not_approved`.
 */
export function toolSignIn(args: ToolArgs): Promise<null> {
  return call<null>("tool_sign_in", args);
}

/** Opens the system terminal running the tool's sign-out command (`invalid_input` if it has none). */
export function toolSignOut(args: ToolArgs): Promise<null> {
  return call<null>("tool_sign_out", args);
}

/** Opens the tool's official install page in the system browser. */
export function toolOpenInstallPage(args: ToolIdArgs): Promise<null> {
  return call<null>("tool_open_install_page", args);
}

/**
 * Adds (`replace: false`; an existing id is a `conflict` on field `id`) or replaces
 * (`replace: true`; `not_found` when it is gone) a custom tool (app scope). Rejects with
 * `invalid_input` or `conflict`, with `field` naming the input.
 */
export function customToolSave(args: CustomToolSaveArgs): Promise<ToolSpecView> {
  return call<ToolSpecView>("custom_tool_save", args);
}

/** Deletes a custom tool (`invalid_input` for presets). */
export function customToolDelete(args: ToolIdArgs): Promise<null> {
  return call<null>("custom_tool_delete", args);
}

// ---- MCP servers -----------------------------------------------------------------------

/** The profile's MCP servers. Secret values are never returned, only `has_value: true`. */
export function mcpList(args: ProfileScopeArgs): Promise<McpServerView[]> {
  return call<McpServerView[]>("mcp_list", args);
}

/**
 * Creates (no `server.id`) or updates an MCP server. A secret entry without `value` keeps
 * the stored value, unless the destination changed (transport, HTTP origin, stdio command
 * or arguments): then every secret must be entered again (`invalid_input`). Health resets
 * to `untested` unless what runs is unchanged (for example only the name changed). Rejects with `invalid_input`, `conflict`, `not_found` or
 * `secret_store_unavailable` (then nothing was saved).
 */
export function mcpSave(args: McpSaveArgs): Promise<McpServerView> {
  return call<McpServerView>("mcp_save", args);
}

/** Changes only `enabled` of a server; health and every other field are kept. */
export function mcpSetEnabled(args: McpSetEnabledArgs): Promise<McpServerView> {
  return call<McpServerView>("mcp_set_enabled", args);
}

/** Deletes an MCP server and its stored secrets. */
export function mcpDelete(args: McpServerArgs): Promise<null> {
  return call<null>("mcp_delete", args);
}

/**
 * Health-checks a server (initialize + tools/list, up to 20 s). Problems with the server
 * itself are reported in `health` (`error`, `needs_auth`), not as a rejection. A stdio
 * server is started only after a native confirmation (once per definition); rejects with
 * `not_approved` when the user cancels. If the server was edited during the check, the
 * current server is returned with `untested` health.
 */
export function mcpTest(args: McpServerArgs): Promise<McpServerView> {
  return call<McpServerView>("mcp_test", args);
}

/**
 * Writes the profile's enabled servers into its Claude Code user scope and removes servers
 * Vision synced earlier that are now disabled or deleted. Servers with secret values are
 * never synced and are listed in `skipped`. Rejects with `not_installed` without Claude Code.
 */
export function mcpSyncClaude(args: ProfileScopeArgs): Promise<SyncReport> {
  return call<SyncReport>("mcp_sync_claude", args);
}

/**
 * Opens the system terminal with `claude mcp login <name>` for an HTTP server that needs
 * OAuth (sync first so Claude Code knows the server). `invalid_input` for stdio servers.
 */
export function mcpAuthorize(args: McpServerArgs): Promise<null> {
  return call<null>("mcp_authorize", args);
}
