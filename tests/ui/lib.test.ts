import { describe, expect, it } from "vitest";
import { filterCommands, type Command } from "../../src/lib/commands";
import { formatDuration } from "../../src/lib/labels";
import { splitFences } from "../../src/lib/text";
import { shellReducer, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, type ShellState } from "../../src/shell/state";
import type { Run, Workspace } from "../../src/types";

describe("splitFences", () => {
  it("returns plain text as one segment", () => {
    expect(splitFences("hello")).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("splits prose and a fenced block", () => {
    expect(splitFences("Run this:\n```sh\nnpm test\n```\nDone.")).toEqual([
      { kind: "text", text: "Run this:" },
      { kind: "code", lang: "sh", text: "npm test" },
      { kind: "text", text: "Done." },
    ]);
  });

  it("treats an unclosed fence as code to the end (streaming)", () => {
    expect(splitFences("a\n```\nlet x")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", lang: "", text: "let x" },
    ]);
  });

  it("keeps markup as literal text", () => {
    const segments = splitFences('<img src=x onerror="alert(1)">');
    expect(segments).toEqual([{ kind: "text", text: '<img src=x onerror="alert(1)">' }]);
  });

  it("returns nothing for empty text", () => {
    expect(splitFences("")).toEqual([]);
  });
});

describe("formatDuration", () => {
  it.each([
    [41, "41 ms"],
    [2140, "2.1 s"],
    [59_960, "1 min 0 s"],
    [119_600, "2 min 0 s"],
    [185_000, "3 min 5 s"],
    [-1, ""],
    [Number.NaN, ""],
  ])("%d ms -> %s", (ms, label) => {
    expect(formatDuration(ms)).toBe(label);
  });
});

describe("filterCommands", () => {
  const noop = () => undefined;
  const commands: Command[] = [
    { id: "a", label: "New task", group: "Actions", run: noop },
    { id: "b", label: "Theme: Dark", group: "Appearance", keywords: "colour mode", run: noop },
    { id: "c", label: "Go to Settings", group: "Navigation", run: noop },
  ];

  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "  ")).toHaveLength(3);
  });

  it("matches every word, case-insensitively, across label, group and keywords", () => {
    expect(filterCommands(commands, "DARK mode").map((c) => c.id)).toEqual(["b"]);
    expect(filterCommands(commands, "navigation set").map((c) => c.id)).toEqual(["c"]);
  });

  it("returns nothing when a word does not match", () => {
    expect(filterCommands(commands, "task zebra")).toEqual([]);
  });
});

function baseState(): ShellState {
  return {
    profileId: "p1",
    workspaces: {},
    section: "home",
    activeRunId: null,
    sidebarCollapsed: false,
    panelOpen: true,
    panelWidth: 440,
    panelTab: "changes",
    paletteOpen: false,
    profileMenuOpen: false,
    theme: "system",
    expanded: {},
    composerFocusKey: 0,
  };
}

const run: Run = {
  id: "r1",
  title: "Run",
  projectId: "proj",
  agent: "A",
  model: "M",
  branch: "b",
  status: "running",
  updated: "now",
  events: [],
  changes: [],
};
const workspace: Workspace = {
  projects: [{ id: "proj", label: "proj", kind: "project", children: [] }],
  runs: [run],
};

describe("shellReducer", () => {
  it("clamps the panel width", () => {
    expect(shellReducer(baseState(), { type: "panel/width", width: 10 }).panelWidth).toBe(PANEL_MIN_WIDTH);
    expect(shellReducer(baseState(), { type: "panel/width", width: 99_999 }).panelWidth).toBe(PANEL_MAX_WIDTH);
  });

  it("closes the open run when switching profile, so no data crosses profiles", () => {
    const state = { ...baseState(), activeRunId: "r1", section: "tasks" as const };
    const next = shellReducer(state, { type: "profile/switch", profileId: "p2" });
    expect(next.profileId).toBe("p2");
    expect(next.activeRunId).toBeNull();
    expect(next.section).toBe("home");
  });

  it("adds a new run first and as a task node under its project", () => {
    const loaded = shellReducer(baseState(), { type: "workspace/loaded", profileId: "p1", data: workspace });
    const added = shellReducer(loaded, { type: "run/add", profileId: "p1", run: { ...run, id: "r2", title: "New" } });
    const ws = added.workspaces.p1;
    expect(ws?.kind).toBe("ready");
    if (ws?.kind !== "ready") return;
    expect(ws.data.runs.map((r) => r.id)).toEqual(["r2", "r1"]);
    expect(ws.data.projects[0]?.children?.[0]).toMatchObject({ kind: "task", runId: "r2" });
    expect(added.expanded.p1).toContain("proj");
  });

  it("ignores run updates for an unknown run or an unloaded profile", () => {
    const loaded = shellReducer(baseState(), { type: "workspace/loaded", profileId: "p1", data: workspace });
    expect(shellReducer(loaded, { type: "run/status", profileId: "p1", runId: "nope", status: "done" })).toBe(loaded);
    expect(shellReducer(loaded, { type: "run/status", profileId: "p9", runId: "r1", status: "done" })).toBe(loaded);
  });

  it("toggles tree nodes per profile", () => {
    const once = shellReducer(baseState(), { type: "tree/toggle", nodeId: "n" });
    expect(once.expanded.p1).toEqual(["n"]);
    expect(shellReducer(once, { type: "tree/toggle", nodeId: "n" }).expanded.p1).toEqual([]);
  });
});
