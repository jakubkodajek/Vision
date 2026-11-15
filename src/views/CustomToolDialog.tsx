import { useRef, useState, type SyntheticEvent } from "react";
import { Dialog, DialogCancel } from "../components/Dialog";
import {
  ErrorSummary,
  FormBusy,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/forms";
import { useInvalidFocus } from "../components/useInvalidFocus";
import { Button, ErrorState } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { ToolSpecView } from "../ipc/bindings";
import { linesToList } from "../lib/text";
import {
  customToolErrors,
  customToolField,
  LIMITS,
  toolIdFromName,
  type CustomToolDraft,
  type CustomToolField,
} from "../lib/validation";

interface FormText {
  name: string;
  id: string;
  description: string;
  binary: string;
  configVar: string;
  configKind: "dir" | "file";
  login: string;
  status: string;
  logout: string;
  installUrl: string;
}

const EMPTY: FormText = {
  name: "",
  id: "",
  description: "",
  binary: "",
  configVar: "",
  configKind: "dir",
  login: "",
  status: "",
  logout: "",
  installUrl: "",
};

/** The form text of an existing custom tool, to edit it. */
function fromSpec(spec: ToolSpecView): FormText {
  const config = spec.config_env[0];
  return {
    name: spec.name,
    id: spec.id,
    description: spec.description,
    binary: spec.binary,
    configVar: config?.var ?? "",
    configKind: config?.kind === "file" ? "file" : "dir",
    login: spec.login.join("\n"),
    status: (spec.status ?? []).join("\n"),
    logout: (spec.logout ?? []).join("\n"),
    installUrl: spec.install_url ?? "",
  };
}

function toDraft(t: FormText): CustomToolDraft {
  return {
    name: t.name,
    id: t.id.trim(),
    description: t.description.trim(),
    binary: t.binary.trim(),
    configVar: t.configVar.trim(),
    configKind: t.configKind,
    login: linesToList(t.login),
    status: linesToList(t.status),
    logout: linesToList(t.logout),
    installUrl: t.installUrl.trim(),
  };
}

const ARGS_HINT = "One per line. Spaces inside a line are kept; empty lines are ignored.";

/**
 * Adds a custom tool (app-wide), or edits one when `tool` is given (the core replaces it;
 * its identifier cannot change). Each field shows its own error: first from the local
 * checks, then the core's error on the field it names; an error about anything else is
 * shown for the whole form.
 */
export function CustomToolDialog({ tool, onClose }: { tool?: ToolSpecView; onClose: () => void }) {
  const { state, actions } = useVision();
  const editing = tool !== undefined;
  const [initial] = useState<FormText>(() => (tool ? fromSpec(tool) : EMPTY));
  const [text, setText] = useState<FormText>(initial);
  const [idEdited, setIdEdited] = useState(editing);
  const [errors, setErrors] = useState<Partial<Record<CustomToolField, string>>>({});
  const [attempt, setAttempt] = useState(0);
  const save = useAsyncAction(actions.saveCustomTool);
  const formRef = useRef<HTMLFormElement>(null);
  const activeId = state.activeProfileId;
  const slot = activeId ? state.tools[activeId] : undefined;
  // The id check needs the list: adding waits for it so it cannot replace a tool by mistake.
  const listReady = slot?.list.kind === "ready";
  const existingIds = slot?.list.kind === "ready" ? slot.list.data.map((e) => e.view.spec.id) : [];
  useInvalidFocus(formRef, attempt);

  const coreField = customToolField(save.error);
  const fieldError = (field: CustomToolField): string | undefined =>
    errors[field] ?? (coreField === field && save.error ? save.error.message : undefined);
  const formError = save.error && coreField === null ? save.error : null;
  const errorCount = Object.keys(errors).length + (save.error ? 1 : 0);
  const dirty = (Object.keys(text) as (keyof FormText)[]).some((k) => text[k] !== initial[k]);

  const set = (patch: Partial<FormText>) => {
    if (save.busy) return;
    setText((prev) => {
      const next = { ...prev, ...patch };
      if (patch.name !== undefined && !idEdited) next.id = toolIdFromName(patch.name);
      return next;
    });
    const touched = Object.keys(patch) as CustomToolField[];
    if (touched.some((k) => errors[k])) {
      setErrors((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([k]) => !touched.includes(k as CustomToolField))),
      );
    }
    if (save.error) save.reset();
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (save.busy || (!editing && !listReady)) return;
    const draft = toDraft(text);
    const local = customToolErrors(draft);
    if (!editing && !local.id && existingIds.includes(draft.id))
      local.id = "A tool with this identifier already exists. Choose another one.";
    setErrors(local);
    if (Object.keys(local).length > 0) {
      setAttempt((n) => n + 1);
      return;
    }
    const result = await save.run(
      {
        id: draft.id,
        name: draft.name.trim(),
        ...(draft.description ? { description: draft.description } : {}),
        binary: draft.binary,
        ...(draft.installUrl ? { install_url: draft.installUrl } : {}),
        config_var: draft.configVar,
        config_kind: draft.configKind,
        login: draft.login,
        ...(draft.status.length > 0 ? { status: draft.status } : {}),
        ...(draft.logout.length > 0 ? { logout: draft.logout } : {}),
      },
      editing,
    );
    if (result.ok) onClose();
    else setAttempt((n) => n + 1);
  };

  return (
    <Dialog
      title={editing ? `Edit ${tool.name}` : "Add custom tool"}
      description="Vision gives the tool its own config folder in every profile through one environment variable, and runs its sign-in in your terminal."
      onClose={onClose}
      size="lg"
      dismissible={!save.busy}
      dirty={dirty}
    >
      <form ref={formRef} className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dialog-content">
          <FormBusy busy={save.busy}>
            <div className="dialog-fields">
              <div className="field-row">
                <TextField
                  label="Name"
                  value={text.name}
                  maxLength={LIMITS.toolName}
                  autoComplete="off"
                  hint="Shown on the tool's card."
                  error={fieldError("name")}
                  onChange={(e) => {
                    set({ name: e.target.value });
                  }}
                />
                <TextField
                  label="Identifier"
                  value={text.id}
                  maxLength={LIMITS.toolId}
                  autoComplete="off"
                  spellCheck={false}
                  readOnly={editing}
                  hint={
                    editing
                      ? "The identifier cannot change. Delete the tool and add it again to change it."
                      : "Names the tool's folder in each profile. Lowercase letters, digits, - and _; filled in from the name."
                  }
                  error={fieldError("id")}
                  onChange={(e) => {
                    setIdEdited(true);
                    set({ id: e.target.value });
                  }}
                />
              </div>
              <TextField
                label="Description"
                optional
                value={text.description}
                maxLength={LIMITS.toolDescription}
                error={fieldError("description")}
                onChange={(e) => {
                  set({ description: e.target.value });
                }}
              />
              <div className="field-row">
                <TextField
                  label="Program"
                  value={text.binary}
                  maxLength={LIMITS.binary}
                  autoComplete="off"
                  spellCheck={false}
                  hint="Name of the program on your PATH, without arguments, e.g. mytool."
                  error={fieldError("binary")}
                  onChange={(e) => {
                    set({ binary: e.target.value });
                  }}
                />
                <TextField
                  label="Config variable"
                  value={text.configVar}
                  maxLength={LIMITS.configVar}
                  autoComplete="off"
                  spellCheck={false}
                  hint="The variable that tells the tool where to keep its login. It ends in _CONFIG_DIR, _HOME, _DIR or _CONFIG, e.g. MYTOOL_CONFIG_DIR; KUBECONFIG, DOCKER_CONFIG and HELM_CONFIG_HOME also work."
                  error={fieldError("configVar")}
                  onChange={(e) => {
                    set({ configVar: e.target.value });
                  }}
                />
              </div>
              <SelectField
                label="The variable points to"
                value={text.configKind}
                onChange={(e) => {
                  set({
                    configKind: e.target.value === "file" ? "file" : "dir",
                  });
                }}
              >
                <option value="dir">A folder</option>
                <option value="file">A file</option>
              </SelectField>
              <div className="field-row is-three">
                <TextAreaField
                  label="Sign-in arguments"
                  rows={3}
                  value={text.login}
                  hint={`${ARGS_HINT} E.g. auth, then login.`}
                  error={fieldError("login")}
                  onChange={(e) => {
                    set({ login: e.target.value });
                  }}
                />
                <TextAreaField
                  label="Status arguments"
                  optional
                  rows={3}
                  value={text.status}
                  hint="One per line. Exit code 0 means signed in."
                  error={fieldError("status")}
                  onChange={(e) => {
                    set({ status: e.target.value });
                  }}
                />
                <TextAreaField
                  label="Sign-out arguments"
                  optional
                  rows={3}
                  value={text.logout}
                  hint={ARGS_HINT}
                  error={fieldError("logout")}
                  onChange={(e) => {
                    set({ logout: e.target.value });
                  }}
                />
              </div>
              <TextField
                label="Install page"
                optional
                type="url"
                value={text.installUrl}
                maxLength={LIMITS.url}
                autoComplete="off"
                hint="An https:// address, e.g. https://example.com/install."
                error={fieldError("installUrl")}
                onChange={(e) => {
                  set({ installUrl: e.target.value });
                }}
              />
              {formError && (
                <div data-form-error tabIndex={-1}>
                  <ErrorState
                    compact
                    title={editing ? "Could not save the tool" : "Could not add the tool"}
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
          <Button type="submit" variant="primary" loading={save.busy} inactive={!editing && !listReady}>
            {editing ? "Save changes" : "Add tool"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
