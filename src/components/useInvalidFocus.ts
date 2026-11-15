import { useEffect } from "react";

/**
 * After each failed submit (`attempt` grows), focuses the first invalid field of the form,
 * or its form-level error when no field is invalid. Runs after the render that shows the
 * errors, so it never focuses a stale field.
 */
export function useInvalidFocus(form: { current: HTMLElement | null }, attempt: number): void {
  useEffect(() => {
    if (attempt === 0) return;
    const root = form.current;
    const target =
      root?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      root?.querySelector<HTMLElement>("[data-form-error]");
    target?.focus();
  }, [form, attempt]);
}
