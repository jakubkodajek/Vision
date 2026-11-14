import { ChevronRight, FileDiff } from "lucide-react";
import { useState } from "react";
import { EmptyState } from "../components/primitives";
import { cx } from "../lib/cx";
import type { DiffFile } from "../types";

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-context";
}

/** Changed files of a run as collapsible unified diffs. */
export function ChangesView({ files }: { files: DiffFile[] }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  if (files.length === 0) {
    return (
      <EmptyState
        icon={<FileDiff width={24} height={24} />}
        title="No changes yet"
        description="Files the agent edits in its worktree appear here."
      />
    );
  }
  return (
    <ul className="diff-list">
      {files.map((file) => {
        const open = !collapsed.has(file.path);
        return (
          <li key={file.path} className="diff-file">
            <button
              type="button"
              className="diff-file-header"
              aria-expanded={open}
              onClick={() => {
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(file.path)) next.delete(file.path);
                  else next.add(file.path);
                  return next;
                });
              }}
            >
              <ChevronRight
                className={cx("diff-chevron", open && "is-open")}
                width={14}
                height={14}
                aria-hidden="true"
              />
              <span className="diff-path">{file.path}</span>
              <span className="diff-stat">
                <span className="diff-stat-add">+{file.additions}</span>
                <span className="diff-stat-del">−{file.deletions}</span>
                <span className="visually-hidden">
                  {file.additions} additions, {file.deletions} deletions
                </span>
              </span>
            </button>
            {open && (
              <pre className="diff-body" aria-label={`Diff of ${file.path}`}>
                {file.lines.map((line, i) => (
                  <span key={i} className={cx("diff-line", lineClass(line))}>
                    {line}
                    {"\n"}
                  </span>
                ))}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
