/**
 * Client-side checks that mirror the core's rules, so most mistakes are shown next to the
 * field before anything is sent. The core stays the authority: its `invalid_input` message
 * is mapped back to a field with {@link fieldForCoreMessage}.
 */

/** Profile name: 1 to 40 characters after trimming (crates/vision-core/src/profiles.rs). */
export function profileNameError(name: string): string | null {
  const length = Array.from(name.trim()).length;
  if (length === 0) return "Enter a name for the profile.";
  if (length > 40) return "Use at most 40 characters.";
  return null;
}

const TOOL_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const BINARY = /^[A-Za-z0-9_+][A-Za-z0-9._+-]{0,63}$/;
const CONFIG_VAR = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Fields of the custom tool form. */
export type CustomToolField =
  "name" | "id" | "description" | "binary" | "configVar" | "login" | "status" | "logout" | "installUrl";

/** Derives a tool id from a name: "My Tool 2" becomes "my-tool-2". */
export function toolIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");
  return slug.slice(0, 32).replace(/-+$/, "");
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
  if (d.login.length === 0) errors.login = "Enter at least one argument, for example login.";
  else if (d.login.length > 32) errors.login = "Use at most 32 arguments.";
  if (d.status.length > 32) errors.status = "Use at most 32 arguments.";
  if (d.logout.length > 32) errors.logout = "Use at most 32 arguments.";
  if (d.installUrl.length > 0 && !/^https:\/\/[^\s/@]+/.test(d.installUrl))
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

/** URL rule: https, or http only for localhost, 127.0.0.1 and [::1]. */
export function serverUrlError(url: string): string | null {
  if (url.length === 0) return "Enter the server URL.";
  if (/\s/.test(url)) return "The URL cannot contain spaces.";
  if (/^https:\/\/[^/?#]+/.test(url)) return null;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(url)) return null;
  if (url.startsWith("http://")) return "Plain http:// is only allowed for localhost; use https://.";
  return "The URL must start with https://.";
}

const CUSTOM_TOOL_PATTERNS: [RegExp, CustomToolField][] = [
  [/^Tool ids|built-in tool/i, "id"],
  [/^The name/i, "name"],
  [/^The description/i, "description"],
  [/^The binary/i, "binary"],
  [/install page/i, "installUrl"],
  [/config variable/i, "configVar"],
  [/^Sign-in command/i, "login"],
  [/^Status command/i, "status"],
  [/^Sign-out command/i, "logout"],
];

const MCP_PATTERNS: [RegExp, McpField][] = [
  [/^Server names|server with this name/i, "name"],
  [/^The command/i, "command"],
  [/arguments/i, "args"],
  [/URL|http:\/\/|credentials in a header/i, "url"],
  [/^Variable names|^Header names|listed twice|^The value of|secret '|at most 64 entries/i, "entries"],
  [/^Unknown tool/i, "tools"],
];

function match<F extends string>(patterns: readonly [RegExp, F][], message: string): F | null {
  for (const [pattern, field] of patterns) {
    if (pattern.test(message)) return field;
  }
  return null;
}

/**
 * Maps a core validation message about a custom tool to its form field, or `null` for a
 * form-level message. The core reports one message per error and no field name, so this
 * matches the wording in crates/vision-core/src/tools.rs and ids.rs.
 */
export function customToolFieldFor(message: string): CustomToolField | null {
  return match(CUSTOM_TOOL_PATTERNS, message);
}

/** Like {@link customToolFieldFor} for the MCP server form (crates/vision-core/src/mcp/mod.rs). */
export function mcpFieldFor(message: string): McpField | null {
  return match(MCP_PATTERNS, message);
}
