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
  Plug,
  Plus,
  Settings,
  Sun,
  UserRound,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { CommandPalette } from "../components/CommandPalette";
import type { ComposerSubmission, PickerOption } from "../components/Composer";
import { Panel } from "../components/Panel";
import { EmptyState } from "../components/primitives";
import { Sidebar } from "../components/Sidebar";
import { DEMO_AGENTS, DEMO_MODELS } from "../demo/workspace";
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
  /**
   * Loads a profile's preview projects and runs. Omitted in the shipped app until runs exist
   * (F-020): the project tree, recent runs and New task are then hidden.
   */
  loadWorkspace?: (profileId: string) => Promise<Workspace>;
  profiles: readonly Profile[];
  /** Controlled active profile; with it, switching only calls `onSwitchProfile`. */
  activeProfileId?: string;
  onSwitchProfile?: (profileId: string) => void;
  /** Enables "New profile…" in the profile menu and the palette. */
  onNewProfile?: () => void;
  /** Enables "Manage profiles" in the profile menu. */
  onManageProfiles?: () => void;
  /** Controlled section; navigation then also calls `onNavigate`. */
  section?: Section;
  onNavigate?: (section: Section) => void;
  /** Main content for a section; `undefined` falls back to the built-in view. */
  renderSection?: (section: Section) => ReactNode;
  /** Content shown first in Settings, e.g. profile management. */
  settingsTop?: ReactNode;
  /** Commands added to the palette. */
  extraCommands?: readonly Command[];
  /** Message shown above the main content, e.g. a failed profile switch. */
  banner?: ReactNode;
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
  tools: <Wrench width={16} height={16} />,
  mcp: <Plug width={16} height={16} />,
  projects: <FolderGit2 width={16} height={16} />,
  agents: <Bot width={16} height={16} />,
  tasks: <ListChecks width={16} height={16} />,
  knowledge: <BookOpen width={16} height={16} />,
  settings: <Settings width={16} height={16} />,
};

const SECTION_LABEL: Record<Section, string> = {
  home: "Home",
  tools: "Tools",
  mcp: "MCP servers",
  projects: "Projects",
  agents: "Agents",
  tasks: "Tasks",
  knowledge: "Knowledge",
  settings: "Settings",
};

function initialState({
  profiles,
  activeProfileId,
}: Pick<AppShellProps, "profiles" | "activeProfileId">): ShellState {
  return {
    profileId: activeProfileId ?? profiles[0]?.id ?? "",
    workspaces: {},
    section: "home",
    activeRunId: null,
    sidebarCollapsed: readPreference("sidebarCollapsed", false, isBoolean),
    // Open by default only where it fits beside the conversation (it floats below 1100 px).
    panelOpen: readPreference("panelOpen", window.innerWidth >= 1200, isBoolean),
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

/** Run title from the prompt, cut by code points so emoji are never split. */
function titleFrom(text: string): string {
  const chars = Array.from(text);
  return chars.length > 60 ? `${chars.slice(0, 57).join("").trimEnd()}…` : text;
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
  profiles,
  activeProfileId,
  onSwitchProfile,
  onNewProfile,
  onManageProfiles,
  section: controlledSection,
  onNavigate,
  renderSection,
  settingsTop,
  extraCommands,
  banner,
  coreVersion,
  footer,
  streamDelayMs = 28,
  decisionDelayMs = 500,
}: AppShellProps) {
  const [state, dispatch] = useReducer(shellReducer, { profiles, activeProfileId }, initialState);
  const section = controlledSection ?? state.section;
  const runsEnabled = loadWorkspace !== undefined;
  const shellRef = useRef<HTMLDivElement>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const mounted = useRef(true);

  const profile = profiles.find((p) => p.id === state.profileId) ?? profiles[0];
  // A controlled profile id is mirrored into the reducer so runs stay per profile.
  useEffect(() => {
    if (activeProfileId !== undefined) dispatch({ type: "profile/switch", profileId: activeProfileId });
  }, [activeProfileId]);

  const switchProfile = useCallback(
    (profileId: string) => {
      if (onSwitchProfile) onSwitchProfile(profileId);
      else dispatch({ type: "profile/switch", profileId });
    },
    [onSwitchProfile],
  );

  const navigate = useCallback(
    (next: Section) => {
      dispatch({ type: "navigate", section: next });
      onNavigate?.(next);
    },
    [onNavigate],
  );

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

  const inFlight = useRef(new Set<string>());
  const [deciding, setDeciding] = useState<ReadonlySet<string>>(new Set());
  const load = useCallback(
    (profileId: string) => {
      if (!loadWorkspace) return;
      // StrictMode runs mount effects twice; never start a second load for the same profile.
      if (inFlight.current.has(profileId)) return;
      inFlight.current.add(profileId);
      dispatch({ type: "workspace/loading", profileId });
      loadWorkspace(profileId)
        .finally(() => {
          inFlight.current.delete(profileId);
        })
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
    if (runsEnabled && currentWorkspaceKind === undefined && state.profileId) load(state.profileId);
  }, [runsEnabled, currentWorkspaceKind, state.profileId, load]);

  useEffect(() => {
    const root = document.documentElement;
    if (state.theme === "system") delete root.dataset.theme;
    else root.dataset.theme = state.theme;
    writePreference("theme", state.theme);
    return () => {
      delete root.dataset.theme;
    };
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
    // Persist once the drag settles instead of on every pixel.
    const t = setTimeout(() => {
      writePreference("panelWidth", state.panelWidth);
    }, 250);
    return () => {
      clearTimeout(t);
    };
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
    ({ text, agent, model, projectId }: ComposerSubmission) => {
      const profileId = state.profileId;
      const run: Run = {
        id: nextId("run"),
        title: titleFrom(text),
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
    ({ text }: ComposerSubmission) => {
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
      if (!runId) return Promise.resolve();
      const key = `${profileId}/${runId}/${eventId}`;
      // One decision per approval, even if the card remounted while the first is in flight.
      if (deciding.has(key)) return Promise.resolve();
      setDeciding((prev) => new Set(prev).add(key));
      return new Promise<void>((resolve) => {
        later(() => {
          setDeciding((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
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
    [deciding, decisionDelayMs, later, state.activeRunId, state.profileId, streamReply],
  );

  // --- commands & shortcuts ------------------------------------------------

  const openPalette = useCallback(() => {
    dispatch({ type: "palette/set", open: true });
  }, []);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (runsEnabled) {
      list.push({
        id: "new-task",
        label: "New task",
        group: "Actions",
        icon: <Plus width={16} height={16} />,
        shortcut: shortcutLabel("n"),
        run: () => {
          dispatch({ type: "composer/focus" });
        },
      });
    }
    list.push(
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
    );
    if (onNewProfile) {
      list.push({
        id: "new-profile",
        label: "New profile…",
        group: "Actions",
        icon: <Plus width={16} height={16} />,
        keywords: "create add account",
        run: onNewProfile,
      });
    }
    for (const target of Object.keys(SECTION_LABEL) as Section[]) {
      list.push({
        id: `go-${target}`,
        label: `Go to ${SECTION_LABEL[target]}`,
        group: "Navigation",
        icon: NAV_ICONS[target],
        run: () => {
          navigate(target);
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
          switchProfile(p.id);
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
    if (extraCommands) list.push(...extraCommands);
    return list;
  }, [
    activeRun,
    extraCommands,
    navigate,
    onNewProfile,
    profiles,
    runs,
    runsEnabled,
    state.panelOpen,
    state.profileId,
    state.sidebarCollapsed,
    state.theme,
    switchProfile,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!hasModifier(event) || event.shiftKey) return;
      const key = event.key.toLowerCase();
      // While the modal palette is open, only its own toggle works.
      if (state.paletteOpen && key !== "k") return;
      if (key === "k") {
        event.preventDefault();
        dispatch({ type: "palette/set", open: !state.paletteOpen });
      } else if (key === "b") {
        event.preventDefault();
        dispatch({ type: "sidebar/toggle" });
      } else if (key === "j" && activeRun) {
        event.preventDefault();
        dispatch({ type: "panel/set", open: !state.panelOpen });
      } else if (key === "n" && runsEnabled) {
        event.preventDefault();
        dispatch({ type: "palette/set", open: false });
        dispatch({ type: "composer/focus" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [activeRun, runsEnabled, state.paletteOpen, state.panelOpen]);

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

  const custom = activeRun ? undefined : renderSection?.(section);
  let main: ReactNode;
  if (custom !== undefined) {
    main = custom;
  } else if (activeRun) {
    main = (
      <RunView
        run={activeRun}
        panelOpen={state.panelOpen}
        onTogglePanel={() => {
          dispatch({ type: "panel/set", open: !state.panelOpen });
        }}
        onDecide={decide}
        decidingIds={
          new Set(
            [...deciding]
              .filter((k) => k.startsWith(`${state.profileId}/${activeRun.id}/`))
              .map((k) => k.slice(`${state.profileId}/${activeRun.id}/`.length)),
          )
        }
        onSend={sendInRun}
        agents={AGENTS}
        models={MODELS}
      />
    );
  } else if (section === "home" && runsEnabled) {
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
  } else if (section === "settings") {
    main = (
      <SettingsView
        top={settingsTop}
        theme={state.theme}
        onThemeChange={(theme) => {
          dispatch({ type: "theme/set", theme });
        }}
        coreVersion={coreVersion}
      />
    );
  } else if (section === "home" || section === "tools" || section === "mcp") {
    main = (
      <div className="section-view">
        <div className="section-body">
          <EmptyState
            title={`${SECTION_LABEL[section]} needs the Vision core`}
            description="This section shows data from the Vision core, which is not connected here."
          />
        </div>
      </div>
    );
  } else {
    main = <SectionView section={section} />;
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
        onSwitchProfile={switchProfile}
        onNewProfile={onNewProfile}
        onManageProfiles={onManageProfiles}
        profileMenuOpen={state.profileMenuOpen}
        onProfileMenuOpenChange={(open) => {
          dispatch({ type: "profile/menu", open });
        }}
        section={section}
        activeRunId={state.activeRunId}
        onNavigate={navigate}
        onNewTask={
          runsEnabled
            ? () => {
                dispatch({ type: "composer/focus" });
              }
            : undefined
        }
        onOpenPalette={openPalette}
        workspace={runsEnabled ? workspace : null}
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
        {banner}
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
