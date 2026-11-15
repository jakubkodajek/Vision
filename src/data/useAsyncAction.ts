import { useCallback, useEffect, useRef, useState } from "react";
import type { VisionIpcError } from "../ipc/client";
import { asIpcError } from "./errors";

/** Result of one run of an async action. */
export type ActionResult<R> = { ok: true; value: R } | { ok: false };

/** State and trigger of an async action. */
export interface AsyncAction<A extends unknown[], R> {
  busy: boolean;
  error: VisionIpcError | null;
  /**
   * Runs the action. A second call while one is running does nothing; it and a run that
   * finishes after unmount return `ok: false`.
   */
  run: (...args: A) => Promise<ActionResult<R>>;
  /** Clears the error. */
  reset: () => void;
}

/**
 * Wraps an async call with a busy flag and an error, guards against double submission and
 * never sets state after the component unmounted.
 * @param fn - The call to run; may change between renders.
 */
export function useAsyncAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): AsyncAction<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<VisionIpcError | null>(null);
  const mounted = useRef(true);
  const running = useRef(false);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<ActionResult<R>> => {
    if (running.current) return { ok: false };
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await fnRef.current(...args);
      // After unmount nobody may act on the result in component state.
      if (!mounted.current) return { ok: false };
      setBusy(false);
      return { ok: true, value };
    } catch (e: unknown) {
      if (mounted.current) {
        setBusy(false);
        setError(asIpcError(e));
      }
      return { ok: false };
    } finally {
      running.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
  }, []);

  return { busy, error, run, reset };
}
