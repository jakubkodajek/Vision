import { useRef, type SyntheticEvent, type ReactNode } from "react";
import { useAsyncAction } from "../data/useAsyncAction";
import { errorText } from "../data/errors";
import type { Platform } from "../ipc/bindings";
import { Dialog } from "./Dialog";
import { Button, ErrorState } from "./primitives";

export interface ConfirmDialogProps {
  title: string;
  /** What will happen; read by screen readers as the dialog description. */
  description: ReactNode;
  confirmLabel: string;
  /** Runs on confirm; the dialog closes when it resolves and shows the error when it rejects. */
  onConfirm: () => Promise<unknown>;
  onClose: () => void;
  /** Called after a successful confirm, before `onClose`. */
  onDone?: () => void;
  /** Extra content between description and buttons, e.g. a typed confirmation. */
  children?: ReactNode;
  confirmDisabled?: boolean;
  destructive?: boolean;
  platform?: Platform | null;
  errorTitle?: string;
}

/** Confirmation for an action that cannot be undone. Cancel has focus first. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  onDone,
  children,
  confirmDisabled = false,
  destructive = true,
  platform = null,
  errorTitle = "That did not work",
}: ConfirmDialogProps) {
  const action = useAsyncAction(onConfirm);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (confirmDisabled) return;
    const result = await action.run();
    if (result.ok) {
      onDone?.();
      onClose();
    }
  };
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      role="alertdialog"
      size="sm"
      dismissible={!action.busy}
      initialFocus={children ? undefined : cancelRef}
    >
      <form className="dialog-form" onSubmit={(e) => void submit(e)} noValidate>
        {(children ?? action.error) && (
          <div className="dialog-content">
            {children}
            {action.error && (
              <ErrorState compact title={errorTitle} message={errorText(action.error, platform)} />
            )}
          </div>
        )}
        <div className="dialog-footer">
          <Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={action.busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant={destructive ? "danger" : "primary"}
            loading={action.busy}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
