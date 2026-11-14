import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cx } from "../lib/cx";
import { DialogCloseContext, dialogStack as stack, useDialogClose } from "./dialogStack";
import { Button, IconButton } from "./primitives";

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Elements Tab can reach inside `root`: not disabled (also via a disabled fieldset), not hidden. */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.matches(":disabled") && !el.closest("[hidden]") && el.tabIndex >= 0,
  );
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
  /** The form has unsaved changes: Escape, Close and Cancel ask "Discard changes?" first. */
  dirty?: boolean;
}

/**
 * Gives focus back to the opener if it is still there; otherwise, unless something else
 * already has focus (a parent dialog restored its own opener), to the view heading.
 */
function restoreFocus(opener: HTMLElement | null): void {
  if (opener && opener !== document.body && opener.isConnected && !opener.matches(":disabled")) {
    opener.focus();
    return;
  }
  const active = document.activeElement;
  if (active === null || active === document.body || !active.isConnected)
    document.querySelector<HTMLElement>("[data-focus-fallback]")?.focus();
}

/**
 * Modal dialog (WAI-ARIA APG dialog pattern): labelled by its heading, focus moves in on
 * open, Tab and Shift+Tab stay inside, Escape closes, and focus returns to the element that
 * was focused before it opened (or the view heading when that element is gone). Keys are
 * handled on the document, and focus that drops out of the dialog (a focused control was
 * replaced or disabled after an async step) is pulled back in, so the dialog never loses
 * the keyboard.
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
  dirty = false,
}: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [asking, setAsking] = useState(false);
  const latest = useRef({ onClose, dismissible, dirty, asking });
  useEffect(() => {
    latest.current = { onClose, dismissible, dirty, asking };
  });

  /** Closes, or asks first when there are unsaved changes. */
  const requestClose = useCallback(() => {
    const { onClose: close, dismissible: canClose, dirty: hasChanges } = latest.current;
    if (!canClose) return;
    if (hasChanges) setAsking(true);
    else close();
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(dialog);
    const target =
      initialFocus?.current ?? (bodyRef.current ? focusables(bodyRef.current)[0] : undefined) ?? dialog;
    target.focus();

    const isTop = () => stack[stack.length - 1] === dialog;
    const onKey = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(dialog);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active) && active !== dialog;
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!isTop()) return;
      if (event.target instanceof Node && !dialog.contains(event.target)) dialog.focus();
    };
    // A focused control that is removed or disabled drops focus to <body> without an event.
    const observer = new MutationObserver(() => {
      if (!isTop()) return;
      const active = document.activeElement;
      if (active === null || active === document.body) dialog.focus();
    });
    observer.observe(dialog, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["disabled"],
    });
    // Browsers also blur a control that became disabled a moment later ("focus fixup").
    let pending: ReturnType<typeof setTimeout> | undefined;
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget !== null) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        const active = document.activeElement;
        if (isTop() && dialog.isConnected && (active === null || active === document.body)) dialog.focus();
      }, 0);
    };
    dialog.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      observer.disconnect();
      clearTimeout(pending);
      dialog.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
      const index = stack.lastIndexOf(dialog);
      if (index >= 0) stack.splice(index, 1);
      restoreFocus(opener);
    };
    // Focus once on open; later renders must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          <IconButton
            label="Close"
            size="sm"
            onClick={requestClose}
            aria-disabled={dismissible ? undefined : true}
            className={dismissible ? undefined : "is-inactive"}
          >
            <X width={16} height={16} aria-hidden="true" />
          </IconButton>
        </header>
        <div ref={bodyRef} className="dialog-body">
          <DialogCloseContext.Provider value={requestClose}>{children}</DialogCloseContext.Provider>
        </div>
      </div>
      {asking && (
        <DiscardDialog
          onKeep={() => {
            setAsking(false);
          }}
          onDiscard={() => {
            setAsking(false);
            latest.current.onClose();
          }}
        />
      )}
    </div>
  );
}

/** "Discard changes?" on top of a dirty form dialog; Keep editing has focus first. */
function DiscardDialog({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title="Discard changes?"
      description="What you entered in this form is not saved."
      role="alertdialog"
      size="sm"
      onClose={onKeep}
      initialFocus={keepRef}
    >
      <div className="dialog-footer">
        <Button ref={keepRef} onClick={onKeep}>
          Keep editing
        </Button>
        <Button variant="danger" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </Dialog>
  );
}

/**
 * Cancel button of a dialog form: asks the dialog to close, which confirms first when the
 * form has unsaved changes. `inactive` while a request runs (stays focusable).
 */
export function DialogCancel({
  inactive = false,
  children = "Cancel",
}: {
  inactive?: boolean;
  children?: ReactNode;
}) {
  const close = useDialogClose();
  return (
    <Button inactive={inactive} onClick={close}>
      {children}
    </Button>
  );
}
