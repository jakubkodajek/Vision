import type { ReactNode } from "react";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: ReactNode;
  shortcut?: string;
  /** Extra words that should match, e.g. "dark light" for a theme command. */
  keywords?: string;
  disabled?: boolean;
  run: () => void;
}

/** Case-insensitive match of every query word against label, group and keywords. O(n·m). */
export function filterCommands(commands: Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  return commands.filter((c) => {
    const haystack = `${c.label} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}
