import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { Dialog } from "../components/Dialog";
import { CheckboxField, FieldError, TextAreaField, TextField } from "../components/forms";
import { Button, ErrorState, IconButton } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { McpServerView } from "../ipc/bindings";
import { cx } from "../lib/cx";
import { newRow, rowsFromEntries, rowsToEntries, type EntryRow } from "../lib/mcp";
import { linesToList } from "../lib/text";
import { mcpFieldFor, serverNameError, serverUrlError, type McpField } from "../lib/validation";

type Transport = "stdio" | "http";

function entryErrors(rows: readonly EntryRow[], kind: "env" | "header"): string | null {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0 && row.value.length === 0 && !row.stored) continue;
    if (key.length === 0)
      return kind === "env" ? "Every variable needs a name." : "Every header needs a name.";
    const norm = kind === "header" ? key.toLowerCase() : key;
    if (keys.has(norm)) return `'${key}' is listed twice.`;
    keys.add(norm);
    if (row.secret && !row.stored && row.value.length === 0) return `Enter a value for the secret '${key}'.`;
  }
  return null;
}

/**
 * Adds or edits an MCP server. A stored secret is shown as "Stored (hidden)": its value is
 * never received from the core, so it cannot be shown or prefilled. Leaving it as it is
 * keeps it; Replace asks for a new value.
 */
export function McpServerDialog({
  profileId,
  server,
  onClose,
}: {
  profileId: string;
  /** The server to edit; omitted to add one. */
  server?: McpServerView;
  onClose: () => void;
}) {
  const { state, actions } = useVision();
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<Transport>(server?.transport.kind ?? "stdio");
  const [command, setCommand] = useState(server?.transport.kind === "stdio" ? server.transport.command : "");
  const [args, setArgs] = useState(
    server?.transport.kind === "stdio" ? server.transport.args.join("\n") : "",
  );
  const [url, setUrl] = useState(server?.transport.kind === "http" ? server.transport.url : "");
  const [env, setEnv] = useState<EntryRow[]>(() =>
    server?.transport.kind === "stdio" ? rowsFromEntries(server.transport.env) : [],
  );
  const [headers, setHeaders] = useState<EntryRow[]>(() =>
    server?.transport.kind === "http" ? rowsFromEntries(server.transport.headers) : [],
  );
  const [toolIds, setToolIds] = useState<string[]>(server?.tool_ids ?? []);
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [errors, setErrors] = useState<Partial<Record<McpField, string>>>({});
  const save = useAsyncAction((input: Parameters<typeof actions.saveServer>[1]) =>
    actions.saveServer(profileId, input),
  );
  const formRef = useRef<HTMLFormElement>(null);
  const transportName = useId();
  const tools = state.tools[profileId];

  useEffect(() => {
    actions.ensureTools(profileId);
  }, [actions, profileId]);

  const coreField = save.error ? mcpFieldFor(save.error.message) : null;
  const fieldError = (field: McpField): string | undefined =>
    errors[field] ?? (coreField === field && save.error ? save.error.message : undefined);
  const formError = save.error && coreField === null ? save.error : null;

  const clear = (field: McpField) => {
    if (errors[field]) {
      setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field)));
    }
    if (save.error) save.reset();
  };

  const rows = transport === "stdio" ? env : headers;
  const setRows = transport === "stdio" ? setEnv : setHeaders;
  const updateRow = (uid: string, patch: Partial<EntryRow>) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
    clear("entries");
  };

  const knownToolIds = tools?.list.kind === "ready" ? tools.list.data.map((e) => e.view.spec.id) : null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const local: Partial<Record<McpField, string>> = {};
    const nameProblem = serverNameError(name.trim());
    if (nameProblem) local.name = nameProblem;
    if (transport === "stdio") {
      if (command.trim().length === 0) local.command = "Enter the command, for example npx.";
    } else {
      const urlProblem = serverUrlError(url.trim());
      if (urlProblem) local.url = urlProblem;
    }
    const entriesProblem = entryErrors(rows, transport === "stdio" ? "env" : "header");
    if (entriesProblem) local.entries = entriesProblem;
    setErrors(local);
    if (Object.keys(local).length > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    const result = await save.run({
      ...(server ? { id: server.id } : {}),
      name: name.trim(),
      transport:
        transport === "stdio"
          ? {
              kind: "stdio",
              command: command.trim(),
              args: linesToList(args),
              env: rowsToEntries(env),
            }
          : { kind: "http", url: url.trim(), headers: rowsToEntries(headers) },
      // Drop logins of tools that no longer exist, which the core would reject.
      tool_ids: knownToolIds ? toolIds.filter((id) => knownToolIds.includes(id)) : toolIds,
      enabled,
    });
    if (result.ok) onClose();
  };

  const entryLabel = transport === "stdio" ? "Environment variables" : "Headers";
  const entriesErrorId = useId();
  const entriesError = fieldError("entries");

  return (
    <Dialog
      title={server ? `Edit ${server.name}` : "Add MCP server"}
      description={
        server
          ? "Saving resets the health check. Test the server again afterwards."
          : "The server belongs to this profile. Test it after saving to see its tools."
      }
      onClose={onClose}
      size="lg"
      dismissible={!save.busy}
    >
      <form ref={formRef} className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dialog-content">
          <fieldset className="dialog-fields" disabled={save.busy}>
            <TextField
              label="Name"
              value={name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="filesystem"
              hint="Letters, digits, '-' and '_'. Claude Code shows the server under this name."
              error={fieldError("name")}
              onChange={(e) => {
                setName(e.target.value);
                clear("name");
              }}
            />
            <fieldset className="segmented field">
              <legend className="field-label">Transport</legend>
              <div className="segmented-options">
                {(["stdio", "http"] as const).map((t) => (
                  <label key={t} className={cx("segmented-option", transport === t && "is-selected")}>
                    <input
                      type="radio"
                      name={transportName}
                      value={t}
                      checked={transport === t}
                      onChange={() => {
                        setTransport(t);
                        if (save.error) save.reset();
                      }}
                    />
                    <span>{t === "stdio" ? "Local command (stdio)" : "Remote (HTTP)"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {transport === "stdio" ? (
              <>
                <TextField
                  label="Command"
                  value={command}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="npx"
                  hint="A program name on your PATH or an absolute path, without arguments."
                  error={fieldError("command")}
                  onChange={(e) => {
                    setCommand(e.target.value);
                    clear("command");
                  }}
                />
                <TextAreaField
                  label="Arguments"
                  optional
                  rows={3}
                  value={args}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/Users/me/projects"}
                  hint="One per line."
                  error={fieldError("args")}
                  onChange={(e) => {
                    setArgs(e.target.value);
                    clear("args");
                  }}
                />
              </>
            ) : (
              <TextField
                label="URL"
                type="url"
                value={url}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://mcp.example.com/mcp"
                hint="https://, or http:// for localhost only."
                error={fieldError("url")}
                onChange={(e) => {
                  setUrl(e.target.value);
                  clear("url");
                }}
              />
            )}
            <fieldset className="entries field" aria-describedby={entriesError ? entriesErrorId : undefined}>
              <legend className="field-label">
                {entryLabel}
                <span className="field-optional" aria-hidden="true">
                  Optional
                </span>
                <span className="visually-hidden"> (optional)</span>
              </legend>
              {rows.length > 0 && (
                <ul className="entry-list">
                  {rows.map((row, index) => (
                    <EntryRowEditor
                      key={row.uid}
                      row={row}
                      index={index}
                      kind={transport === "stdio" ? "env" : "header"}
                      onChange={(patch) => {
                        updateRow(row.uid, patch);
                      }}
                      onRemove={() => {
                        setRows((prev) => prev.filter((r) => r.uid !== row.uid));
                        clear("entries");
                      }}
                    />
                  ))}
                </ul>
              )}
              {entriesError && <FieldError id={entriesErrorId}>{entriesError}</FieldError>}
              <div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Plus width={14} height={14} aria-hidden="true" />}
                  onClick={() => {
                    setRows((prev) => [...prev, newRow()]);
                  }}
                >
                  {transport === "stdio" ? "Add variable" : "Add header"}
                </Button>
              </div>
              <p className="field-hint">
                Tick Secret for keys and tokens: Vision keeps them in the system credential store and never
                shows them again.
              </p>
            </fieldset>
            <fieldset className="field">
              <legend className="field-label">
                Sign-ins the server may use
                <span className="field-optional" aria-hidden="true">
                  Optional
                </span>
                <span className="visually-hidden"> (optional)</span>
              </legend>
              <p className="field-hint">
                The server's process gets these tools' config folders from this profile, so it acts as the
                signed-in account.
              </p>
              {tools?.list.kind === "ready" ? (
                <div className="check-grid">
                  {tools.list.data.map(({ view }) => (
                    <CheckboxField
                      key={view.spec.id}
                      label={view.spec.name}
                      checked={toolIds.includes(view.spec.id)}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setToolIds((prev) =>
                          on ? [...prev, view.spec.id] : prev.filter((id) => id !== view.spec.id),
                        );
                        clear("tools");
                      }}
                    />
                  ))}
                </div>
              ) : tools?.list.kind === "error" ? (
                <p className="field-hint">The tool list could not be loaded: {tools.list.error.message}</p>
              ) : (
                <p className="field-hint">Loading tools…</p>
              )}
              {fieldError("tools") && (
                <FieldError id={`${entriesErrorId}-tools`}>{fieldError("tools")}</FieldError>
              )}
            </fieldset>
            <CheckboxField
              label="Enabled"
              hint="Only enabled servers are synced to Claude Code."
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
              }}
            />
            {formError && (
              <ErrorState
                compact
                title={server ? "Could not save the server" : "Could not add the server"}
                message={errorText(formError, state.platform)}
              />
            )}
          </fieldset>
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.busy}>
            {server ? "Save changes" : "Add server"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EntryRowEditor({
  row,
  index,
  kind,
  onChange,
  onRemove,
}: {
  row: EntryRow;
  index: number;
  kind: "env" | "header";
  onChange: (patch: Partial<EntryRow>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const n = String(index + 1);
  const what = kind === "env" ? "Variable" : "Header";
  const keyLabel = `${what} ${n} name`;
  const valueLabel = `${what} ${n} value`;
  return (
    <li className="entry-row">
      <label className="visually-hidden" htmlFor={`${id}-key`}>
        {keyLabel}
      </label>
      <input
        id={`${id}-key`}
        className="input is-mono"
        value={row.key}
        placeholder={kind === "env" ? "NAME" : "Authorization"}
        autoComplete="off"
        spellCheck={false}
        readOnly={row.stored}
        title={row.stored ? "Remove the row to rename a stored secret" : undefined}
        onChange={(e) => {
          onChange({ key: e.target.value });
        }}
      />
      {row.stored ? (
        <div className="stored-secret">
          <span className="stored-secret-label" id={`${id}-stored`}>
            <KeyRound width={14} height={14} aria-hidden="true" />
            Stored (hidden)
          </span>
          <Button
            size="sm"
            variant="ghost"
            aria-describedby={`${id}-stored`}
            aria-label={`Replace ${row.key || "secret"}`}
            onClick={() => {
              onChange({ stored: false, value: "" });
              // Focus the new value input once it renders.
              requestAnimationFrame(() => {
                document.getElementById(`${id}-value`)?.focus();
              });
            }}
          >
            Replace
          </Button>
        </div>
      ) : (
        <>
          <label className="visually-hidden" htmlFor={`${id}-value`}>
            {valueLabel}
          </label>
          <input
            id={`${id}-value`}
            className="input is-mono"
            type={row.secret ? "password" : "text"}
            value={row.value}
            placeholder={row.secret ? "Secret value" : "Value"}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onChange({ value: e.target.value });
            }}
          />
        </>
      )}
      <label className="entry-secret">
        <input
          type="checkbox"
          checked={row.secret}
          aria-label={`${what} ${n} is secret`}
          onChange={(e) => {
            // Turning a stored secret into a plain value needs a new value.
            onChange({
              secret: e.target.checked,
              stored: false,
              value: row.stored ? "" : row.value,
            });
          }}
        />
        <span aria-hidden="true">Secret</span>
      </label>
      <IconButton label={`Remove ${what.toLowerCase()} ${n}`} size="sm" onClick={onRemove}>
        <Trash2 width={14} height={14} aria-hidden="true" />
      </IconButton>
    </li>
  );
}
