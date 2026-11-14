/**
 * Pure state of the real app: profiles, tools and MCP servers per profile. Everything is
 * keyed by profile id, so a late response for a profile that is no longer active lands in
 * that profile's slot and never replaces what is on screen.
 */
import type { McpServerView, Platform, Profile, ToolView } from "../ipc/bindings";
import type { VisionIpcError } from "../ipc/client";

/** Remote data with every state the UI designs for. */
export type Remote<T> =
  { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; error: VisionIpcError };

/** A long-running terminal operation the card waits for. */
export type WaitKind = "sign_in" | "sign_out";

/** Last outcome of an action on a tool, shown on its card until the next action. */
export type ToolNotice =
  | {
      kind: "error";
      action: "check" | "sign_in" | "sign_out" | "install";
      error: VisionIpcError;
    }
  | { kind: "timeout"; wait: WaitKind };

/** One tool card's state. */
export interface ToolEntry {
  view: ToolView;
  /** A status check started by the user or the first visit is running. */
  checking: boolean;
  /** A sign-in, sign-out or install request is being sent. */
  sending: "sign_in" | "sign_out" | "install" | null;
  /** Polling after a sign-in or sign-out until it completes, times out or is cancelled. */
  waiting: WaitKind | null;
  notice: ToolNotice | null;
}

/** Tools of one profile. */
export interface ToolsSlot {
  list: Remote<ToolEntry[]>;
  /** The first-visit check of every tool has been started. */
  autoChecked: boolean;
}

/** Startup state. */
export type BootState = { kind: "loading" } | { kind: "error"; error: VisionIpcError } | { kind: "ready" };

/** The whole data store. */
export interface DataState {
  boot: BootState;
  profiles: Profile[];
  activeProfileId: string | null;
  platform: Platform | null;
  tools: Record<string, ToolsSlot | undefined>;
  mcp: Record<string, Remote<McpServerView[]> | undefined>;
}

/** Every transition of the data store. */
export type DataAction =
  | { type: "boot/loading" }
  | {
      type: "boot/ready";
      profiles: Profile[];
      activeProfileId: string | null;
      platform: Platform;
    }
  | { type: "boot/failed"; error: VisionIpcError }
  | { type: "profile/added"; profile: Profile }
  | { type: "profile/updated"; profile: Profile }
  | { type: "profile/removed"; profileId: string; nextActiveId: string | null }
  | { type: "profile/active"; profileId: string }
  | { type: "tools/loading"; profileId: string }
  | { type: "tools/loaded"; profileId: string; views: ToolView[] }
  | { type: "tools/failed"; profileId: string; error: VisionIpcError }
  | { type: "tools/autoChecked"; profileId: string }
  | { type: "tools/invalidate" }
  | {
      type: "tool/patch";
      profileId: string;
      toolId: string;
      patch: Partial<Omit<ToolEntry, "view">>;
    }
  | { type: "tool/view"; profileId: string; view: ToolView }
  | { type: "tool/removed"; toolId: string }
  | { type: "mcp/loading"; profileId: string }
  | { type: "mcp/loaded"; profileId: string; servers: McpServerView[] }
  | { type: "mcp/failed"; profileId: string; error: VisionIpcError }
  | { type: "mcp/upsert"; profileId: string; server: McpServerView }
  | { type: "mcp/removed"; profileId: string; serverId: string };

/** Store before bootstrap answered. */
export const initialDataState: DataState = {
  boot: { kind: "loading" },
  profiles: [],
  activeProfileId: null,
  platform: null,
  tools: {},
  mcp: {},
};

function newEntry(view: ToolView): ToolEntry {
  return { view, checking: false, sending: null, waiting: null, notice: null };
}

function mapTools(
  state: DataState,
  profileId: string,
  update: (entries: ToolEntry[]) => ToolEntry[],
): DataState {
  const slot = state.tools[profileId];
  if (slot?.list.kind !== "ready") return state;
  return {
    ...state,
    tools: {
      ...state.tools,
      [profileId]: {
        ...slot,
        list: { kind: "ready", data: update(slot.list.data) },
      },
    },
  };
}

function mapServers(
  state: DataState,
  profileId: string,
  update: (servers: McpServerView[]) => McpServerView[],
): DataState {
  const slot = state.mcp[profileId];
  if (slot?.kind !== "ready") return state;
  return {
    ...state,
    mcp: {
      ...state.mcp,
      [profileId]: { kind: "ready", data: update(slot.data) },
    },
  };
}

function without<T>(record: Record<string, T | undefined>, key: string): Record<string, T | undefined> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

/** Pure reducer of the data store. */
export function dataReducer(state: DataState, action: DataAction): DataState {
  switch (action.type) {
    case "boot/loading":
      return { ...state, boot: { kind: "loading" } };
    case "boot/ready": {
      const known = action.profiles.some((p) => p.id === action.activeProfileId);
      return {
        ...state,
        boot: { kind: "ready" },
        profiles: action.profiles,
        activeProfileId: known ? action.activeProfileId : (action.profiles[0]?.id ?? null),
        platform: action.platform,
      };
    }
    case "boot/failed":
      return { ...state, boot: { kind: "error", error: action.error } };
    case "profile/added":
      if (state.profiles.some((p) => p.id === action.profile.id)) return state;
      return {
        ...state,
        profiles: [...state.profiles, action.profile],
        // The core makes the first profile active; mirror that.
        activeProfileId: state.activeProfileId ?? action.profile.id,
      };
    case "profile/updated":
      return {
        ...state,
        profiles: state.profiles.map((p) => (p.id === action.profile.id ? action.profile : p)),
      };
    case "profile/removed":
      return {
        ...state,
        profiles: state.profiles.filter((p) => p.id !== action.profileId),
        activeProfileId:
          state.activeProfileId === action.profileId ? action.nextActiveId : state.activeProfileId,
        tools: without(state.tools, action.profileId),
        mcp: without(state.mcp, action.profileId),
      };
    case "profile/active":
      if (!state.profiles.some((p) => p.id === action.profileId)) return state;
      return { ...state, activeProfileId: action.profileId };
    case "tools/loading":
      return {
        ...state,
        tools: {
          ...state.tools,
          [action.profileId]: {
            list: { kind: "loading" },
            autoChecked: state.tools[action.profileId]?.autoChecked ?? false,
          },
        },
      };
    case "tools/loaded": {
      const previous = state.tools[action.profileId];
      const old = previous?.list.kind === "ready" ? previous.list.data : [];
      // Keep per-card activity (a running poll) when the list is reloaded.
      const data = action.views.map((view) => {
        const kept = old.find((e) => e.view.spec.id === view.spec.id);
        return kept ? { ...kept, view } : newEntry(view);
      });
      return {
        ...state,
        tools: {
          ...state.tools,
          [action.profileId]: {
            list: { kind: "ready", data },
            autoChecked: previous?.autoChecked ?? false,
          },
        },
      };
    }
    case "tools/failed":
      return {
        ...state,
        tools: {
          ...state.tools,
          [action.profileId]: {
            list: { kind: "error", error: action.error },
            autoChecked: state.tools[action.profileId]?.autoChecked ?? false,
          },
        },
      };
    case "tools/autoChecked": {
      const slot = state.tools[action.profileId];
      if (!slot) return state;
      return {
        ...state,
        tools: {
          ...state.tools,
          [action.profileId]: { ...slot, autoChecked: true },
        },
      };
    }
    case "tools/invalidate": {
      // Custom tools are app-wide: other profiles reload their list on next visit.
      const tools: DataState["tools"] = {};
      for (const [id, slot] of Object.entries(state.tools)) {
        if (slot && id === state.activeProfileId) tools[id] = slot;
      }
      return { ...state, tools };
    }
    case "tool/patch":
      return mapTools(state, action.profileId, (entries) =>
        entries.map((e) => (e.view.spec.id === action.toolId ? { ...e, ...action.patch } : e)),
      );
    case "tool/view":
      return mapTools(state, action.profileId, (entries) =>
        entries.some((e) => e.view.spec.id === action.view.spec.id)
          ? entries.map((e) => (e.view.spec.id === action.view.spec.id ? { ...e, view: action.view } : e))
          : [...entries, newEntry(action.view)],
      );
    case "tool/removed": {
      let next = state;
      for (const id of Object.keys(state.tools)) {
        next = mapTools(next, id, (entries) => entries.filter((e) => e.view.spec.id !== action.toolId));
      }
      return next;
    }
    case "mcp/loading":
      return {
        ...state,
        mcp: { ...state.mcp, [action.profileId]: { kind: "loading" } },
      };
    case "mcp/loaded":
      return {
        ...state,
        mcp: {
          ...state.mcp,
          [action.profileId]: { kind: "ready", data: action.servers },
        },
      };
    case "mcp/failed":
      return {
        ...state,
        mcp: {
          ...state.mcp,
          [action.profileId]: { kind: "error", error: action.error },
        },
      };
    case "mcp/upsert":
      return mapServers(state, action.profileId, (servers) =>
        servers.some((s) => s.id === action.server.id)
          ? servers.map((s) => (s.id === action.server.id ? action.server : s))
          : [...servers, action.server],
      );
    case "mcp/removed":
      return mapServers(state, action.profileId, (servers) =>
        servers.filter((s) => s.id !== action.serverId),
      );
  }
}
