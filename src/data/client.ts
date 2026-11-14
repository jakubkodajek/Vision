/**
 * The IPC client as an injectable interface. Components never import Tauri: they get a
 * {@link VisionClient} from {@link ClientProvider}, so tests pass an in-memory fake and the
 * dev server in a plain browser uses a mock.
 */
import * as ipc from "../ipc/client";
import type {
  AppInfo,
  Bootstrap,
  CustomToolSaveArgs,
  McpSaveArgs,
  McpServerArgs,
  McpServerView,
  Profile,
  ProfileCreateArgs,
  ProfileDeleteArgs,
  ProfileScopeArgs,
  ProfileSetActiveArgs,
  ProfileUpdateArgs,
  SyncReport,
  ToolArgs,
  ToolIdArgs,
  ToolSpecView,
  ToolView,
} from "../ipc/bindings";

/** One async function per IPC command (docs/specs/real-app-foundation.md §2.6). */
export interface VisionClient {
  appInfo: () => Promise<AppInfo>;
  bootstrap: () => Promise<Bootstrap>;
  profileCreate: (args: ProfileCreateArgs) => Promise<Profile>;
  profileUpdate: (args: ProfileUpdateArgs) => Promise<Profile>;
  profileDelete: (args: ProfileDeleteArgs) => Promise<null>;
  profileSetActive: (args: ProfileSetActiveArgs) => Promise<null>;
  profileOpenTerminal: (args: ProfileScopeArgs) => Promise<null>;
  toolsList: (args: ProfileScopeArgs) => Promise<ToolView[]>;
  toolCheck: (args: ToolArgs) => Promise<ToolView>;
  toolSignIn: (args: ToolArgs) => Promise<null>;
  toolSignOut: (args: ToolArgs) => Promise<null>;
  toolOpenInstallPage: (args: ToolIdArgs) => Promise<null>;
  customToolSave: (args: CustomToolSaveArgs) => Promise<ToolSpecView>;
  customToolDelete: (args: ToolIdArgs) => Promise<null>;
  mcpList: (args: ProfileScopeArgs) => Promise<McpServerView[]>;
  mcpSave: (args: McpSaveArgs) => Promise<McpServerView>;
  mcpDelete: (args: McpServerArgs) => Promise<null>;
  mcpTest: (args: McpServerArgs) => Promise<McpServerView>;
  mcpSyncClaude: (args: ProfileScopeArgs) => Promise<SyncReport>;
  mcpAuthorize: (args: McpServerArgs) => Promise<null>;
}

/** The real client: every call goes through Tauri `invoke`. */
export const tauriClient: VisionClient = {
  appInfo: ipc.appInfo,
  bootstrap: ipc.bootstrap,
  profileCreate: ipc.profileCreate,
  profileUpdate: ipc.profileUpdate,
  profileDelete: ipc.profileDelete,
  profileSetActive: ipc.profileSetActive,
  profileOpenTerminal: ipc.profileOpenTerminal,
  toolsList: ipc.toolsList,
  toolCheck: ipc.toolCheck,
  toolSignIn: ipc.toolSignIn,
  toolSignOut: ipc.toolSignOut,
  toolOpenInstallPage: ipc.toolOpenInstallPage,
  customToolSave: ipc.customToolSave,
  customToolDelete: ipc.customToolDelete,
  mcpList: ipc.mcpList,
  mcpSave: ipc.mcpSave,
  mcpDelete: ipc.mcpDelete,
  mcpTest: ipc.mcpTest,
  mcpSyncClaude: ipc.mcpSyncClaude,
  mcpAuthorize: ipc.mcpAuthorize,
};
