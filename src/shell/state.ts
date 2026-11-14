import type { LoadState, Run, RunEvent, RunStatus, Section, ThemePreference, Workspace } from "../types";

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 760;
export const PANEL_DEFAULT_WIDTH = 440;

export type PanelTabId = "changes" | "files" | "artifacts";

export interface ShellState {
  profileId: string;
  workspaces: Record<string, LoadState<Workspace> | undefined>;
  section: Section;
  activeRunId: string | null;
  sidebarCollapsed: boolean;
  panelOpen: boolean;
  panelWidth: number;
  panelTab: PanelTabId;
  paletteOpen: boolean;
  profileMenuOpen: boolean;
  theme: ThemePreference;
  /** Expanded tree node ids per profile. */
  expanded: Record<string, string[]>;
  /** Bumped to remount and focus the home composer. */
  composerFocusKey: number;
}

export type ShellAction =
  | { type: "workspace/loading"; profileId: string }
  | { type: "workspace/loaded"; profileId: string; data: Workspace }
  | { type: "workspace/failed"; profileId: string; message: string }
  | { type: "profile/switch"; profileId: string }
  | { type: "profile/menu"; open: boolean }
  | { type: "navigate"; section: Section }
  | { type: "run/open"; runId: string }
  | { type: "run/add"; profileId: string; run: Run }
  | { type: "run/appendEvent"; profileId: string; runId: string; event: RunEvent }
  | { type: "run/updateEvent"; profileId: string; runId: string; eventId: string; patch: Partial<RunEvent> }
  | { type: "run/status"; profileId: string; runId: string; status: RunStatus }
  | { type: "sidebar/toggle" }
  | { type: "panel/set"; open: boolean }
  | { type: "panel/width"; width: number }
  | { type: "panel/tab"; tab: PanelTabId }
  | { type: "palette/set"; open: boolean }
  | { type: "tree/toggle"; nodeId: string }
  | { type: "theme/set"; theme: ThemePreference }
  | { type: "composer/focus" };

function clampPanel(width: number): number {
  return Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

function mapRun(state: ShellState, profileId: string, runId: string, update: (run: Run) => Run): ShellState {
  const ws = state.workspaces[profileId];
  if (ws?.kind !== "ready") return state;
  if (!ws.data.runs.some((run) => run.id === runId)) return state;
  const runs = ws.data.runs.map((run) => (run.id === runId ? update(run) : run));
  return {
    ...state,
    workspaces: { ...state.workspaces, [profileId]: { kind: "ready", data: { ...ws.data, runs } } },
  };
}

/** Adds a task node for a new run under its project in the tree. */
function addTaskNode(data: Workspace, run: Run): Workspace {
  const projects = data.projects.map((project) =>
    project.id === run.projectId
      ? {
          ...project,
          children: [
            { id: `task-${run.id}`, label: run.title, kind: "task" as const, runId: run.id },
            ...(project.children ?? []),
          ],
        }
      : project,
  );
  return { projects, runs: [run, ...data.runs] };
}

/** Pure reducer for the shell; every UI state transition goes through here. */
export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case "workspace/loading":
      return { ...state, workspaces: { ...state.workspaces, [action.profileId]: { kind: "loading" } } };
    case "workspace/loaded":
      return {
        ...state,
        workspaces: { ...state.workspaces, [action.profileId]: { kind: "ready", data: action.data } },
        expanded: {
          ...state.expanded,
          [action.profileId]:
            state.expanded[action.profileId] ??
            action.data.projects
              .slice(0, 1)
              .flatMap((p) => [p.id, ...(p.children ?? []).slice(0, 1).map((c) => c.id)]),
        },
      };
    case "workspace/failed":
      return {
        ...state,
        workspaces: { ...state.workspaces, [action.profileId]: { kind: "error", message: action.message } },
      };
    case "profile/switch":
      if (action.profileId === state.profileId) return { ...state, profileMenuOpen: false };
      // A run belongs to one profile: switching never shows another profile's run.
      return {
        ...state,
        profileId: action.profileId,
        activeRunId: null,
        section: "home",
        profileMenuOpen: false,
      };
    case "profile/menu":
      return { ...state, profileMenuOpen: action.open, paletteOpen: action.open ? false : state.paletteOpen };
    case "navigate":
      return { ...state, section: action.section, activeRunId: null };
    case "run/open":
      return { ...state, activeRunId: action.runId };
    case "run/add": {
      const ws = state.workspaces[action.profileId];
      if (ws?.kind !== "ready") return state;
      return {
        ...state,
        workspaces: {
          ...state.workspaces,
          [action.profileId]: { kind: "ready", data: addTaskNode(ws.data, action.run) },
        },
        expanded: {
          ...state.expanded,
          [action.profileId]: [
            ...new Set([...(state.expanded[action.profileId] ?? []), action.run.projectId]),
          ],
        },
      };
    }
    case "run/appendEvent":
      return mapRun(state, action.profileId, action.runId, (run) => ({
        ...run,
        events: [...run.events, action.event],
      }));
    case "run/updateEvent":
      return mapRun(state, action.profileId, action.runId, (run) => ({
        ...run,
        events: run.events.map((e) =>
          e.id === action.eventId ? ({ ...e, ...action.patch } as RunEvent) : e,
        ),
      }));
    case "run/status":
      return mapRun(state, action.profileId, action.runId, (run) => ({
        ...run,
        status: action.status,
        updated: "Just now",
      }));
    case "sidebar/toggle":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed, profileMenuOpen: false };
    case "panel/set":
      return { ...state, panelOpen: action.open };
    case "panel/width":
      return { ...state, panelWidth: clampPanel(action.width) };
    case "panel/tab":
      return { ...state, panelTab: action.tab, panelOpen: true };
    case "palette/set":
      return { ...state, paletteOpen: action.open, profileMenuOpen: false };
    case "tree/toggle": {
      const current = state.expanded[state.profileId] ?? [];
      const next = current.includes(action.nodeId)
        ? current.filter((id) => id !== action.nodeId)
        : [...current, action.nodeId];
      return { ...state, expanded: { ...state.expanded, [state.profileId]: next } };
    }
    case "theme/set":
      return { ...state, theme: action.theme };
    case "composer/focus":
      return { ...state, section: "home", activeRunId: null, composerFocusKey: state.composerFocusKey + 1 };
  }
}
