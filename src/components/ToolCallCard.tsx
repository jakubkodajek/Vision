import {
  Check,
  ChevronRight,
  CircleDashed,
  FilePen,
  FileSearch,
  FileText,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { formatDuration, toolStatusLabel } from "../lib/labels";
import type { ToolCallEvent } from "../types";
import { Spinner } from "./primitives";

function toolIcon(tool: string): ReactNode {
  const props = { width: 15, height: 15, "aria-hidden": true } as const;
  switch (tool) {
    case "Bash":
      return <SquareTerminal {...props} />;
    case "Read":
      return <FileText {...props} />;
    case "Edit":
    case "Write":
      return <FilePen {...props} />;
    case "Grep":
    case "Glob":
      return <FileSearch {...props} />;
    default:
      return <Wrench {...props} />;
  }
}

function StatusIcon({ status }: { status: ToolCallEvent["status"] }) {
  switch (status) {
    case "running":
      return <Spinner size={14} />;
    case "success":
      return <Check width={14} height={14} aria-hidden="true" />;
    case "error":
      return <X width={14} height={14} aria-hidden="true" />;
    case "pending":
      return <CircleDashed width={14} height={14} aria-hidden="true" />;
  }
}

export interface ToolCallCardProps {
  call: ToolCallEvent;
  defaultExpanded?: boolean;
}

/** Collapsed card for one tool call; expands to show input and output. */
export function ToolCallCard({ call, defaultExpanded = false }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();
  const { tool, summary, input, output, status, durationMs } = call;
  return (
    <section
      className={cx("tool-card", `tool-${status}`, expanded && "is-expanded")}
      aria-label={`${tool} tool call`}
    >
      <button
        type="button"
        className="tool-card-header"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => {
          setExpanded((v) => !v);
        }}
      >
        <ChevronRight className="tool-card-chevron" width={14} height={14} aria-hidden="true" />
        <span className="tool-card-icon">{toolIcon(tool)}</span>
        <span className="tool-card-name">{tool}</span>
        <span className="tool-card-summary">{summary}</span>
        <span className={cx("tool-card-status", `is-${status}`)}>
          <StatusIcon status={status} />
          <span className="visually-hidden">{toolStatusLabel(status)}</span>
          {durationMs !== undefined && (
            <span className="tool-card-duration">{formatDuration(durationMs)}</span>
          )}
        </span>
      </button>
      <div id={bodyId} className="tool-card-body" hidden={!expanded}>
        <p className="tool-card-label">Input</p>
        <pre className="tool-card-pre">
          <code>{input}</code>
        </pre>
        <p className="tool-card-label">Output</p>
        {output !== undefined ? (
          <pre className={cx("tool-card-pre", status === "error" && "is-error")}>
            <code>{output}</code>
          </pre>
        ) : (
          <p className="tool-card-waiting">
            {status === "running" ? "Waiting for output…" : "No output yet."}
          </p>
        )}
      </div>
    </section>
  );
}
