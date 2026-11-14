import {
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  CircleX,
  Download,
  KeyRound,
} from "lucide-react";
import type { ReactNode } from "react";
import type { McpHealthStatus, ToolStatus } from "../ipc/bindings";
import { MCP_HEALTH_LABEL, toolStatusLabel } from "../lib/realLabels";
import { cx } from "../lib/cx";

type Tone = "success" | "neutral" | "warning" | "danger";

function Badge({ tone, icon, children }: { tone: Tone; icon: ReactNode; children: ReactNode }) {
  return (
    <span className={cx("badge", `badge-${tone}`)}>
      {icon}
      <span>{children}</span>
    </span>
  );
}

const ICON = { width: 14, height: 14, "aria-hidden": true } as const;

/** Tool status as icon plus text (never colour alone). */
export function ToolStatusBadge({ status }: { status: ToolStatus | null }) {
  const label = toolStatusLabel(status);
  switch (status?.status) {
    case undefined:
      return (
        <Badge tone="neutral" icon={<CircleDashed {...ICON} />}>
          {label}
        </Badge>
      );
    case "signed_in":
      return (
        <Badge tone={status.warning ? "warning" : "success"} icon={<CircleCheck {...ICON} />}>
          {label}
        </Badge>
      );
    case "signed_out":
      return (
        <Badge tone="neutral" icon={<CircleMinus {...ICON} />}>
          {label}
        </Badge>
      );
    case "not_installed":
      return (
        <Badge tone="neutral" icon={<Download {...ICON} />}>
          {label}
        </Badge>
      );
    case "unknown":
      return (
        <Badge tone="warning" icon={<CircleHelp {...ICON} />}>
          {label}
        </Badge>
      );
  }
}

/** MCP server health as icon plus text. */
export function McpHealthBadge({ status }: { status: McpHealthStatus }) {
  const label = MCP_HEALTH_LABEL[status];
  switch (status) {
    case "untested":
      return (
        <Badge tone="neutral" icon={<CircleDashed {...ICON} />}>
          {label}
        </Badge>
      );
    case "ok":
      return (
        <Badge tone="success" icon={<CircleCheck {...ICON} />}>
          {label}
        </Badge>
      );
    case "needs_auth":
      return (
        <Badge tone="warning" icon={<KeyRound {...ICON} />}>
          {label}
        </Badge>
      );
    case "error":
      return (
        <Badge tone="danger" icon={<CircleX {...ICON} />}>
          {label}
        </Badge>
      );
  }
}
