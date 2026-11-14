import { createContext, useContext } from "react";

/** Open dialogs, newest last; only the newest handles keys and keeps focus. */
export const dialogStack: HTMLElement[] = [];

/** Whether a modal dialog is open (global shortcuts are ignored while one is). */
export function isModalOpen(): boolean {
  return dialogStack.length > 0;
}

/** Asks the surrounding dialog to close; it confirms first when the form has unsaved changes. */
export const DialogCloseContext = createContext<(() => void) | null>(null);

/** Close request of the surrounding dialog, for a form's Cancel button. */
export function useDialogClose(): () => void {
  const close = useContext(DialogCloseContext);
  if (!close) throw new Error("useDialogClose must be used inside a Dialog");
  return close;
}
