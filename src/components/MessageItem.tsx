import { CircleAlert } from "lucide-react";
import { splitFences } from "../lib/text";
import { cx } from "../lib/cx";
import type { MessageEvent } from "../types";
import { Skeleton } from "./primitives";

export interface MessageItemProps {
  message: MessageEvent;
}

/** One conversation message: the user's prompt, agent text or a system notice. */
export function MessageItem({ message }: MessageItemProps) {
  const { role, author, text, status, time } = message;
  const streaming = status === "streaming";
  const segments = splitFences(text);
  return (
    <article
      className={cx("message", `message-${role}`, status === "error" && "is-error")}
      aria-label={`${author}, ${time}`}
      aria-busy={streaming || undefined}
    >
      {role !== "user" && (
        <header className="message-meta">
          <span className="message-author">{author}</span>
          <time className="message-time">{time}</time>
        </header>
      )}
      <div className="message-body">
        {segments.length === 0 && streaming && (
          <div className="message-placeholder">
            <span className="visually-hidden">Agent is writing</span>
            <Skeleton width="wide" />
            <Skeleton width="medium" />
          </div>
        )}
        {segments.map((segment, i) =>
          segment.kind === "code" ? (
            <pre key={i} className="message-code">
              <code>{segment.text}</code>
            </pre>
          ) : (
            <p key={i} className="message-text">
              {segment.text}
            </p>
          ),
        )}
        {streaming && segments.length > 0 && <span className="stream-caret" aria-hidden="true" />}
        {status === "error" && (
          <p className="message-error">
            <CircleAlert width={14} height={14} aria-hidden="true" />
            <span>The agent stopped with an error.</span>
          </p>
        )}
      </div>
    </article>
  );
}
