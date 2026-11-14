import { createContext, useContext } from "react";
import type {
  CustomToolInput,
  McpServerInput,
  McpServerView,
  Profile,
  ProfileCreateArgs,
  ProfileUpdateArgs,
  SyncReport,
  ToolSpecView,
} from "../ipc/bindings";
import type { DataState } from "./store";

/** Polling interval and timeouts of the sign-in and sign-out wait. */
export interface VisionTiming {
  pollIntervalMs: number;
  signInTimeoutMs: number;
  signOutTimeoutMs: number;
}

/** Defaults from docs/specs/real-app-foundation.md §3: re-check every 3 s, 10 min for sign-in. */
export const DEFAULT_TIMING: VisionTiming = {
  pollIntervalMs: 3_000,
  signInTimeoutMs: 10 * 60_000,
  signOutTimeoutMs: 2 * 60_000,
};

/**
 * Everything the UI can ask the data layer to do. Fire-and-forget actions keep their
 * progress and errors in the store; actions that return a promise reject with a
 * `VisionIpcError` so the form that started them can show it.
 */
export interface VisionActions {
  retryBoot: () => void;
  createProfile: (args: ProfileCreateArgs) => Promise<Profile>;
  updateProfile: (args: ProfileUpdateArgs) => Promise<Profile>;
  deleteProfile: (profileId: string, confirmName: string) => Promise<void>;
  /** Persists and shows another profile. Ignored while a switch is in flight. */
  switchProfile: (profileId: string) => Promise<void>;
  openProfileTerminal: (profileId: string) => Promise<void>;
  /** Loads the tool list and, on the first visit per profile, checks every tool. */
  visitTools: (profileId: string) => void;
  /** Loads the cached tool list if it is not loaded (no status checks). */
  ensureTools: (profileId: string) => void;
  reloadTools: (profileId: string) => void;
  checkTool: (profileId: string, toolId: string) => void;
  checkAllTools: (profileId: string) => void;
  signIn: (profileId: string, toolId: string) => void;
  signOut: (profileId: string, toolId: string) => void;
  cancelWait: (profileId: string, toolId: string) => void;
  dismissNotice: (profileId: string, toolId: string) => void;
  openInstallPage: (profileId: string, toolId: string) => void;
  saveCustomTool: (tool: CustomToolInput) => Promise<ToolSpecView>;
  deleteCustomTool: (toolId: string) => Promise<void>;
  ensureMcp: (profileId: string) => void;
  reloadMcp: (profileId: string) => void;
  saveServer: (profileId: string, server: McpServerInput) => Promise<McpServerView>;
  deleteServer: (profileId: string, serverId: string) => Promise<void>;
  testServer: (profileId: string, serverId: string) => Promise<McpServerView>;
  authorizeServer: (profileId: string, serverId: string) => Promise<void>;
  syncClaude: (profileId: string) => Promise<SyncReport>;
}

/** Value of the data context. */
export interface VisionContextValue {
  state: DataState;
  actions: VisionActions;
}

export const VisionContext = createContext<VisionContextValue | null>(null);

/** State and actions of the data layer; must be used below `VisionProvider`. */
export function useVision(): VisionContextValue {
  const value = useContext(VisionContext);
  if (!value) throw new Error("useVision must be used inside VisionProvider");
  return value;
}
