import { Check } from "lucide-react";
import type { Ref } from "react";
import { TextField } from "../components/forms";
import type { Accent, ProfileKind } from "../ipc/bindings";
import { cx } from "../lib/cx";
import { ACCENTS, PROFILE_KINDS } from "../lib/realLabels";

/** Values of the profile form. */
export interface ProfileDraft {
  name: string;
  kind: ProfileKind;
  accent: Accent;
}

/** Name, kind and accent inputs shared by Welcome, New profile and Edit profile. */
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
        maxLength={60}
        autoComplete="off"
        placeholder="For example Work or Personal"
        disabled={disabled}
        error={nameError}
        onChange={(event) => {
          onChange({ ...value, name: event.target.value });
        }}
      />
      <fieldset className="segmented field" disabled={disabled}>
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
                  onChange({ ...value, kind: option.id });
                }}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="accent-picker field" disabled={disabled}>
        <legend className="field-label">Colour</legend>
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
                    onChange({ ...value, accent: option.id });
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
