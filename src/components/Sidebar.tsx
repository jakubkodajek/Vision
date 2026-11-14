import {
  BookOpen,
  Bot,
  FolderGit2,
  House,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx";
import { shortcutLabel } from "../lib/platform";
import type { LoadState, Profile, Run, Section, TreeNode, Workspace } from "../types";
import { ErrorState, IconButton, Kbd, LogoMark, RunStatusBadge, Skeleton, EmptyState } from "./primitives";
import { ProfileSwitcher } from "./ProfileSwitcher";
import { Tree } from "./Tree";

const NAV: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "home", label: "Home", icon: <House width={16} height={16} aria-hidden="true" /> },
  { id: "projects", label: "Projects", icon: <FolderGit2 width={16} height={16} aria-hidden="true" /> },
  { id: "agents", label: "Agents", icon: <Bot width={16} height={16} aria-hidden="true" /> },
  { id: "tasks", label: "Tasks", icon: <ListChecks width={16} height={16} aria-hidden="true" /> },
  { id: "knowledge", label: "Knowledge", icon: <BookOpen width={16} height={16} aria-hidden="true" /> },
  { id: "settings", label: "Settings", icon: <Settings width={16} height={16} aria-hidden="true" /> },
];

export interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  profiles: readonly Profile[];
  activeProfileId: string;
  onSwitchProfile: (id: string) => void;
  profileMenuOpen: boolean;
  onProfileMenuOpenChange: (open: boolean) => void;
  section: Section;
  /** Highlighted nav entry only applies when no run is open. */
  activeRunId: string | null;
  onNavigate: (section: Section) => void;
  onNewTask: () => void;
  onOpenPalette: () => void;
  workspace: LoadState<Workspace>;
  onRetryWorkspace: () => void;
  expanded: ReadonlySet<string>;
  onToggleNode: (id: string) => void;
  onOpenRun: (runId: string) => void;
  footer?: ReactNode;
}

/** Left sidebar: profile switcher, primary navigation, project tree and recent runs. */
export function Sidebar(props: SidebarProps) {
  const {
    collapsed,
    onToggleCollapsed,
    section,
    activeRunId,
    onNavigate,
    onNewTask,
    onOpenPalette,
    workspace,
    footer,
  } = props;

  return (
    <nav className={cx("sidebar", collapsed && "is-collapsed")} aria-label="Sidebar">
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <LogoMark size={26} />
          <h1 className={cx("sidebar-wordmark", collapsed && "visually-hidden")}>Vision</h1>
          <IconButton
            label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            shortcut={shortcutLabel("b")}
            size="sm"
            className="sidebar-toggle"
            onClick={onToggleCollapsed}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <PanelLeftOpen width={16} height={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose width={16} height={16} aria-hidden="true" />
            )}
          </IconButton>
        </div>
        <ProfileSwitcher
          profiles={props.profiles}
          activeId={props.activeProfileId}
          onSwitch={props.onSwitchProfile}
          open={props.profileMenuOpen}
          onOpenChange={props.onProfileMenuOpenChange}
          collapsed={collapsed}
        />
        <div className="sidebar-actions">
          <button
            type="button"
            className="sidebar-new-task"
            onClick={onNewTask}
            title={collapsed ? `New task (${shortcutLabel("n")})` : undefined}
            aria-label={collapsed ? "New task" : undefined}
          >
            <Plus width={16} height={16} aria-hidden="true" />
            {!collapsed && (
              <>
                <span>New task</span>
                <Kbd>{shortcutLabel("n")}</Kbd>
              </>
            )}
          </button>
          <button
            type="button"
            className="sidebar-search"
            onClick={onOpenPalette}
            title={collapsed ? `Search (${shortcutLabel("k")})` : undefined}
            aria-label={collapsed ? "Search" : undefined}
          >
            <Search width={16} height={16} aria-hidden="true" />
            {!collapsed && (
              <>
                <span>Search</span>
                <Kbd>{shortcutLabel("k")}</Kbd>
              </>
            )}
          </button>
        </div>
        <ul className="sidebar-nav">
          {NAV.map((item) => {
            const current = activeRunId === null && section === item.id;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={cx("nav-item", current && "is-current")}
                  aria-current={current ? "page" : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  title={collapsed ? item.label : undefined}
                  onClick={() => {
                    onNavigate(item.id);
                  }}
                >
                  {item.icon}
                  {!collapsed && <span>{item.label}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {!collapsed && (
        <div className="sidebar-scroll">
          <SidebarContent {...props} workspace={workspace} />
        </div>
      )}
      {footer && <div className={cx("sidebar-footer", collapsed && "is-collapsed")}>{footer}</div>}
    </nav>
  );
}

function SidebarContent({
  workspace,
  onRetryWorkspace,
  expanded,
  onToggleNode,
  onOpenRun,
  activeRunId,
  onNewTask,
}: SidebarProps) {
  if (workspace.kind === "loading") {
    return (
      <div className="sidebar-section" aria-busy="true" aria-label="Loading projects">
        <p className="sidebar-heading">Projects</p>
        <div className="sidebar-skeletons">
          <Skeleton width="wide" />
          <Skeleton width="medium" />
          <Skeleton width="wide" />
          <Skeleton width="short" />
        </div>
      </div>
    );
  }
  if (workspace.kind === "error") {
    return (
      <div className="sidebar-section">
        <ErrorState
          compact
          title="Could not load projects"
          message={workspace.message}
          onRetry={onRetryWorkspace}
        />
      </div>
    );
  }
  const { projects, runs } = workspace.data;
  const recent = [...runs].slice(0, 6);
  const selectNode = (node: TreeNode) => {
    if (node.runId) onOpenRun(node.runId);
  };
  return (
    <>
      <section className="sidebar-section" aria-labelledby="sidebar-projects-heading">
        <h2 id="sidebar-projects-heading" className="sidebar-heading">
          Projects
        </h2>
        {projects.length === 0 ? (
          <EmptyState compact title="No projects yet" description="Add a repository to start a task." />
        ) : (
          <Tree
            label="Projects"
            nodes={projects}
            expanded={expanded}
            selectedId={findNodeIdForRun(projects, activeRunId)}
            onToggle={onToggleNode}
            onSelect={selectNode}
          />
        )}
      </section>
      <section className="sidebar-section" aria-labelledby="sidebar-recent-heading">
        <h2 id="sidebar-recent-heading" className="sidebar-heading">
          Recent runs
        </h2>
        {recent.length === 0 ? (
          <EmptyState
            compact
            title="No runs yet"
            action={
              <button type="button" className="link-button" onClick={onNewTask}>
                Start a task
              </button>
            }
          />
        ) : (
          <ul className="recent-list">
            {recent.map((run: Run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className={cx("recent-item", run.id === activeRunId && "is-current")}
                  aria-current={run.id === activeRunId ? "page" : undefined}
                  onClick={() => {
                    onOpenRun(run.id);
                  }}
                >
                  <RunStatusBadge status={run.status} compact />
                  <span className="recent-title">{run.title}</span>
                  <span className="recent-time">{run.updated}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function findNodeIdForRun(nodes: TreeNode[], runId: string | null): string | null {
  if (!runId) return null;
  for (const node of nodes) {
    if (node.runId === runId) return node.id;
    const found = findNodeIdForRun(node.children ?? [], runId);
    if (found) return found;
  }
  return null;
}
