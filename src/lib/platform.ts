import type { KeyboardEvent as ReactKeyboardEvent } from "react";

/** True on Apple platforms, where shortcuts use Cmd instead of Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/i.test(navigator.userAgent);
}

/** Human-readable label for a Mod+key shortcut, e.g. "⌘K" or "Ctrl+K". */
export function shortcutLabel(key: string, options: { shift?: boolean } = {}): string {
  if (isApplePlatform()) return `${options.shift ? "⇧" : ""}⌘${key.toUpperCase()}`;
  return `Ctrl+${options.shift ? "Shift+" : ""}${key.toUpperCase()}`;
}

/** True when the event carries the platform's primary modifier (Cmd or Ctrl) only. */
export function hasModifier(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
  return mod && !event.altKey;
}
