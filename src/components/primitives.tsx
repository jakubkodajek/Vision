import { LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx";
import type { RunStatus } from "../types";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Shows a spinner, sets aria-busy and blocks clicks. */
  loading?: boolean;
  icon?: ReactNode;
}

/** Text button with variants and a loading state. */
export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={cx("btn", `btn-${variant}`, `btn-${size}`, className)}
      disabled={disabled ?? false}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      onClick={loading ? undefined : rest.onClick}
    >
      {loading ? <Spinner size={14} /> : icon}
      <span>{children}</span>
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name; also shown as the tooltip. */
  label: string;
  /** Optional shortcut shown in the tooltip, e.g. "⌘B". */
  shortcut?: string;
  size?: "sm" | "md";
  active?: boolean;
}

/** Square icon-only button with an accessible name. */
export function IconButton({
  label,
  shortcut,
  size = "md",
  active = false,
  className,
  children,
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={cx("icon-btn", `icon-btn-${size}`, active && "is-active", className)}
    >
      {children}
    </button>
  );
}

/** Indeterminate progress indicator; decorative unless given a label. */
export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <LoaderCircle
      className="spinner"
      width={size}
      height={size}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}

/** Placeholder block shown while content loads. */
export function Skeleton({
  width = "full",
  className,
}: {
  width?: "full" | "wide" | "medium" | "short";
  className?: string;
}) {
  return <span className={cx("skeleton", `skeleton-${width}`, className)} aria-hidden="true" />;
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

/** Explains why an area is empty and what to do next. */
export function EmptyState({ icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div className={cx("empty-state", compact && "is-compact")}>
      {icon && (
        <div className="empty-state-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-description">{description}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}

/** Announced error with an optional retry action. */
export function ErrorState({ title, message, onRetry, compact = false }: ErrorStateProps) {
  return (
    <div className={cx("error-state", compact && "is-compact")} role="alert">
      <TriangleAlert
        className="error-state-icon"
        aria-hidden="true"
        width={compact ? 16 : 20}
        height={compact ? 16 : 20}
      />
      <div className="error-state-body">
        <p className="error-state-title">{title}</p>
        {message && <p className="error-state-message">{message}</p>}
        {onRetry && (
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw width={14} height={14} aria-hidden="true" />}
            onClick={onRetry}
          >
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

/** Keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: "Running",
  waiting: "Needs approval",
  done: "Done",
  failed: "Failed",
};

/** Coloured dot plus label for a run's status. */
export function RunStatusBadge({ status, compact = false }: { status: RunStatus; compact?: boolean }) {
  return (
    <span className={cx("status-badge", `status-${status}`, compact && "is-compact")}>
      <span className="status-dot" aria-hidden="true" />
      <span className={compact ? "visually-hidden" : undefined}>{RUN_STATUS_LABEL[status]}</span>
    </span>
  );
}

/** Vision logo mark: an aperture of two arcs around a pupil. Original artwork. */
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="logo-mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="9" className="logo-mark-bg" />
      <path d="M6 16c2.8-4.9 6.1-7.3 10-7.3s7.2 2.4 10 7.3" className="logo-mark-arc" />
      <path d="M6 16c2.8 4.9 6.1 7.3 10 7.3s7.2-2.4 10-7.3" className="logo-mark-arc" />
      <circle cx="16" cy="16" r="3.6" className="logo-mark-pupil" />
    </svg>
  );
}
