import { Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterCommands, type Command } from "../lib/commands";
import { cx } from "../lib/cx";
import { Kbd } from "./primitives";

export interface CommandPaletteProps {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}

/**
 * Modal command palette (Ctrl/Cmd+K). The input is a combobox controlling a
 * listbox (WAI-ARIA APG combobox pattern); focus stays in the input, Up/Down
 * move the active option, Enter runs it, Escape closes and focus returns to the
 * element that opened the palette.
 */
export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  if (!open) return null;
  return <PaletteDialog commands={commands} onClose={onClose} />;
}

function PaletteDialog({ commands, onClose }: Omit<CommandPaletteProps, "open">) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const enabled = results.filter((c) => !c.disabled);
  const active = enabled[Math.min(activeIndex, enabled.length - 1)];

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => {
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    const el = document.getElementById(`${baseId}-${active.id}`);
    // jsdom does not implement scrollIntoView.
    if (el && "scrollIntoView" in el) el.scrollIntoView({ block: "nearest" });
  }, [active, baseId]);

  const runCommand = (command: Command) => {
    if (command.disabled) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (enabled.length > 0) setActiveIndex((i) => (Math.min(i, enabled.length - 1) + 1) % enabled.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (enabled.length > 0)
          setActiveIndex((i) => (Math.min(i, enabled.length - 1) - 1 + enabled.length) % enabled.length);
        break;
      case "Enter":
        event.preventDefault();
        if (active) runCommand(active);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab":
        // Focus trap: the input is the only tab stop inside the dialog.
        event.preventDefault();
        break;
    }
  };

  const groups = results.reduce<Map<string, Command[]>>((acc, c) => {
    acc.set(c.group, [...(acc.get(c.group) ?? []), c]);
    return acc;
  }, new Map());

  const listboxId = `${baseId}-listbox`;
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="palette-search">
          <Search width={16} height={16} aria-hidden="true" />
          <input
            ref={inputRef}
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${baseId}-${active.id}` : undefined}
            aria-label="Search commands"
            placeholder="Search commands, runs and settings…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul ref={listRef} id={listboxId} role="listbox" aria-label="Commands" className="palette-list">
          {results.length === 0 && (
            <li role="presentation" className="palette-empty">
              No commands match “{query}”.
            </li>
          )}
          {[...groups.entries()].map(([group, items]) => (
            <li key={group} role="presentation" className="palette-group">
              <p className="palette-group-label" aria-hidden="true">
                {group}
              </p>
              <ul role="group" aria-label={group} className="palette-group-list">
                {items.map((command) => {
                  const isActive = command.id === active?.id;
                  return (
                    <li
                      key={command.id}
                      id={`${baseId}-${command.id}`}
                      role="option"
                      aria-selected={isActive}
                      aria-disabled={command.disabled || undefined}
                      className={cx(
                        "palette-option",
                        isActive && "is-active",
                        command.disabled && "is-disabled",
                      )}
                      onMouseMove={() => {
                        const index = enabled.indexOf(command);
                        if (index >= 0 && index !== activeIndex) setActiveIndex(index);
                      }}
                      onClick={() => {
                        runCommand(command);
                      }}
                    >
                      <span className="palette-option-icon" aria-hidden="true">
                        {command.icon}
                      </span>
                      <span className="palette-option-label">{command.label}</span>
                      {command.shortcut && <Kbd>{command.shortcut}</Kbd>}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
