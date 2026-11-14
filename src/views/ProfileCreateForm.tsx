import { useId, useState, type SyntheticEvent, type ReactNode, type RefObject } from "react";
import { Button, ErrorState } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { Profile } from "../ipc/bindings";
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
}: {
  /** Called while the form is still shown; the first profile replaces the welcome screen itself. */
  onCreated?: (profile: Profile) => void;
  submitLabel: string;
  /** Extra button next to submit, e.g. Cancel. */
  secondary?: ReactNode;
  nameRef?: RefObject<HTMLInputElement | null>;
  defaultKind?: ProfileDraft["kind"];
}) {
  const { state, actions } = useVision();
  const idPrefix = useId();
  const [draft, setDraft] = useState<ProfileDraft>({
    name: "",
    kind: defaultKind,
    accent: "iris",
  });
  const [nameError, setNameError] = useState<string | null>(null);
  const create = useAsyncAction(actions.createProfile);
  const coreFieldError =
    create.error && (create.error.code === "invalid_input" || create.error.code === "conflict")
      ? create.error.message
      : null;
  const formError = create.error && !coreFieldError ? create.error : null;

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
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
