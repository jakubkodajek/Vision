/**
 * Client-side checks that mirror the core's rules, so most mistakes are shown next to the
 * field before anything is sent. The core stays the authority: its `invalid_input` and
 * `conflict` errors name the input in `field`, which {@link customToolField} and
 * {@link mcpField} map back to a form field.
 */

/**
 * Length limits of the core (crates/vision-core: profiles.rs, tools.rs, mcp/mod.rs), so a
 * field cannot take obviously too long text.
 */
export const LIMITS = {
  profileName: 40,
  toolName: 40,
  toolId: 32,
  toolDescription: 200,
  binary: 64,
  argument: 512,
  arguments: 32,
  configVar: 48,
  url: 2048,
  serverName: 64,
  command: 1024,
  serverArgument: 4096,
  serverArguments: 64,
  entries: 64,
  envKey: 128,
  headerKey: 64,
  value: 8192,
} as const;

/** Well-known config variables the core accepts without the _HOME/_DIR/_CONFIG suffix. */
export const WELL_KNOWN_CONFIG_VARS = ["KUBECONFIG", "DOCKER_CONFIG", "HELM_CONFIG_HOME"] as const;

/** Profile name: 1 to 40 characters after trimming (crates/vision-core/src/profiles.rs). */
export function profileNameError(name: string): string | null {
  const length = Array.from(name.trim()).length;
  if (length === 0) return "Enter a name for the profile.";
  if (length > 40) return "Use at most 40 characters.";
  return null;
}

const TOOL_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const BINARY = /^[A-Za-z0-9_+][A-Za-z0-9._+-]{0,63}$/;
const CONFIG_VAR = /^[A-Z][A-Z0-9_]{0,47}$/;

/** Fields of the custom tool form. */
export type CustomToolField =
  "name" | "id" | "description" | "binary" | "configVar" | "login" | "status" | "logout" | "installUrl";

/**
 * Derives a tool id from a name: "My Tool 2" becomes "my-tool-2". A slug longer than 32
 * characters is cut at the last hyphen before the limit, so no word is cut in half (a
 * single word longer than the limit is cut at 32).
 */
export function toolIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  if (slug.length <= LIMITS.toolId) return slug;
  const cut = slug.lastIndexOf("-", LIMITS.toolId);
  return (cut > 0 ? slug.slice(0, cut) : slug.slice(0, LIMITS.toolId)).replace(/-+$/, "");
}

/** Values of the custom tool form, as typed. */
export interface CustomToolDraft {
  name: string;
  id: string;
  description: string;
  binary: string;
  configVar: string;
  configKind: "dir" | "file";
  login: string[];
  status: string[];
  logout: string[];
  installUrl: string;
}

/** Field errors for a custom tool, empty when the form can be sent. */
export function customToolErrors(d: CustomToolDraft): Partial<Record<CustomToolField, string>> {
  const errors: Partial<Record<CustomToolField, string>> = {};
  const name = d.name.trim();
  if (name.length === 0) errors.name = "Enter a name.";
  else if (Array.from(name).length > 40) errors.name = "Use at most 40 characters.";
  if (!TOOL_ID.test(d.id))
    errors.id = "Use 1 to 32 lowercase letters, digits, '-' or '_', starting with a letter.";
  if (Array.from(d.description).length > 200) errors.description = "Use at most 200 characters.";
  if (d.binary.length === 0) errors.binary = "Enter the program name, for example mytool.";
  else if (!BINARY.test(d.binary))
    errors.binary = "Use a plain program name without a path, spaces or shell characters.";
  if (!CONFIG_VAR.test(d.configVar))
    errors.configVar = "Use an upper-case variable name like MYTOOL_CONFIG_DIR.";
  else if (
    !(WELL_KNOWN_CONFIG_VARS as readonly string[]).includes(d.configVar) &&
    !/.(_HOME|_DIR|_CONFIG|_CONFIG_FILE)$/.test(d.configVar)
  )
    errors.configVar =
      "End the name with _CONFIG_DIR, _CONFIG_HOME, _HOME, _CONFIG, _CONFIG_FILE or _DIR, like MYTOOL_CONFIG_DIR.";
  const argsError = (list: string[], required: boolean): string | undefined => {
    if (required && list.length === 0) return "Enter at least one argument, for example login.";
    if (list.length > LIMITS.arguments) return `Use at most ${String(LIMITS.arguments)} arguments.`;
    if (list.some((a) => Array.from(a).length > LIMITS.argument))
      return `Use at most ${String(LIMITS.argument)} characters per argument.`;
    return undefined;
  };
  const login = argsError(d.login, true);
  if (login) errors.login = login;
  const status = argsError(d.status, false);
  if (status) errors.status = status;
  const logout = argsError(d.logout, false);
  if (logout) errors.logout = logout;
  if (d.installUrl.length > LIMITS.url) errors.installUrl = `Use at most ${String(LIMITS.url)} characters.`;
  else if (d.installUrl.length > 0 && !/^https:\/\/[^\s/@]+/.test(d.installUrl))
    errors.installUrl = "Use an https:// address.";
  return errors;
}

/** Fields of the MCP server form. */
export type McpField = "name" | "command" | "args" | "url" | "entries" | "tools";

const SERVER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** Server name rule (crates/vision-core/src/mcp/mod.rs `validate_name`). */
export function serverNameError(name: string): string | null {
  if (name.length === 0) return "Enter a name.";
  if (!SERVER_NAME.test(name)) return "Use 1 to 64 letters, digits, '-' or '_', not starting with '-'.";
  return null;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "::1"];

/**
 * URL rule of the core (crates/vision-core/src/mcp/mod.rs `validate_url`): at most 2048
 * characters, no spaces or control characters, the exact lower-case scheme `https://` (or
 * `http://` only for localhost, 127.0.0.1 and [::1]), a host, and no credentials before an
 * `@`.
 */
export function serverUrlError(url: string): string | null {
  if (url.length === 0) return "Enter the server URL.";
  // eslint-disable-next-line no-control-regex
  if (url.length > LIMITS.url || /[\s\u0000-\u001f\u007f-\u009f]/.test(url))
    return "The URL is too long or contains spaces.";
  const split = url.indexOf("://");
  if (split < 0) return "The URL must start with https://.";
  const scheme = url.slice(0, split);
  const authority = url.slice(split + 3).split(/[/?#]/)[0] ?? "";
  if (authority.length === 0) return "The URL has no host.";
  if (authority.includes("@")) return "Put credentials in a header, not in the URL.";
  const host = (
    authority.startsWith("[")
      ? authority.slice(0, authority.indexOf("]") + 1)
      : (authority.split(":")[0] ?? "")
  ).toLowerCase();
  if (scheme === "https" && host.length > 0) return null;
  if (scheme === "http" && LOCAL_HOSTS.includes(host)) return null;
  if (scheme === "http")
    return "Plain http:// is only allowed for localhost, 127.0.0.1 and [::1]; use https://.";
  return "The URL must start with https://.";
}

/** Custom tool fields named by the core's `IpcError.field` (crates/vision-core/src/tools.rs). */
const CUSTOM_TOOL_CORE_FIELDS: Readonly<Record<string, CustomToolField>> = {
  id: "id",
  name: "name",
  description: "description",
  binary: "binary",
  install_url: "installUrl",
  config_var: "configVar",
  login: "login",
  status: "status",
  logout: "logout",
};

/** MCP fields named by the core's `IpcError.field` (crates/vision-core/src/mcp/mod.rs, core.rs). */
const MCP_CORE_FIELDS: Readonly<Record<string, McpField>> = {
  name: "name",
  command: "command",
  args: "args",
  url: "url",
  env: "entries",
  headers: "entries",
  tool_ids: "tools",
};

/** The custom tool form field a core error is about, or `null` for a form-level error. */
export function customToolField(error: { field: string | null } | null): CustomToolField | null {
  return error?.field ? (CUSTOM_TOOL_CORE_FIELDS[error.field] ?? null) : null;
}

/** The MCP server form field a core error is about, or `null` for a form-level error. */
export function mcpField(error: { field: string | null } | null): McpField | null {
  return error?.field ? (MCP_CORE_FIELDS[error.field] ?? null) : null;
}
