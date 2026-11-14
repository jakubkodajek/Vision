import { useRef, useState, type SyntheticEvent } from "react";
import { Dialog } from "../components/Dialog";
import { SelectField, TextAreaField, TextField } from "../components/forms";
import { Button, ErrorState } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import { linesToList } from "../lib/text";
import {
  customToolErrors,
  customToolFieldFor,
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

/**
 * Adds a custom tool (app-wide). Each field shows its own error: first from the local
 * checks, then the core's validation message mapped to the field it names.
 */
export function CustomToolDialog({ onClose }: { onClose: () => void }) {
  const { state, actions } = useVision();
  const [text, setText] = useState<FormText>(EMPTY);
  const [idEdited, setIdEdited] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<CustomToolField, string>>>({});
  const save = useAsyncAction(actions.saveCustomTool);
  const formRef = useRef<HTMLFormElement>(null);
  const activeId = state.activeProfileId;
  const slot = activeId ? state.tools[activeId] : undefined;
  const existingIds = slot?.list.kind === "ready" ? slot.list.data.map((e) => e.view.spec.id) : [];

  const coreField = save.error ? customToolFieldFor(save.error.message) : null;
  const fieldError = (field: CustomToolField): string | undefined =>
    errors[field] ?? (coreField === field && save.error ? save.error.message : undefined);
  const formError = save.error && coreField === null ? save.error : null;

  const set = (patch: Partial<FormText>) => {
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
    const draft = toDraft(text);
    const local = customToolErrors(draft);
    // custom_tool_save replaces a tool with the same id; adding must not overwrite one.
    if (!local.id && existingIds.includes(draft.id)) local.id = "A tool with this id already exists.";
    setErrors(local);
    if (Object.keys(local).length > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    const result = await save.run({
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
    });
    if (result.ok) onClose();
  };

  return (
    <Dialog
      title="Add custom tool"
      description="Vision gives the tool its own config folder in every profile through one environment variable, and runs its sign-in in your terminal."
      onClose={onClose}
      size="lg"
      dismissible={!save.busy}
    >
      <form ref={formRef} className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dialog-content">
          <fieldset className="dialog-fields" disabled={save.busy}>
            <div className="field-row">
              <TextField
                label="Name"
                value={text.name}
                maxLength={60}
                autoComplete="off"
                placeholder="My tool"
                error={fieldError("name")}
                onChange={(e) => {
                  set({ name: e.target.value });
                }}
              />
              <TextField
                label="Id"
                value={text.id}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                placeholder="my-tool"
                hint="Lowercase, used in folder names."
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
              maxLength={240}
              error={fieldError("description")}
              onChange={(e) => {
                set({ description: e.target.value });
              }}
            />
            <div className="field-row">
              <TextField
                label="Program"
                value={text.binary}
                autoComplete="off"
                spellCheck={false}
                placeholder="mytool"
                hint="Name of the program on your PATH, without arguments."
                error={fieldError("binary")}
                onChange={(e) => {
                  set({ binary: e.target.value });
                }}
              />
              <TextField
                label="Config variable"
                value={text.configVar}
                autoComplete="off"
                spellCheck={false}
                placeholder="MYTOOL_CONFIG_DIR"
                hint="The variable that tells the tool where to keep its login."
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
                set({ configKind: e.target.value === "file" ? "file" : "dir" });
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
                placeholder={"auth\nlogin"}
                hint="One per line."
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
                placeholder={"auth\nstatus"}
                hint="Exit code 0 means signed in."
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
                placeholder={"auth\nlogout"}
                hint="One per line."
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
              autoComplete="off"
              placeholder="https://example.com/install"
              error={fieldError("installUrl")}
              onChange={(e) => {
                set({ installUrl: e.target.value });
              }}
            />
            {formError && (
              <ErrorState
                compact
                title="Could not add the tool"
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
            Add tool
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
