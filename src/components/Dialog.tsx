import { X } from "lucide-react";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { cx } from "../lib/cx";
import { IconButton } from "./primitives";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest("[hidden]"));
}

export interface DialogProps {
  /** Heading; also the dialog's accessible name. */
  title: string;
  /** Short text under the heading; becomes the accessible description. */
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** `alertdialog` for confirmations of destructive actions. */
  role?: "dialog" | "alertdialog";
  size?: "sm" | "md" | "lg";
  /** False while a request runs, so Escape and the close button cannot drop it. */
  dismissible?: boolean;
  /** Element focused on open; defaults to the first focusable element in the body. */
  initialFocus?: RefObject<HTMLElement | null>;
}

/**
 * Modal dialog (WAI-ARIA APG dialog pattern): labelled by its heading, focus moves in on
 * open, Tab and Shift+Tab stay inside, Escape closes, and focus returns to the element that
 * was focused before it opened.
 */
export function Dialog({
  title,
  description,
  onClose,
  children,
  role = "dialog",
  size = "md",
  dismissible = true,
  initialFocus,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target =
      initialFocus?.current ?? (bodyRef.current ? focusables(bodyRef.current)[0] : undefined) ?? ref.current;
    target?.focus();
    return () => {
      // When the opener is gone (e.g. its row was deleted), focus the view's heading instead.
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>("[data-focus-fallback]")?.focus();
    };
    // Focus once on open; later renders must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (dismissible) onCloseRef.current();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const items = focusables(ref.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !ref.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !ref.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cx("dialog", `dialog-${size}`)}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          <div className="dialog-heading">
            <h2 id={titleId} className="dialog-title">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="dialog-description">
                {description}
              </p>
            )}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose} disabled={!dismissible}>
            <X width={16} height={16} aria-hidden="true" />
          </IconButton>
        </header>
        <div ref={bodyRef} className="dialog-body">
          {children}
        </div>
      </div>
    </div>
  );
}
