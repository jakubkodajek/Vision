/*
 * Per-device UI preferences (sidebar, panel width, theme). Storage can be
 * unavailable or throw (private mode, blocked site data), so every access is
 * guarded and falls back to the default. Never store anything sensitive here.
 */

const PREFIX = "vision.ui.";

/** Reads a preference, returning `fallback` when missing, invalid or unreadable. */
export function readPreference<T>(key: string, fallback: T, isValid: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return isValid(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** Writes a preference; failures are ignored because preferences are conveniences. */
export function writePreference(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable: keep the in-memory value only.
  }
}

export const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
