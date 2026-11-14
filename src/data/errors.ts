/**
 * Turns core errors into plain, specific copy. The core's `message` is always shown (it is
 * user-safe by contract); some codes get an extra hint on what to do next.
 */
import { toIpcError, type VisionIpcError } from "../ipc/client";
import type { ErrorCode, Platform } from "../ipc/bindings";

export type { VisionIpcError };

/** Normalises anything thrown by a client call. */
export function asIpcError(value: unknown): VisionIpcError {
  return toIpcError(value);
}

function terminalHint(platform: Platform | null): string {
  switch (platform) {
    case "macos":
      return "Vision opens sign-ins in the Terminal app. Check that Terminal is installed and that Vision may control it, then try again.";
    case "windows":
      return "Vision opens sign-ins in a Command Prompt window. Check that cmd.exe is available, then try again.";
    default:
      return "Vision could not find a terminal app. Install one of x-terminal-emulator, GNOME Terminal, Konsole or xterm, then try again.";
  }
}

const HINTS: Partial<Record<ErrorCode, (platform: Platform | null) => string>> = {
  not_installed: () =>
    "The program was not found on this computer. Install it from its official page, then select Check again.",
  terminal_unavailable: terminalHint,
  secret_store_unavailable: () =>
    "Nothing was saved. Vision keeps secret values only in the system credential store (Keychain, Credential Manager or Secret Service) and none was available. Unlock or set up the credential store, or untick Secret for values that are not sensitive.",
  schema_too_new: () => "Install the latest version of Vision to open it. Your data has not been changed.",
  timeout: () => "The command took too long to answer. Try again in a moment.",
};

/** A hint for the error code, or `null` when the core's message says enough. */
export function errorHint(error: VisionIpcError, platform: Platform | null = null): string | null {
  const hint = HINTS[error.code];
  return hint ? hint(platform) : null;
}

/** Core message plus hint, joined for places with room for one paragraph. */
export function errorText(error: VisionIpcError, platform: Platform | null = null): string {
  const hint = errorHint(error, platform);
  if (!hint) return error.message;
  const sentence = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  return `${sentence} ${hint}`;
}
