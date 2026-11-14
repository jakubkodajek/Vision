import { CircleAlert } from "lucide-react";
import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx";

/** Field-level error text, linked to its control with aria-describedby. */
export function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="field-error">
      <CircleAlert width={14} height={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

interface FieldChrome {
  label: string;
  /** Help text under the control. */
  hint?: ReactNode;
  error?: string | null;
  /** Shows "Optional" next to the label. */
  optional?: boolean;
  className?: string;
}

function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const list = ids.filter(Boolean).join(" ");
  return list.length > 0 ? list : undefined;
}

function Label({ htmlFor, label, optional }: { htmlFor: string; label: string; optional?: boolean }) {
  return (
    <label htmlFor={htmlFor} className="field-label">
      {label}
      {optional && (
        <>
          <span className="field-optional" aria-hidden="true">
            Optional
          </span>
          <span className="visually-hidden"> (optional)</span>
        </>
      )}
    </label>
  );
}

export type TextFieldProps = FieldChrome &
  Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
    inputRef?: Ref<HTMLInputElement>;
  };

/** Labelled text input with hint and error. */
export function TextField({ label, hint, error, optional, className, inputRef, ...input }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cx("field", className)}>
      <Label htmlFor={id} label={label} optional={optional} />
      <input
        {...input}
        ref={inputRef}
        id={id}
        className={cx(
          "input",
          input.type === undefined || input.type === "text" ? null : `input-${input.type}`,
        )}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && errorId, hint !== undefined && hintId)}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export type TextAreaFieldProps = FieldChrome & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;

/** Labelled multi-line input with hint and error. */
export function TextAreaField({ label, hint, error, optional, className, ...textarea }: TextAreaFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cx("field", className)}>
      <Label htmlFor={id} label={label} optional={optional} />
      <textarea
        {...textarea}
        id={id}
        className="input textarea"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && errorId, hint !== undefined && hintId)}
      />
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

export type SelectFieldProps = FieldChrome &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & {
    children: ReactNode;
  };

/** Labelled native select. */
export function SelectField({
  label,
  hint,
  error,
  optional,
  className,
  children,
  ...select
}: SelectFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cx("field", className)}>
      <Label htmlFor={id} label={label} optional={optional} />
      <select
        {...select}
        id={id}
        className="input select"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(error && errorId, hint !== undefined && hintId)}
      >
        {children}
      </select>
      {error && <FieldError id={errorId}>{error}</FieldError>}
      {hint !== undefined && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Checkbox with its label to the right. */
export function CheckboxField({
  label,
  hint,
  className,
  ...input
}: { label: ReactNode; hint?: ReactNode; className?: string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "className"
>) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cx("checkbox-field", className)}>
      <input {...input} id={id} type="checkbox" aria-describedby={hint ? hintId : undefined} />
      <span className="checkbox-text">
        <label htmlFor={id}>{label}</label>
        {hint && (
          <span id={hintId} className="field-hint">
            {hint}
          </span>
        )}
      </span>
    </div>
  );
}
