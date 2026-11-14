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
        }
      : {
          uid,
          key: entry.key,
          secret: true,
          value: "",
          stored: entry.value.has_value,
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
