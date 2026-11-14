/** Display labels for core data (profiles, tools, MCP servers). */
import type {
  Accent,
  Isolation,
  McpHealthStatus,
  McpServerView,
  ProfileKind,
  ToolStatus,
} from "../ipc/bindings";

export const PROFILE_KINDS: readonly { id: ProfileKind; label: string }[] = [
  { id: "work", label: "Work" },
  { id: "personal", label: "Personal" },
  { id: "other", label: "Other" },
];

export const ACCENTS: readonly { id: Accent; label: string }[] = [
  { id: "iris", label: "Iris" },
  { id: "teal", label: "Teal" },
  { id: "amber", label: "Amber" },
  { id: "rose", label: "Rose" },
  { id: "green", label: "Green" },
];

/** "Work profile", "Personal profile", "Profile". */
export function profileKindLabel(kind: ProfileKind): string {
  if (kind === "work") return "Work profile";
  if (kind === "personal") return "Personal profile";
  return "Profile";
}

/** Short text of a tool status; `null` means never checked in this profile. */
export function toolStatusLabel(status: ToolStatus | null): string {
  if (!status) return "Not checked";
  switch (status.status) {
    case "not_installed":
      return "Not installed";
    case "signed_out":
      return "Signed out";
    case "signed_in":
      return "Signed in";
    case "unknown":
      return "Status unknown";
  }
}

/** Isolation note shown on each tool card. */
export function isolationLabel(isolation: Isolation): string {
  switch (isolation) {
    case "verified":
      return "Sign-in isolated per profile (verified)";
    case "unverified":
      return "Sign-in isolation per profile not yet verified";
    case "none":
      return "Not isolated: this tool shares one sign-in across profiles";
  }
}

export const MCP_HEALTH_LABEL: Record<McpHealthStatus, string> = {
  untested: "Not tested",
  ok: "Working",
  needs_auth: "Needs authorization",
  error: "Error",
};

/** "stdio" or "HTTP". */
export function transportLabel(server: McpServerView): string {
  return server.transport.kind === "stdio" ? "stdio" : "HTTP";
}

/** One line describing where the server runs: the command or the URL. */
export function transportTarget(server: McpServerView): string {
  if (server.transport.kind === "stdio") {
    return [server.transport.command, ...server.transport.args].join(" ");
  }
  return server.transport.url;
}

/** "1 tool", "3 tools". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
