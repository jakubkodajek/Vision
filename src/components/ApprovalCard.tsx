import { Check, ShieldAlert, ShieldCheck, ShieldX, Clock } from "lucide-react";
import { useState } from "react";
import { cx } from "../lib/cx";
import type { ApprovalDecision, ApprovalEvent } from "../types";
import { Button } from "./primitives";

export interface ApprovalCardProps {
  approval: ApprovalEvent;
  /** Sends the decision to the core; a rejection shows an error and re-enables the buttons. */
  onDecide: (decision: ApprovalDecision) => Promise<void>;
  /** Disables both actions, e.g. while the core is unreachable. */
  disabled?: boolean;
}

/** Inline permission request with Allow / Deny, like a tool-use prompt in a terminal agent. */
export function ApprovalCard({ approval, onDecide, disabled = false }: ApprovalCardProps) {
  const [submitting, setSubmitting] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status, title, detail, tool } = approval;

  const decide = (decision: ApprovalDecision) => {
    if (submitting) return;
    setSubmitting(decision);
    setError(null);
    onDecide(decision)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "The decision could not be sent.");
      })
      .finally(() => {
        setSubmitting(null);
      });
  };

  const resolved = status !== "pending";
  return (
    <section className={cx("approval-card", `approval-${status}`)} aria-label={`Approval request: ${title}`}>
      <header className="approval-header">
        <span className="approval-icon" aria-hidden="true">
          {status === "allowed" ? (
            <ShieldCheck width={18} height={18} />
          ) : status === "denied" ? (
            <ShieldX width={18} height={18} />
          ) : status === "expired" ? (
            <Clock width={18} height={18} />
          ) : (
            <ShieldAlert width={18} height={18} />
          )}
        </span>
        <div className="approval-heading">
          <p className="approval-title">{title}</p>
          <p className="approval-tool">{tool} wants permission</p>
        </div>
      </header>
      <pre className="approval-detail">
        <code>{detail}</code>
      </pre>
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
      {resolved ? (
        <p className="approval-outcome" role="status">
          {status === "allowed" && (
            <>
              <Check width={14} height={14} aria-hidden="true" /> Allowed once
            </>
          )}
          {status === "denied" && "Denied. The agent was told not to run it."}
          {status === "expired" && "This request expired because the run ended."}
        </p>
      ) : (
        <div className="approval-actions">
          <Button
            variant="secondary"
            onClick={() => {
              decide("deny");
            }}
            loading={submitting === "deny"}
            disabled={disabled || submitting === "allow"}
          >
            Deny
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              decide("allow");
            }}
            loading={submitting === "allow"}
            disabled={disabled || submitting === "deny"}
          >
            Allow once
          </Button>
        </div>
      )}
    </section>
  );
}
