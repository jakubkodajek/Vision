import { Check, KeyRound, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { Dialog, DialogCancel } from "../components/Dialog";
import {
  CheckboxField,
  ErrorSummary,
  FieldError,
  FormBusy,
  TextAreaField,
  TextField,
} from "../components/forms";
import { useInvalidFocus } from "../components/useInvalidFocus";
import { Button, ErrorState, IconButton } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { McpServerView } from "../ipc/bindings";
import { cx } from "../lib/cx";
import {
  newRow,
  rowErrors,
  rowsFromEntries,
  rowsToEntries,
  urlOrigin,
  type EntryRow,
  type RowError,
} from "../lib/mcp";
import { linesToList } from "../lib/text";
import { LIMITS, mcpField, serverNameError, serverUrlError, type McpField } from "../lib/validation";

type Transport = "stdio" | "http";

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
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
  const [rowProblems, setRowProblems] = useState<RowError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const save = useAsyncAction((input: Parameters<typeof actions.saveServer>[1]) =>
    actions.saveServer(profileId, input),
  );
  const formRef = useRef<HTMLFormElement>(null);
  const transportName = useId();
  const tools = state.tools[profileId];
  const [initial] = useState(() => ({
    name,
    transport,
    command,
    args,
    url,
    env,
    headers,
    toolIds,
    enabled,
  }));
  useInvalidFocus(formRef, attempt);

  useEffect(() => {
    actions.ensureTools(profileId);
  }, [actions, profileId]);

  const rows = transport === "stdio" ? env : headers;
  const setRows = transport === "stdio" ? setEnv : setHeaders;
  const kind = transport === "stdio" ? "env" : "header";

  // The core does not send a kept secret to a new destination: compare parsed values, so
  // reformatting (spaces, a trailing slash in the path) is not a change.
  const destinationChanged =
    server !== undefined &&
    (server.transport.kind !== transport ||
      (server.transport.kind === "http" && urlOrigin(server.transport.url) !== urlOrigin(url.trim())) ||
      (server.transport.kind === "stdio" &&
        (server.transport.command !== command.trim() ||
          !sameList(server.transport.args, linesToList(args)))));

  const shown: readonly McpField[] =
    transport === "stdio"
      ? ["name", "command", "args", "entries", "tools"]
      : ["name", "url", "entries", "tools"];
  const mapped = mcpField(save.error);
  // An error about a field this form does not show right now is shown for the whole form.
  const coreField = mapped !== null && shown.includes(mapped) ? mapped : null;
  const coreRow =
    save.error?.entry_key && coreField === "entries"
      ? rows.find((r) => r.key.trim() === save.error?.entry_key)
      : undefined;
  const fieldError = (field: McpField): string | undefined =>
    errors[field] ??
    (coreField === field && save.error && !(field === "entries" && coreRow) ? save.error.message : undefined);
  const rowError = (uid: string, part: "key" | "value"): string | undefined =>
    rowProblems.find((p) => p.uid === uid && p.part === part)?.message ??
    (coreRow?.uid === uid && save.error && part === (coreRow.stored || coreRow.secret ? "value" : "key")
      ? save.error.message
      : undefined);
  const formError = save.error && coreField === null ? save.error : null;
  const errorCount = Object.keys(errors).length + rowProblems.length + (save.error ? 1 : 0);
  const dirty =
    name !== initial.name ||
    transport !== initial.transport ||
    command !== initial.command ||
    args !== initial.args ||
    url !== initial.url ||
    env !== initial.env ||
    headers !== initial.headers ||
    !sameList(toolIds, initial.toolIds) ||
    enabled !== initial.enabled;

  const clear = (field: McpField) => {
    if (errors[field]) {
      setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== field)));
    }
    if (save.error) save.reset();
  };

  const updateRow = (uid: string, patch: Partial<EntryRow>) => {
    if (save.busy) return;
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
    setRowProblems((prev) => prev.filter((p) => p.uid !== uid));
    clear("entries");
  };

  const knownToolIds = tools?.list.kind === "ready" ? tools.list.data.map((e) => e.view.spec.id) : null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (save.busy) return;
    const local: Partial<Record<McpField, string>> = {};
    const nameProblem = serverNameError(name.trim());
    if (nameProblem) local.name = nameProblem;
    if (transport === "stdio") {
      if (command.trim().length === 0) local.command = "Enter the command, e.g. npx.";
      else if (command.trim().length > LIMITS.command)
        local.command = `Use at most ${String(LIMITS.command)} characters.`;
      const list = linesToList(args);
      if (list.length > LIMITS.serverArguments)
        local.args = `Use at most ${String(LIMITS.serverArguments)} arguments.`;
      else if (list.some((a) => a.length > LIMITS.serverArgument))
        local.args = `Use at most ${String(LIMITS.serverArgument)} characters per argument.`;
    } else {
      const urlProblem = serverUrlError(url.trim());
      if (urlProblem) local.url = urlProblem;
    }
    const filled = rows.filter(
      (r) => r.key.trim().length > 0 || r.value.length > 0 || r.stored || r.wasStored,
    );
    if (filled.length > LIMITS.entries) local.entries = `Use at most ${String(LIMITS.entries)} entries.`;
    const problems = rowErrors(rows, kind, destinationChanged);
    setErrors(local);
    setRowProblems(problems);
    if (Object.keys(local).length > 0 || problems.length > 0) {
      setAttempt((n) => n + 1);
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
    else setAttempt((n) => n + 1);
  };

  const entryLabel = transport === "stdio" ? "Environment variables" : "Headers";
  const entriesErrorId = useId();
  const entriesError = fieldError("entries");

  return (
    <Dialog
      title={server ? `Edit ${server.name}` : "Add MCP server"}
      description={
        server
          ? "Changing the command, address or a secret resets the health check; test the server again afterwards."
          : "The server belongs to this profile. Test it after saving to see its tools."
      }
      onClose={onClose}
      size="lg"
      dismissible={!save.busy}
      dirty={dirty}
    >
      <form ref={formRef} className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dialog-content">
          <FormBusy busy={save.busy}>
            <div className="dialog-fields">
              <TextField
                label="Name"
                value={name}
                maxLength={LIMITS.serverName}
                autoComplete="off"
                spellCheck={false}
                hint="Letters, digits, '-' and '_', e.g. filesystem. Claude Code shows the server under this name."
                error={fieldError("name")}
                onChange={(e) => {
                  if (save.busy) return;
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
                          if (save.busy) return;
                          setTransport(t);
                          setRowProblems([]);
                          if (save.error) save.reset();
                        }}
                      />
                      {transport === t && <Check width={14} height={14} aria-hidden="true" />}
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
                    maxLength={LIMITS.command}
                    autoComplete="off"
                    spellCheck={false}
                    hint="A program name on your PATH or an absolute path, without arguments, e.g. npx."
                    error={fieldError("command")}
                    onChange={(e) => {
                      if (save.busy) return;
                      setCommand(e.target.value);
                      clear("command");
                    }}
                  />
                  <TextAreaField
                    label="Arguments"
                    optional
                    rows={3}
                    value={args}
                    hint="One per line, e.g. -y, then @modelcontextprotocol/server-filesystem. Spaces inside a line are kept; empty lines are ignored."
                    error={fieldError("args")}
                    onChange={(e) => {
                      if (save.busy) return;
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
                  maxLength={LIMITS.url}
                  autoComplete="off"
                  spellCheck={false}
                  hint="https://, or http:// for localhost only, e.g. https://mcp.example.com/mcp."
                  error={fieldError("url")}
                  onChange={(e) => {
                    if (save.busy) return;
                    setUrl(e.target.value);
                    clear("url");
                  }}
                />
              )}
              <fieldset
                className="entries field"
                aria-describedby={entriesError ? entriesErrorId : undefined}
              >
                <legend className="field-label">
                  {entryLabel}
                  <span className="field-optional" aria-hidden="true">
                    Optional
                  </span>
                  <span className="visually-hidden"> (optional)</span>
                </legend>
                {rows.length > 0 && (
                  <>
                    <div className="entry-columns" aria-hidden="true">
                      <span>Name</span>
                      <span>Value</span>
                      <span>Secret</span>
                    </div>
                    <ul className="entry-list">
                      {rows.map((row, index) => (
                        <EntryRowEditor
                          key={row.uid}
                          row={row}
                          index={index}
                          kind={kind}
                          reenter={destinationChanged}
                          keyError={rowError(row.uid, "key")}
                          valueError={rowError(row.uid, "value")}
                          busy={save.busy}
                          onChange={(patch) => {
                            updateRow(row.uid, patch);
                          }}
                          onRemove={() => {
                            if (save.busy) return;
                            setRows((prev) => prev.filter((r) => r.uid !== row.uid));
                            setRowProblems((prev) => prev.filter((p) => p.uid !== row.uid));
                            clear("entries");
                          }}
                        />
                      ))}
                    </ul>
                  </>
                )}
                {entriesError && <FieldError id={entriesErrorId}>{entriesError}</FieldError>}
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Plus width={14} height={14} aria-hidden="true" />}
                    inactive={save.busy}
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
                          if (save.busy) return;
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
                  if (!save.busy) setEnabled(e.target.checked);
                }}
              />
              {formError && (
                <div data-form-error tabIndex={-1}>
                  <ErrorState
                    compact
                    title={server ? "Could not save the server" : "Could not add the server"}
                    message={errorText(formError, state.platform)}
                  />
                </div>
              )}
              <ErrorSummary count={errorCount} attempt={attempt} />
            </div>
          </FormBusy>
        </div>
        <div className="dialog-footer">
          <DialogCancel inactive={save.busy} />
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
  reenter,
  keyError,
  valueError,
  busy,
  onChange,
  onRemove,
}: {
  row: EntryRow;
  index: number;
  kind: "env" | "header";
  /** The destination changed: a stored secret has to be entered again. */
  reenter: boolean;
  keyError?: string;
  valueError?: string;
  busy: boolean;
  onChange: (patch: Partial<EntryRow>) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const n = String(index + 1);
  const what = kind === "env" ? "Variable" : "Header";
  const keyLabel = `${what} ${n} name`;
  const valueLabel = `${what} ${n} value`;
  const keyErrorId = `${id}-key-error`;
  const valueErrorId = `${id}-value-error`;
  const reenterId = `${id}-reenter`;
  const showStored = row.stored && !reenter;
  return (
    <li className="entry-row">
      <div className="entry-cell">
        <label className="visually-hidden" htmlFor={`${id}-key`}>
          {keyLabel}
        </label>
        <input
          id={`${id}-key`}
          className="input is-mono"
          value={row.key}
          maxLength={kind === "env" ? LIMITS.envKey : LIMITS.headerKey}
          autoComplete="off"
          spellCheck={false}
          readOnly={row.wasStored || busy}
          title={row.wasStored ? "Remove the row to rename a stored secret" : undefined}
          aria-invalid={keyError ? true : undefined}
          aria-describedby={keyError ? keyErrorId : undefined}
          onChange={(e) => {
            onChange({ key: e.target.value });
          }}
        />
        {keyError && <FieldError id={keyErrorId}>{keyError}</FieldError>}
      </div>
      <div className="entry-cell">
        {showStored ? (
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
              inactive={busy}
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
              maxLength={LIMITS.value}
              autoComplete="off"
              spellCheck={false}
              readOnly={busy}
              aria-invalid={valueError ? true : undefined}
              aria-describedby={
                [valueError && valueErrorId, row.stored && reenter && !valueError && reenterId]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onChange={(e) => {
                onChange({
                  value: e.target.value,
                  ...(row.stored ? { stored: false } : {}),
                });
              }}
            />
            {valueError ? (
              <FieldError id={valueErrorId}>{valueError}</FieldError>
            ) : (
              row.stored &&
              reenter && (
                <p id={reenterId} className="field-hint">
                  Enter this value again because the server address or command changed.
                </p>
              )
            )}
          </>
        )}
      </div>
      <label className="entry-secret">
        <input
          type="checkbox"
          checked={row.secret}
          aria-label={`${what} ${n} is secret`}
          aria-disabled={busy || undefined}
          onChange={(e) => {
            if (busy) return;
            const secret = e.target.checked;
            // Unticking a stored secret needs a new plain value; ticking it again while
            // nothing was typed keeps the stored one.
            onChange(
              row.wasStored
                ? {
                    secret,
                    stored: secret && row.value.length === 0,
                    value: row.value,
                  }
                : { secret },
            );
          }}
        />
        <span aria-hidden="true">Secret</span>
      </label>
      <IconButton
        label={`Remove ${what.toLowerCase()} ${n}`}
        size="sm"
        aria-disabled={busy || undefined}
        onClick={onRemove}
      >
        <Trash2 width={14} height={14} aria-hidden="true" />
      </IconButton>
    </li>
  );
}
