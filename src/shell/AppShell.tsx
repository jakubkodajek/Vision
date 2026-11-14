import {
  BookOpen,
  Bot,
  FolderGit2,
  House,
  ListChecks,
  MessageSquareText,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Settings,
  Sun,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { CommandPalette } from "../components/CommandPalette";
import type { ComposerSubmission, PickerOption } from "../components/Composer";
import { Panel } from "../components/Panel";
import { EmptyState } from "../components/primitives";
import { Sidebar } from "../components/Sidebar";
import { DEMO_AGENTS, DEMO_MODELS, DEMO_PROFILES } from "../demo/workspace";
import type { Command } from "../lib/commands";
import { hasModifier, shortcutLabel } from "../lib/platform";
import { isBoolean, isFiniteNumber, readPreference, writePreference } from "../lib/storage";
import type {
  ApprovalDecision,
  LoadState,
  Profile,
  Run,
  Section,
  ThemePreference,
  Workspace,
} from "../types";
import { ChangesView } from "./ChangesView";
import { HomeView } from "./HomeView";
import { RunView } from "./RunView";
import { SectionView } from "./SectionView";
import { SettingsView } from "./SettingsView";
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  shellReducer,
  type PanelTabId,
  type ShellState,
} from "./state";

export interface AppShellProps {
  /** Loads a profile's workspace; injected so tests and the future core can replace the demo. */
  loadWorkspace: (profileId: string) => Promise<Workspace>;
  profiles?: readonly Profile[];
  coreVersion: string | null;
  /** Footer content, e.g. the core connection status. */
  footer?: ReactNode;
  /** Delay between streamed words in the preview reply; 0 in tests. */
  streamDelayMs?: number;
  /** Delay before a preview approval resolves. */
  decisionDelayMs?: number;
}

const isTheme = (value: unknown): value is ThemePreference =>
  value === "system" || value === "light" || value === "dark";

const AGENTS: PickerOption[] = DEMO_AGENTS.map((a) => ({ id: a, label: a }));
const MODELS: PickerOption[] = DEMO_MODELS.map((m) => ({ id: m, label: m }));

const PREVIEW_REPLY =
  "This is a preview of the Vision interface. Agent runs are not connected to the core yet, so nothing was sent to a CLI. Real runs arrive with the Claude Code adapter (F-020); until then you can explore the layout, the panel and the command palette.";

const NAV_ICONS: Record<Section, ReactNode> = {
  home: <House width={16} height={16} />,
  projects: <FolderGit2 width={16} height={16} />,
  agents: <Bot width={16} height={16} />,
  tasks: <ListChecks width={16} height={16} />,
  knowledge: <BookOpen width={16} height={16} />,
  settings: <Settings width={16} height={16} />,
};

const SECTION_LABEL: Record<Section, string> = {
  home: "Home",
  projects: "Projects",
  agents: "Agents",
  tasks: "Tasks",
  knowledge: "Knowledge",
  settings: "Settings",
};

function initialState(profiles: readonly Profile[]): ShellState {
  return {
    profileId: profiles[0]?.id ?? "",
    workspaces: {},
    section: "home",
    activeRunId: null,
    sidebarCollapsed: readPreference("sidebarCollapsed", false, isBoolean),
    panelOpen: readPreference("panelOpen", true, isBoolean),
    panelWidth: Math.min(
      PANEL_MAX_WIDTH,
      Math.max(PANEL_MIN_WIDTH, readPreference("panelWidth", PANEL_DEFAULT_WIDTH, isFiniteNumber)),
    ),
    panelTab: "changes",
    paletteOpen: false,
    profileMenuOpen: false,
    theme: readPreference("theme", "system", isTheme),
    expanded: {},
    composerFocusKey: 0,
  };
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${String(Date.now())}-${String(idCounter)}`;
}

function timeNow(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The Vision window: sidebar, main column, side panel and command palette. */
export function AppShell({
  loadWorkspace,
  profiles = DEMO_PROFILES,
  coreVersion,
  footer,
  streamDelayMs = 28,
  decisionDelayMs = 500,
}: AppShellProps) {
  const [state, dispatch] = useReducer(shellReducer, profiles, initialState);
  const shellRef = useRef<HTMLDivElement>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);

  const profile = profiles.find((p) => p.id === state.profileId) ?? profiles[0];
  const storedWorkspace = state.workspaces[state.profileId];
  const workspace = useMemo<LoadState<Workspace>>(
    () => storedWorkspace ?? { kind: "loading" },
    [storedWorkspace],
  );
  const runs = useMemo(() => (workspace.kind === "ready" ? workspace.data.runs : []), [workspace]);
  const activeRun = runs.find((r) => r.id === state.activeRunId) ?? null;

  // --- effects -------------------------------------------------------------

  useEffect(() => {
    mounted.current = true;
    const pending = timers.current;
    return () => {
      mounted.current = false;
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      if (mounted.current) fn();
    }, ms);
    timers.current.add(t);
  }, []);

  const load = useCallback(
    (profileId: string) => {
      dispatch({ type: "workspace/loading", profileId });
      loadWorkspace(profileId)
        .then((data) => {
          if (mounted.current) dispatch({ type: "workspace/loaded", profileId, data });
        })
        .catch((error: unknown) => {
          if (mounted.current)
            dispatch({
              type: "workspace/failed",
              profileId,
              message: error instanceof Error ? error.message : "Unknown error",
            });
        });
    },
    [loadWorkspace],
  );

  const currentWorkspaceKind = state.workspaces[state.profileId]?.kind;
  useEffect(() => {
    if (currentWorkspaceKind === undefined && state.profileId) load(state.profileId);
  }, [currentWorkspaceKind, state.profileId, load]);

  useEffect(() => {
    const root = document.documentElement;
    if (state.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    writePreference("theme", state.theme);
  }, [state.theme]);

  useEffect(() => {
    writePreference("sidebarCollapsed", state.sidebarCollapsed);
  }, [state.sidebarCollapsed]);

  useEffect(() => {
    writePreference("panelOpen", state.panelOpen);
  }, [state.panelOpen]);

  useEffect(() => {
    // CSSOM is allowed by the production CSP (style-src 'self'); inline style attributes are not needed.
    shellRef.current?.style.setProperty("--panel-width", `${String(state.panelWidth)}px`);
    writePreference("panelWidth", state.panelWidth);
  }, [state.panelWidth]);

  // --- run interactions (preview only) -------------------------------------

  const streamReply = useCallback(
    (profileId: string, runId: string, finalStatus: Run["status"]) => {
      const messageId = nextId("m");
      const words = PREVIEW_REPLY.split(" ");
      dispatch({
        type: "run/appendEvent",
        profileId,
        runId,
        event: {
          kind: "message",
          id: messageId,
          role: "agent",
          author: "Vision",
          text: "",
          status: "streaming",
          time: timeNow(),
        },
      });
      const step = (i: number) => {
        if (i > words.length) {
          dispatch({
            type: "run/updateEvent",
            profileId,
            runId,
            eventId: messageId,
            patch: { status: "complete" },
          });
          dispatch({ type: "run/status", profileId, runId, status: finalStatus });
          return;
        }
        dispatch({
          type: "run/updateEvent",
          profileId,
          runId,
          eventId: messageId,
          patch: { text: words.slice(0, i).join(" ") },
        });
        later(() => {
          step(i + 1);
        }, streamDelayMs);
      };
      later(() => {
        step(1);
      }, streamDelayMs * 8);
    },
    [later, streamDelayMs],
  );

  const startTask = useCallback(
    async ({ text, agent, model, projectId }: ComposerSubmission) => {
      const profileId = state.profileId;
      const run: Run = {
        id: nextId("run"),
        title: text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text,
        projectId,
        agent,
        model,
        branch: `vision/preview/${agent.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        status: "running",
        updated: "Just now",
        events: [
          {
            kind: "message",
            id: nextId("m"),
            role: "user",
            author: "You",
            text,
            status: "complete",
            time: timeNow(),
          },
        ],
        changes: [],
      };
      dispatch({ type: "run/add", profileId, run });
      dispatch({ type: "run/open", runId: run.id });
      streamReply(profileId, run.id, "done");
      return Promise.resolve();
    },
    [state.profileId, streamReply],
  );

  const sendInRun = useCallback(
    async ({ text }: ComposerSubmission) => {
      if (!activeRun) return Promise.resolve();
      const profileId = state.profileId;
      dispatch({
        type: "run/appendEvent",
        profileId,
        runId: activeRun.id,
        event: {
          kind: "message",
          id: nextId("m"),
          role: "user",
          author: "You",
          text,
          status: "complete",
          time: timeNow(),
        },
      });
      dispatch({ type: "run/status", profileId, runId: activeRun.id, status: "running" });
      streamReply(profileId, activeRun.id, "done");
      return Promise.resolve();
    },
    [activeRun, state.profileId, streamReply],
  );

  const decide = useCallback(
    (eventId: string, decision: ApprovalDecision) => {
      const profileId = state.profileId;
      const runId = state.activeRunId;
      return new Promise<void>((resolve) => {
        later(() => {
          if (!runId) {
            resolve();
            return;
          }
          dispatch({
            type: "run/updateEvent",
            profileId,
            runId,
            eventId,
            patch: { status: decision === "allow" ? "allowed" : "denied" },
          });
          dispatch({ type: "run/status", profileId, runId, status: "running" });
          streamReply(profileId, runId, "done");
          resolve();
        }, decisionDelayMs);
      });
    },
    [decisionDelayMs, later, state.activeRunId, state.profileId, streamReply],
  );

  // --- commands & shortcuts ------------------------------------------------

  const openPalette = useCallback(() => {
    dispatch({ type: "palette/set", open: true });
  }, []);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "new-task",
        label: "New task",
        group: "Actions",
        icon: <Plus width={16} height={16} />,
        shortcut: shortcutLabel("n"),
        run: () => {
          dispatch({ type: "composer/focus" });
        },
      },
      {
        id: "toggle-sidebar",
        label: state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
        group: "Actions",
        icon: <PanelLeft width={16} height={16} />,
        shortcut: shortcutLabel("b"),
        run: () => {
          dispatch({ type: "sidebar/toggle" });
        },
      },
      {
        id: "toggle-panel",
        label: state.panelOpen ? "Hide side panel" : "Show side panel",
        group: "Actions",
        icon: <PanelRight width={16} height={16} />,
        shortcut: shortcutLabel("j"),
        disabled: !activeRun,
        keywords: "changes diff files",
        run: () => {
          dispatch({ type: "panel/set", open: !state.panelOpen });
        },
      },
      {
        id: "switch-profile",
        label: "Switch profile…",
        group: "Actions",
        icon: <UserRound width={16} height={16} />,
        keywords: "account work personal",
        run: () => {
          if (state.sidebarCollapsed) dispatch({ type: "sidebar/toggle" });
          dispatch({ type: "profile/menu", open: true });
        },
      },
    ];
    for (const section of Object.keys(SECTION_LABEL) as Section[]) {
      list.push({
        id: `go-${section}`,
        label: `Go to ${SECTION_LABEL[section]}`,
        group: "Navigation",
        icon: NAV_ICONS[section],
        run: () => {
          dispatch({ type: "navigate", section });
        },
      });
    }
    for (const p of profiles) {
      list.push({
        id: `profile-${p.id}`,
        label: `Use profile ${p.name}`,
        group: "Profiles",
        icon: <UserRound width={16} height={16} />,
        keywords: p.account,
        disabled: p.id === state.profileId,
        run: () => {
          dispatch({ type: "profile/switch", profileId: p.id });
        },
      });
    }
    for (const run of runs) {
      list.push({
        id: `run-${run.id}`,
        label: run.title,
        group: "Runs",
        icon: <MessageSquareText width={16} height={16} />,
        keywords: `${run.agent} ${run.branch}`,
        run: () => {
          dispatch({ type: "run/open", runId: run.id });
        },
      });
    }
    const themeIcons: Record<ThemePreference, ReactNode> = {
      system: <Monitor width={16} height={16} />,
      light: <Sun width={16} height={16} />,
      dark: <Moon width={16} height={16} />,
    };
    for (const theme of ["system", "light", "dark"] as const) {
      list.push({
        id: `theme-${theme}`,
        label: `Theme: ${theme[0]?.toUpperCase() ?? ""}${theme.slice(1)}`,
        group: "Appearance",
        icon: themeIcons[theme],
        keywords: "appearance colour color mode",
        disabled: state.theme === theme,
        run: () => {
          dispatch({ type: "theme/set", theme });
        },
      });
    }
    return list;
  }, [activeRun, profiles, runs, state.panelOpen, state.profileId, state.sidebarCollapsed, state.theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!hasModifier(event) || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        dispatch({ type: "palette/set", open: !state.paletteOpen });
      } else if (key === "b") {
        event.preventDefault();
        dispatch({ type: "sidebar/toggle" });
      } else if (key === "j" && activeRun) {
        event.preventDefault();
        dispatch({ type: "panel/set", open: !state.panelOpen });
      } else if (key === "n") {
        event.preventDefault();
        dispatch({ type: "palette/set", open: false });
        dispatch({ type: "composer/focus" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [activeRun, state.paletteOpen, state.panelOpen]);

  if (!profile) {
    return (
      <div className="fatal-error">
        <EmptyState title="No profile" description="Create a profile to start using Vision." />
      </div>
    );
  }

  // --- render --------------------------------------------------------------

  const expanded = new Set(state.expanded[state.profileId] ?? []);
  const showPanel = activeRun !== null && state.panelOpen;
  const panelTabs: { id: PanelTabId; label: string; count?: number }[] = [
    { id: "changes", label: "Changes", count: activeRun?.changes.length },
    { id: "files", label: "Files" },
    { id: "artifacts", label: "Artifacts" },
  ];

  let main: ReactNode;
  if (activeRun) {
    main = (
      <RunView
        run={activeRun}
        panelOpen={state.panelOpen}
        onTogglePanel={() => {
          dispatch({ type: "panel/set", open: !state.panelOpen });
        }}
        onDecide={decide}
        onSend={sendInRun}
        agents={AGENTS}
        models={MODELS}
      />
    );
  } else if (state.section === "home") {
    main = (
      <HomeView
        profile={profile}
        workspace={workspace}
        onRetry={() => {
          load(state.profileId);
        }}
        onStart={startTask}
        onOpenRun={(runId) => {
          dispatch({ type: "run/open", runId });
        }}
        agents={AGENTS}
        models={MODELS}
        focusKey={state.composerFocusKey}
      />
    );
  } else if (state.section === "settings") {
    main = (
      <SettingsView
        theme={state.theme}
        onThemeChange={(theme) => {
          dispatch({ type: "theme/set", theme });
        }}
        coreVersion={coreVersion}
      />
    );
  } else {
    main = <SectionView section={state.section} />;
  }

  return (
    <div
      ref={shellRef}
      className="app-shell"
      data-accent={profile.accent}
      data-sidebar={state.sidebarCollapsed ? "collapsed" : "expanded"}
      data-panel={showPanel ? "open" : "closed"}
    >
      <Sidebar
        collapsed={state.sidebarCollapsed}
        onToggleCollapsed={() => {
          dispatch({ type: "sidebar/toggle" });
        }}
        profiles={profiles}
        activeProfileId={state.profileId}
        onSwitchProfile={(profileId) => {
          dispatch({ type: "profile/switch", profileId });
        }}
        profileMenuOpen={state.profileMenuOpen}
        onProfileMenuOpenChange={(open) => {
          dispatch({ type: "profile/menu", open });
        }}
        section={state.section}
        activeRunId={state.activeRunId}
        onNavigate={(section) => {
          dispatch({ type: "navigate", section });
        }}
        onNewTask={() => {
          dispatch({ type: "composer/focus" });
        }}
        onOpenPalette={openPalette}
        workspace={workspace}
        onRetryWorkspace={() => {
          load(state.profileId);
        }}
        expanded={expanded}
        onToggleNode={(nodeId) => {
          dispatch({ type: "tree/toggle", nodeId });
        }}
        onOpenRun={(runId) => {
          dispatch({ type: "run/open", runId });
        }}
        footer={footer}
      />
      <main className="main" aria-label="Main content">
        {main}
      </main>
      {showPanel && (
        <Panel
          title="Run details"
          tabs={panelTabs}
          activeTab={state.panelTab}
          onTabChange={(tab) => {
            dispatch({ type: "panel/tab", tab: tab as PanelTabId });
          }}
          onClose={() => {
            dispatch({ type: "panel/set", open: false });
          }}
          closeShortcut={shortcutLabel("j")}
          width={state.panelWidth}
          minWidth={PANEL_MIN_WIDTH}
          maxWidth={PANEL_MAX_WIDTH}
          onResize={(width) => {
            dispatch({ type: "panel/width", width });
          }}
        >
          {state.panelTab === "changes" && <ChangesView files={activeRun.changes} />}
          {state.panelTab === "files" && (
            <EmptyState
              title="File browser not available yet"
              description="Browsing the run's worktree arrives with worktrees per run (F-021)."
            />
          )}
          {state.panelTab === "artifacts" && (
            <EmptyState
              title="No artifacts"
              description="Reports, screenshots and other files a run produces will be listed here."
            />
          )}
        </Panel>
      )}
      <CommandPalette
        open={state.paletteOpen}
        commands={commands}
        onClose={() => {
          dispatch({ type: "palette/set", open: false });
        }}
      />
    </div>
  );
}
