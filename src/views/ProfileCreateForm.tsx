import { useEffect, useId, useState, type SyntheticEvent, type ReactNode, type RefObject } from "react";
import { Button, ErrorState } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { Accent, Profile } from "../ipc/bindings";
import { firstUnusedAccent } from "../lib/realLabels";
import { profileNameError } from "../lib/validation";
import { ProfileFields, type ProfileDraft } from "./ProfileFields";

/**
 * Form that creates a profile. Name problems (client check, or the core's `invalid_input`
 * and `conflict`) are shown under the name; anything else above the buttons.
 */
export function ProfileCreateForm({
  onCreated,
  submitLabel,
  secondary,
  nameRef,
  defaultKind = "work",
  onAccentChange,
}: {
  /** Called while the form is still shown; the first profile replaces the welcome screen itself. */
  onCreated?: (profile: Profile) => void;
  submitLabel: string;
  /** Extra button next to submit, e.g. Cancel. */
  secondary?: ReactNode;
  nameRef?: RefObject<HTMLInputElement | null>;
  defaultKind?: ProfileDraft["kind"];
  /** Told the chosen accent, so the page around the form can preview it. */
  onAccentChange?: (accent: Accent) => void;
}) {
  const { state, actions } = useVision();
  const idPrefix = useId();
  const [draft, setDraft] = useState<ProfileDraft>(() => ({
    name: "",
    kind: defaultKind,
    accent: firstUnusedAccent(state.profiles),
  }));
  const [nameError, setNameError] = useState<string | null>(null);
  const create = useAsyncAction(actions.createProfile);
  const coreFieldError = create.error?.field === "name" ? create.error.message : null;
  const formError = create.error && !coreFieldError ? create.error : null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (create.busy) return;
    const local = profileNameError(draft.name);
    setNameError(local);
    if (local) {
      nameRef?.current?.focus();
      return;
    }
    const result = await create.run({
      name: draft.name.trim(),
      kind: draft.kind,
      accent: draft.accent,
    });
    if (result.ok) onCreated?.(result.value);
  };

  // A core error about the name: focus the field once it shows the message.
  useEffect(() => {
    if (create.error?.field === "name") nameRef?.current?.focus();
  }, [create.error, nameRef]);

  return (
    <form className="profile-form" onSubmit={(e) => void submit(e)} noValidate>
      <ProfileFields
        idPrefix={idPrefix}
        value={draft}
        nameRef={nameRef}
        disabled={create.busy}
        nameError={nameError ?? coreFieldError}
        onChange={(next) => {
          setDraft(next);
          if (next.accent !== draft.accent) onAccentChange?.(next.accent);
          if (nameError) setNameError(null);
          if (create.error) create.reset();
        }}
      />
      {formError && (
        <ErrorState
          compact
          title="Could not create the profile"
          message={errorText(formError, state.platform)}
        />
      )}
      <div className="form-actions">
        {secondary}
        <Button type="submit" variant="primary" loading={create.busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
