import type { ToolCallStatus } from "../types";

const TOOL_STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: "Queued",
  running: "Running",
  success: "Succeeded",
  error: "Failed",
};

/** Text label of a tool call status, for screen readers. */
export function toolStatusLabel(status: ToolCallStatus): string {
  return TOOL_STATUS_LABEL[status];
}

/** Formats a duration: "41 ms", "2.1 s", "3 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  const seconds = ms / 1000;
  if (seconds < 59.95) return `${seconds.toFixed(1)} s`;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${String(minutes)} min ${String(total - minutes * 60)} s`;
}
