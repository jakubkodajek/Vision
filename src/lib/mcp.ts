/** Conversions between MCP server views (from the core) and inputs (to the core). */
import type { KeyValueInput, KeyValueView, McpServerInput, McpServerView } from "../ipc/bindings";

/** A stored secret is sent back without a value, which tells the core to keep it. */
export function entryToInput(entry: KeyValueView): KeyValueInput {
  return entry.value.kind === "plain"
    ? { key: entry.key, value: { kind: "plain", value: entry.value.value } }
    : { key: entry.key, value: { kind: "secret" } };
}

/** The save input that reproduces `server`, with optional changes. Secrets are kept. */
export function serverToInput(
  server: McpServerView,
  changes: Partial<Pick<McpServerInput, "enabled" | "tool_ids">> = {},
): McpServerInput {
  const transport: McpServerInput["transport"] =
    server.transport.kind === "stdio"
      ? {
          kind: "stdio",
          command: server.transport.command,
          args: server.transport.args,
          env: server.transport.env.map(entryToInput),
        }
      : {
          kind: "http",
          url: server.transport.url,
          headers: server.transport.headers.map(entryToInput),
        };
  return {
    id: server.id,
    name: server.name,
    transport,
    tool_ids: changes.tool_ids ?? server.tool_ids,
    enabled: changes.enabled ?? server.enabled,
  };
}

/** One editable env or header row in the server form. */
export interface EntryRow {
  /** Stable React key. */
  uid: string;
  key: string;
  secret: boolean;
  /** Typed value; always empty for a stored secret that is kept. */
  value: string;
  /** A secret already stored in the credential store, kept unless replaced. */
  stored: boolean;
  /**
   * The row came from a stored secret. Unticking Secret then needs a new value (an empty
   * plain value would destroy the secret), and ticking it again while nothing was typed
   * keeps the stored one.
   */
  wasStored: boolean;
}

let rowCounter = 0;

/** A new empty row. */
export function newRow(): EntryRow {
  rowCounter += 1;
  return {
    uid: `row-${String(rowCounter)}`,
    key: "",
    secret: false,
    value: "",
    stored: false,
    wasStored: false,
  };
}

/** Rows for an existing server. Secret values are never available, only that one is stored. */
export function rowsFromEntries(entries: readonly KeyValueView[]): EntryRow[] {
  return entries.map((entry) => {
    rowCounter += 1;
    const uid = `row-${String(rowCounter)}`;
    return entry.value.kind === "plain"
      ? {
          uid,
          key: entry.key,
          secret: false,
          value: entry.value.value,
          stored: false,
          wasStored: false,
        }
      : {
          uid,
          key: entry.key,
          secret: true,
          value: "",
          stored: entry.value.has_value,
          wasStored: entry.value.has_value,
        };
  });
}

/** Rows to inputs; empty rows are dropped. */
export function rowsToEntries(rows: readonly EntryRow[]): KeyValueInput[] {
  return rows
    .filter((row) => row.key.trim().length > 0 || row.value.length > 0)
    .map((row) => {
      const key = row.key.trim();
      if (!row.secret) return { key, value: { kind: "plain", value: row.value } };
      if (row.stored) return { key, value: { kind: "secret" } };
      return { key, value: { kind: "secret", value: row.value } };
    });
}

/** One problem in an env or header row, shown on that row's name or value input. */
export interface RowError {
  uid: string;
  part: "key" | "value";
  message: string;
}

/**
 * Every problem in the rows (not only the first): missing names, names listed twice
 * (case-insensitive for headers), too long names or values, a secret without a value, a
 * stored secret turned plain without a new value, and a kept secret that has to be entered
 * again because the destination changed (`reenter`).
 */
export function rowErrors(rows: readonly EntryRow[], kind: "env" | "header", reenter: boolean): RowError[] {
  const errors: RowError[] = [];
  const seen = new Set<string>();
  const keyLimit = kind === "env" ? 128 : 64;
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0 && row.value.length === 0 && !row.stored && !row.wasStored) continue;
    if (key.length === 0) {
      errors.push({
        uid: row.uid,
        part: "key",
        message: kind === "env" ? "Enter a name for this variable." : "Enter a name for this header.",
      });
    } else {
      const norm = kind === "header" ? key.toLowerCase() : key;
      if (seen.has(norm))
        errors.push({
          uid: row.uid,
          part: "key",
          message: `'${key}' is listed twice. Remove one of them.`,
        });
      else if (key.length > keyLimit)
        errors.push({
          uid: row.uid,
          part: "key",
          message: `Use at most ${String(keyLimit)} characters.`,
        });
      seen.add(norm);
    }
    if (row.value.length > 8192) {
      errors.push({
        uid: row.uid,
        part: "value",
        message: "Use at most 8192 characters.",
      });
    } else if (row.stored && reenter) {
      errors.push({
        uid: row.uid,
        part: "value",
        message: "Enter this value again because the server address or command changed.",
      });
    } else if (row.wasStored && !row.secret && row.value.length === 0) {
      errors.push({
        uid: row.uid,
        part: "value",
        message: "Enter the new plain value, or tick Secret again to keep the stored one.",
      });
    } else if (row.secret && !row.stored && row.value.length === 0) {
      errors.push({
        uid: row.uid,
        part: "value",
        message: "Enter a value for this secret.",
      });
    }
  }
  return errors;
}

/** `scheme://host:port` of a URL, or `null` when it does not parse. */
export function urlOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    return `${u.protocol}//${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}
