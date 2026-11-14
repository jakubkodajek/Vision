import { X } from "lucide-react";
import { useId, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { IconButton } from "./primitives";

export interface PanelTab {
  id: string;
  label: string;
  /** Optional count badge, e.g. changed files. */
  count?: number;
}

export interface PanelProps {
  title: string;
  tabs: PanelTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  onClose: () => void;
  width: number;
  minWidth: number;
  maxWidth: number;
  onResize: (width: number) => void;
  closeShortcut?: string;
  children: ReactNode;
}

const KEY_STEP_PX = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Right-hand side panel with tabs, a close button and a resize handle on its
 * left edge. The handle is a focusable separator (WAI-ARIA window splitter
 * pattern, https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/):
 * Left grows and Right shrinks by 16 px; Home and End jump to the minimum and maximum
 * width, matching aria-valuemin and aria-valuemax.
 */
export function Panel({
  title,
  tabs,
  activeTab,
  onTabChange,
  onClose,
  width,
  minWidth,
  maxWidth,
  onResize,
  closeShortcut,
  children,
}: PanelProps) {
  const baseId = useId();
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { startX: event.clientX, startWidth: width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // The handle sits on the left edge: dragging left makes the panel wider.
    const delta = drag.current.startX - event.clientX;
    onResize(clamp(drag.current.startWidth + delta, minWidth, maxWidth));
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onSeparatorKey = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + KEY_STEP_PX;
    else if (event.key === "ArrowRight") next = width - KEY_STEP_PX;
    else if (event.key === "Home") next = minWidth;
    else if (event.key === "End") next = maxWidth;
    if (next !== null) {
      event.preventDefault();
      onResize(clamp(next, minWidth, maxWidth));
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === activeTab);
    let next: PanelTab | undefined;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    else if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    else if (event.key === "Home") next = tabs[0];
    else if (event.key === "End") next = tabs[tabs.length - 1];
    if (next) {
      event.preventDefault();
      onTabChange(next.id);
      tabRefs.current.get(next.id)?.focus();
    }
  };

  return (
    <aside
      className="panel"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="panel-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side panel"
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onSeparatorKey}
      />
      <header className="panel-header">
        <div className="panel-tabs" role="tablist" aria-label={title} onKeyDown={onTabKey}>
          {tabs.map((tab) => {
            const selected = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                className={cx("panel-tab", selected && "is-selected")}
                onClick={() => {
                  onTabChange(tab.id);
                }}
              >
                {tab.label}
                {tab.count !== undefined && <span className="panel-tab-count">{tab.count}</span>}
              </button>
            );
          })}
        </div>
        <IconButton label="Close panel" shortcut={closeShortcut} size="sm" onClick={onClose}>
          <X width={16} height={16} aria-hidden="true" />
        </IconButton>
      </header>
      <div
        className="panel-body"
        role="tabpanel"
        id={`${baseId}-panel`}
        aria-labelledby={`${baseId}-tab-${activeTab}`}
        tabIndex={0}
      >
        {children}
      </div>
    </aside>
  );
}
