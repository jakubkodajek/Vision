import { CircleAlert } from "lucide-react";
import {
  createContext,
  useContext,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "../lib/cx";

/**
 * True while the form's request runs. Fields then ignore input (read-only text, inert
 * selects and checkboxes) but stay focusable, so focus is never thrown out of a dialog the
 * way a disabled fieldset would throw it.
 */
const FormBusyContext = createContext(false);

/** Makes every field below it read-only while `busy`. */
export function FormBusy({ busy, children }: { busy: boolean; children: ReactNode }) {
  return <FormBusyContext.Provider value={busy}>{children}</FormBusyContext.Provider>;
}

/** Polite summary after a failed submit: "3 fields need attention." */
export function ErrorSummary({ count, attempt }: { count: number; attempt: number }) {
  return (
    <p className="visually-hidden" role="status">
      {attempt > 0 && count > 0 && (
        <span key={attempt}>
          {count === 1 ? "1 field needs attention." : `${String(count)} fields need attention.`}
        </span>
      )}
    </p>
  );
}

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
  /** Visible label; may hold markup such as a `<strong>` name. */
  label: ReactNode;
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

function Label({ htmlFor, label, optional }: { htmlFor: string; label: ReactNode; optional?: boolean }) {
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
  const busy = useContext(FormBusyContext);
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
        readOnly={busy || input.readOnly}
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
  const busy = useContext(FormBusyContext);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cx("field", className)}>
      <Label htmlFor={id} label={label} optional={optional} />
      <textarea
        {...textarea}
        id={id}
        readOnly={busy || textarea.readOnly}
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
  const busy = useContext(FormBusyContext);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={cx("field", className)}>
      <Label htmlFor={id} label={label} optional={optional} />
      <select
        {...select}
        id={id}
        aria-disabled={busy || undefined}
        onChange={busy ? () => undefined : select.onChange}
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
  const busy = useContext(FormBusyContext);
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className={cx("checkbox-field", className)}>
      <input
        {...input}
        id={id}
        type="checkbox"
        aria-disabled={busy || undefined}
        onClick={(event) => {
          if (busy) event.preventDefault();
          else input.onClick?.(event);
        }}
        aria-describedby={hint ? hintId : undefined}
      />
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
