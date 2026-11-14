import { GitBranch, PanelRightClose, PanelRightOpen } from "lucide-react";
import { useEffect, useRef } from "react";
import { ApprovalCard } from "../components/ApprovalCard";
import { Composer, type ComposerSubmission, type PickerOption } from "../components/Composer";
import { MessageItem } from "../components/MessageItem";
import { IconButton, RunStatusBadge } from "../components/primitives";
import { ToolCallCard } from "../components/ToolCallCard";
import { shortcutLabel } from "../lib/platform";
import type { ApprovalDecision, Run } from "../types";

export interface RunViewProps {
  run: Run;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onDecide: (eventId: string, decision: ApprovalDecision) => Promise<void>;
  /** Approvals whose decision is still being sent; shown disabled. */
  decidingIds?: ReadonlySet<string>;
  onSend: (submission: ComposerSubmission) => Promise<void>;
  agents: PickerOption[];
  models: PickerOption[];
}

const NEAR_BOTTOM_PX = 120;

/** A run rendered as a conversation: messages, tool-call cards and approvals. */
export function RunView({
  run,
  panelOpen,
  onTogglePanel,
  onDecide,
  decidingIds,
  onSend,
  agents,
  models,
}: RunViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const lastEvent = run.events[run.events.length - 1];
  const lastText = lastEvent?.kind === "message" ? lastEvent.text.length : 0;

  // Follow new output only while the reader is at the bottom, so reading back is not interrupted.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [run.events.length, lastText]);

  useEffect(() => {
    stickToBottom.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.id]);

  const pendingApproval = run.events.some((e) => e.kind === "approval" && e.status === "pending");
  const streaming = run.events.some((e) => e.kind === "message" && e.status === "streaming");

  return (
    <div className="run-view">
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title" title={run.title}>
            {run.title}
          </h2>
          <div className="run-meta">
            <RunStatusBadge status={run.status} />
            <span className="run-meta-item">{run.agent}</span>
            <span className="run-meta-sep" aria-hidden="true">
              ·
            </span>
            <span className="run-meta-item">{run.model}</span>
            <span className="run-meta-sep" aria-hidden="true">
              ·
            </span>
            <span className="run-meta-item run-branch">
              <GitBranch width={13} height={13} aria-hidden="true" />
              {run.branch}
            </span>
          </div>
        </div>
        <div className="view-header-actions">
          <span className="preview-badge" title="Runs are not connected to the core yet">
            Preview data
          </span>
          <IconButton
            label={panelOpen ? "Hide side panel" : "Show side panel"}
            shortcut={shortcutLabel("j")}
            onClick={onTogglePanel}
            active={panelOpen}
            aria-pressed={panelOpen}
          >
            {panelOpen ? (
              <PanelRightClose width={18} height={18} aria-hidden="true" />
            ) : (
              <PanelRightOpen width={18} height={18} aria-hidden="true" />
            )}
          </IconButton>
        </div>
      </header>
      <div
        ref={scrollRef}
        className="run-scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
        }}
      >
        <div
          className="run-events"
          role="log"
          aria-label="Run events"
          aria-live="polite"
          aria-relevant="additions"
        >
          {run.events.map((event) => {
            switch (event.kind) {
              case "message":
                return <MessageItem key={event.id} message={event} />;
              case "tool_call":
                return <ToolCallCard key={event.id} call={event} />;
              case "approval":
                return (
                  <ApprovalCard
                    key={event.id}
                    approval={event}
                    onDecide={(decision) => onDecide(event.id, decision)}
                    disabled={decidingIds?.has(event.id) ?? false}
                  />
                );
            }
          })}
        </div>
      </div>
      <div className="run-composer">
        <Composer
          key={run.id}
          variant="docked"
          onSubmit={onSend}
          agents={agents}
          models={models}
          projects={[]}
          showProjectPicker={false}
          defaults={{ agent: run.agent, model: run.model }}
          placeholder={pendingApproval ? "Answer the approval above first…" : "Reply to the agent…"}
          disabled={pendingApproval || streaming}
          disabledReason={
            pendingApproval
              ? "The agent is waiting for your approval."
              : streaming
                ? "The agent is writing…"
                : undefined
          }
        />
      </div>
    </div>
  );
}
