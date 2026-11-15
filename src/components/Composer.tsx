import { ArrowUp, Bot, ChevronDown, Cpu, FolderGit2 } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type SyntheticEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "../lib/cx";
import { IconButton, Spinner } from "./primitives";

export interface PickerOption {
  id: string;
  label: string;
}

export interface ComposerSubmission {
  text: string;
  agent: string;
  model: string;
  projectId: string;
}

export interface ComposerProps {
  onSubmit: (submission: ComposerSubmission) => Promise<void>;
  agents: PickerOption[];
  models: PickerOption[];
  projects: PickerOption[];
  /** Initial picker values; defaults to the first option of each list. */
  defaults?: Partial<Omit<ComposerSubmission, "text">>;
  placeholder?: string;
  /** Large centred variant on the home screen, docked variant under a run. */
  variant?: "hero" | "docked";
  disabled?: boolean;
  /** Shown under the composer when disabled, e.g. why sending is not possible. */
  disabledReason?: string;
  /** Hide the project picker when the project is fixed (inside a run). */
  showProjectPicker?: boolean;
  autoFocus?: boolean;
  /** Changing this value moves focus to the input without clearing the draft. */
  focusSignal?: number;
}

const MAX_HEIGHT_PX = 240;

function Picker({
  icon,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <div className={cx("picker", disabled && "is-disabled")}>
      <label htmlFor={id} className="visually-hidden">
        {label}
      </label>
      <span className="picker-icon" aria-hidden="true">
        {icon}
      </span>
      <select
        id={id}
        className="picker-select"
        value={value}
        disabled={disabled || options.length === 0}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {options.length === 0 && <option value="">None available</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="picker-chevron" width={14} height={14} aria-hidden="true" />
    </div>
  );
}

/** Prompt input with agent, model and project pickers. Enter sends, Shift+Enter adds a line. */
export function Composer({
  onSubmit,
  agents,
  models,
  projects,
  defaults,
  placeholder = "Describe a task for an agent…",
  variant = "docked",
  disabled = false,
  disabledReason,
  showProjectPicker = true,
  autoFocus = false,
  focusSignal = 0,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [agent, setAgent] = useState(defaults?.agent ?? agents[0]?.id ?? "");
  const [model, setModel] = useState(defaults?.model ?? models[0]?.id ?? "");
  const [projectId, setProjectId] = useState(defaults?.projectId ?? projects[0]?.id ?? "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  // Keep the selected project valid when the project list changes (profile switch).
  const effectiveProject = projects.some((p) => p.id === projectId) ? projectId : (projects[0]?.id ?? "");

  useEffect(() => {
    if (focusSignal > 0) textareaRef.current?.focus();
  }, [focusSignal]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${String(Math.min(el.scrollHeight, MAX_HEIGHT_PX))}px`;
  }, [text]);

  const canSend =
    !disabled && !sending && text.trim().length > 0 && (!showProjectPicker || effectiveProject !== "");

  const submit = () => {
    if (!canSend) return;
    setSending(true);
    setError(null);
    onSubmit({ text: text.trim(), agent, model, projectId: effectiveProject })
      .then(() => {
        setText("");
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The task could not be started.");
      })
      .finally(() => {
        setSending(false);
        textareaRef.current?.focus();
      });
  };

  const onFormSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    submit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const describedBy = [disabled && disabledReason ? hintId : null, error ? `${hintId}-error` : null]
    .filter(Boolean)
    .join(" ");

  return (
    <form
      className={cx("composer", `composer-${variant}`, disabled && "is-disabled")}
      onSubmit={onFormSubmit}
    >
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          aria-label="Task description"
          aria-describedby={describedBy || undefined}
          placeholder={placeholder}
          value={text}
          rows={variant === "hero" ? 3 : 1}
          disabled={disabled}
          readOnly={sending}
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="composer-toolbar">
          <div className="composer-pickers">
            <Picker
              icon={<Bot width={14} height={14} />}
              label="Agent"
              value={agent}
              options={agents}
              onChange={setAgent}
              disabled={disabled || sending}
            />
            <Picker
              icon={<Cpu width={14} height={14} />}
              label="Model"
              value={model}
              options={models}
              onChange={setModel}
              disabled={disabled || sending}
            />
            {showProjectPicker && (
              <Picker
                icon={<FolderGit2 width={14} height={14} />}
                label="Project"
                value={effectiveProject}
                options={projects}
                onChange={setProjectId}
                disabled={disabled || sending}
              />
            )}
          </div>
          <IconButton
            type="submit"
            label={sending ? "Sending" : "Send"}
            shortcut="Enter"
            className="composer-send"
            disabled={!canSend}
            aria-busy={sending || undefined}
          >
            {sending ? <Spinner size={16} /> : <ArrowUp width={18} height={18} aria-hidden="true" />}
          </IconButton>
        </div>
      </div>
      {disabled && disabledReason ? (
        <p id={hintId} className="composer-hint">
          {disabledReason}
        </p>
      ) : (
        // Reserve the hint row under a docked composer so it does not jump when the hint goes.
        variant === "docked" &&
        !error && (
          <p className="composer-hint" aria-hidden="true">
            {"\u00a0"}
          </p>
        )
      )}
      {error && (
        <p id={`${hintId}-error`} className="composer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
