import { Check } from "lucide-react";
import type { Ref } from "react";
import { TextField } from "../components/forms";
import { LIMITS } from "../lib/validation";
import type { Accent, ProfileKind } from "../ipc/bindings";
import { cx } from "../lib/cx";
import { ACCENTS, PROFILE_KINDS } from "../lib/realLabels";

/** Values of the profile form. */
export interface ProfileDraft {
  name: string;
  kind: ProfileKind;
  accent: Accent;
}

/**
 * Name, kind and accent inputs shared by Welcome, New profile and Edit profile. While
 * `disabled` (a request runs) the inputs ignore changes but stay focusable, so focus never
 * drops out of a dialog.
 */
export function ProfileFields({
  value,
  onChange,
  nameError,
  disabled = false,
  nameRef,
  idPrefix,
}: {
  value: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  nameError?: string | null;
  disabled?: boolean;
  nameRef?: Ref<HTMLInputElement>;
  /** Makes radio group names unique when two forms are on screen. */
  idPrefix: string;
}) {
  return (
    <div className="profile-fields">
      <TextField
        label="Name"
        value={value.name}
        inputRef={nameRef}
        maxLength={LIMITS.profileName}
        autoComplete="off"
        hint="E.g. Work or Personal."
        readOnly={disabled}
        error={nameError}
        onChange={(event) => {
          if (!disabled) onChange({ ...value, name: event.target.value });
        }}
      />
      <fieldset className="segmented field" aria-disabled={disabled || undefined}>
        <legend className="field-label">Kind</legend>
        <div className="segmented-options">
          {PROFILE_KINDS.map((option) => (
            <label
              key={option.id}
              className={cx("segmented-option", value.kind === option.id && "is-selected")}
            >
              <input
                type="radio"
                name={`${idPrefix}-kind`}
                value={option.id}
                checked={value.kind === option.id}
                onChange={() => {
                  if (!disabled) onChange({ ...value, kind: option.id });
                }}
              />
              {value.kind === option.id && <Check width={14} height={14} aria-hidden="true" />}
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="accent-picker field" aria-disabled={disabled || undefined}>
        <legend className="field-label">Color</legend>
        <div className="accent-options">
          {ACCENTS.map((option) => {
            const selected = value.accent === option.id;
            return (
              <label
                key={option.id}
                className={cx("accent-option", selected && "is-selected")}
                title={option.label}
              >
                <input
                  type="radio"
                  name={`${idPrefix}-accent`}
                  value={option.id}
                  checked={selected}
                  onChange={() => {
                    if (!disabled) onChange({ ...value, accent: option.id });
                  }}
                />
                <span className="accent-swatch" data-accent={option.id} aria-hidden="true">
                  {selected && <Check width={14} height={14} />}
                </span>
                <span className="accent-name">{option.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
