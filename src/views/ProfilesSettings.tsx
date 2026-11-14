import { Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useId, useRef, useState, type SyntheticEvent } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog } from "../components/Dialog";
import { TextField } from "../components/forms";
import { ProfileAvatar } from "../components/ProfileSwitcher";
import { Button, ErrorState } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { Profile } from "../ipc/bindings";
import { profileKindLabel } from "../lib/realLabels";
import { profileNameError } from "../lib/validation";
import { ProfileFields, type ProfileDraft } from "./ProfileFields";

/** Settings section: every profile with rename, kind, colour and delete. */
export function ProfilesSettings({ onNewProfile }: { onNewProfile: () => void }) {
  const { state } = useVision();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  return (
    <section className="settings-group" aria-labelledby="settings-profiles">
      <div className="settings-group-header">
        <h3 id="settings-profiles" className="section-heading" tabIndex={-1} data-focus-fallback>
          Profiles
        </h3>
        <Button size="sm" icon={<Plus width={14} height={14} aria-hidden="true" />} onClick={onNewProfile}>
          New profile
        </Button>
      </div>
      <ul className="settings-list profile-list">
        {state.profiles.map((profile) => (
          <li key={profile.id} className="profile-row">
            <ProfileAvatar profile={{ ...profile, account: "" }} />
            <span className="profile-row-text">
              <span className="profile-row-name">{profile.name}</span>
              <span className="profile-row-kind">
                {profile.id === state.activeProfileId
                  ? `${profileKindLabel(profile.kind)} · Active`
                  : profileKindLabel(profile.kind)}
              </span>
            </span>
            <span className="profile-row-actions">
              <Button
                size="sm"
                variant="ghost"
                icon={<Pencil width={14} height={14} aria-hidden="true" />}
                aria-label={`Edit ${profile.name}`}
                onClick={() => {
                  setEditing(profile);
                }}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="is-danger-text"
                icon={<Trash2 width={14} height={14} aria-hidden="true" />}
                aria-label={`Delete ${profile.name}`}
                onClick={() => {
                  setDeleting(profile);
                }}
              >
                Delete
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <p className="settings-help">
        Each profile has its own tool sign-ins and MCP servers. Switch profiles from the top of the sidebar.
      </p>
      {editing && (
        <EditProfileDialog
          profile={editing}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {deleting && (
        <DeleteProfileDialog
          profile={deleting}
          onClose={() => {
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

/** Rename a profile and change its kind and colour. */
export function EditProfileDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { state, actions } = useVision();
  const idPrefix = useId();
  const [draft, setDraft] = useState<ProfileDraft>({
    name: profile.name,
    kind: profile.kind,
    accent: profile.accent,
  });
  const [nameError, setNameError] = useState<string | null>(null);
  const save = useAsyncAction(actions.updateProfile);
  const nameRef = useRef<HTMLInputElement>(null);
  const coreNameError =
    save.error && (save.error.code === "invalid_input" || save.error.code === "conflict")
      ? save.error.message
      : null;
  const formError = save.error && !coreNameError ? save.error : null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const local = profileNameError(draft.name);
    setNameError(local);
    if (local) {
      nameRef.current?.focus();
      return;
    }
    const name = draft.name.trim();
    const result = await save.run({
      id: profile.id,
      ...(name !== profile.name ? { name } : {}),
      ...(draft.kind !== profile.kind ? { kind: draft.kind } : {}),
      ...(draft.accent !== profile.accent ? { accent: draft.accent } : {}),
    });
    if (result.ok) onClose();
  };

  return (
    <Dialog title={`Edit ${profile.name}`} onClose={onClose} dismissible={!save.busy} initialFocus={nameRef}>
      <form className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        <div className="dialog-content">
          <ProfileFields
            idPrefix={idPrefix}
            value={draft}
            nameRef={nameRef}
            disabled={save.busy}
            nameError={nameError ?? coreNameError}
            onChange={(next) => {
              setDraft(next);
              setNameError(null);
              save.reset();
            }}
          />
          {formError && (
            <ErrorState
              compact
              title="Could not save the profile"
              message={errorText(formError, state.platform)}
            />
          )}
        </div>
        <div className="dialog-footer">
          <Button onClick={onClose} disabled={save.busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={save.busy}>
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Delete with typed-name confirmation and a warning about sign-ins kept outside Vision. */
export function DeleteProfileDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const { state, actions } = useVision();
  const [typed, setTyped] = useState("");
  const slot = state.tools[profile.id];
  const signedIn =
    slot?.list.kind === "ready"
      ? slot.list.data.filter((e) => e.view.status?.status === "signed_in").map((e) => e.view.spec.name)
      : [];
  return (
    <ConfirmDialog
      title={`Delete ${profile.name}?`}
      description={`This removes the profile, its tool sign-ins stored in its folder and its MCP servers with their secret values. It cannot be undone.`}
      confirmLabel="Delete profile"
      confirmDisabled={typed !== profile.name}
      errorTitle="Could not delete the profile"
      platform={state.platform}
      onConfirm={() => actions.deleteProfile(profile.id, typed)}
      onClose={onClose}
    >
      <div className="callout is-warning">
        <TriangleAlert width={16} height={16} aria-hidden="true" />
        <div>
          <p>
            Sign out of each tool in Tools first. Some tools keep their sign-in outside the profile folder,
            for example Claude Code on macOS in the Keychain, and deleting the profile does not remove those.
          </p>
          {signedIn.length > 0 && <p className="callout-strong">Still signed in: {signedIn.join(", ")}.</p>}
        </div>
      </div>
      <TextField
        label={`Type ${profile.name} to confirm`}
        value={typed}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setTyped(e.target.value);
        }}
      />
    </ConfirmDialog>
  );
}
