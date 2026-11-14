import { ArrowRight, BookOpen, Bot, FolderGit2, ListChecks, Plug, Wrench } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { ErrorState, Skeleton } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import type { Profile } from "../ipc/bindings";
import { plural, profileKindLabel } from "../lib/realLabels";
import type { Section } from "../types";

const LATER: { title: string; icon: ReactNode; text: string }[] = [
  {
    title: "Projects",
    icon: <FolderGit2 width={16} height={16} aria-hidden="true" />,
    text: "Local repositories and their tasks.",
  },
  {
    title: "Agents",
    icon: <Bot width={16} height={16} aria-hidden="true" />,
    text: "Agent templates and your versions of them.",
  },
  {
    title: "Tasks",
    icon: <ListChecks width={16} height={16} aria-hidden="true" />,
    text: "Runs, status and approvals across projects.",
  },
  {
    title: "Knowledge",
    icon: <BookOpen width={16} height={16} aria-hidden="true" />,
    text: "Project memory that agents read first.",
  },
];

/** Home: what is set up in the active profile and what to do next. */
export function OverviewHome({
  profile,
  onNavigate,
}: {
  profile: Profile;
  onNavigate: (section: Section) => void;
}) {
  const { state, actions } = useVision();
  useEffect(() => {
    actions.ensureTools(profile.id);
    actions.ensureMcp(profile.id);
  }, [actions, profile.id]);

  const tools = state.tools[profile.id]?.list ?? { kind: "loading" as const };
  const mcp = state.mcp[profile.id] ?? { kind: "loading" as const };

  const toolEntries = tools.kind === "ready" ? tools.data : [];
  const signedIn = toolEntries.filter((e) => e.view.status?.status === "signed_in");
  const unchecked = toolEntries.filter((e) => e.view.status === null).length;
  const servers = mcp.kind === "ready" ? mcp.data : [];
  const working = servers.filter((s) => s.health.status === "ok").length;
  const needsAttention = servers.filter(
    (s) => s.health.status === "error" || s.health.status === "needs_auth",
  ).length;
  const untested = servers.filter((s) => s.health.status === "untested").length;

  const steps: {
    key: string;
    text: string;
    section: Section;
    action: string;
  }[] = [];
  if (tools.kind === "ready" && signedIn.length === 0)
    steps.push({
      key: "sign-in",
      text: "Sign in to Claude Code or Codex so agents can run with this profile's account.",
      section: "tools",
      action: "Open Tools",
    });
  if (tools.kind === "ready" && unchecked > 0)
    steps.push({
      key: "check",
      text: `${plural(unchecked, "tool")} not checked yet in this profile.`,
      section: "tools",
      action: "Check in Tools",
    });
  if (mcp.kind === "ready" && servers.length === 0)
    steps.push({
      key: "mcp",
      text: "Add an MCP server to give agents extra tools, such as file access or an issue tracker.",
      section: "mcp",
      action: "Add a server",
    });
  if (mcp.kind === "ready" && (needsAttention > 0 || untested > 0))
    steps.push({
      key: "mcp-test",
      text:
        needsAttention > 0
          ? `${plural(needsAttention, "MCP server")} need${needsAttention === 1 ? "s" : ""} attention.`
          : `${plural(untested, "MCP server")} not tested yet.`,
      section: "mcp",
      action: "Open MCP servers",
    });

  return (
    <div className="section-view">
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title">Home</h2>
          <p className="view-subtitle">
            {profile.name} · {profileKindLabel(profile.kind)}
          </p>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-inner">
          <div className="overview-grid">
            <section className="overview-card" aria-labelledby="overview-tools">
              <h3 id="overview-tools" className="overview-card-title">
                <Wrench width={16} height={16} aria-hidden="true" />
                Tools
              </h3>
              {tools.kind === "loading" && <Skeleton width="medium" />}
              {tools.kind === "error" && (
                <ErrorState
                  compact
                  title="Could not load the tools"
                  message={errorText(tools.error, state.platform)}
                  onRetry={() => {
                    actions.reloadTools(profile.id);
                  }}
                />
              )}
              {tools.kind === "ready" && (
                <>
                  <p className="overview-figure">
                    {String(signedIn.length)} of {String(toolEntries.length)} signed in
                  </p>
                  <p className="overview-detail is-truncated">
                    {signedIn.length > 0
                      ? signedIn.map((e) => e.view.spec.name).join(", ")
                      : "No tool is signed in yet."}
                  </p>
                </>
              )}
              <button
                type="button"
                className="overview-link"
                onClick={() => {
                  onNavigate("tools");
                }}
              >
                Open Tools
                <ArrowRight width={14} height={14} aria-hidden="true" />
              </button>
            </section>
            <section className="overview-card" aria-labelledby="overview-mcp">
              <h3 id="overview-mcp" className="overview-card-title">
                <Plug width={16} height={16} aria-hidden="true" />
                MCP servers
              </h3>
              {mcp.kind === "loading" && <Skeleton width="medium" />}
              {mcp.kind === "error" && (
                <ErrorState
                  compact
                  title="Could not load the MCP servers"
                  message={errorText(mcp.error, state.platform)}
                  onRetry={() => {
                    actions.reloadMcp(profile.id);
                  }}
                />
              )}
              {mcp.kind === "ready" && (
                <>
                  <p className="overview-figure">{plural(servers.length, "server")}</p>
                  <p className="overview-detail">
                    {servers.length === 0
                      ? "None added yet."
                      : [
                          `${String(working)} working`,
                          needsAttention > 0 ? `${String(needsAttention)} need attention` : null,
                          untested > 0 ? `${String(untested)} not tested` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                  </p>
                </>
              )}
              <button
                type="button"
                className="overview-link"
                onClick={() => {
                  onNavigate("mcp");
                }}
              >
                Open MCP servers
                <ArrowRight width={14} height={14} aria-hidden="true" />
              </button>
            </section>
          </div>
          <section className="overview-section" aria-labelledby="overview-next">
            <h3 id="overview-next" className="section-heading">
              Next steps
            </h3>
            {steps.length === 0 ? (
              <p className="overview-detail">
                {tools.kind === "ready" && mcp.kind === "ready"
                  ? "This profile is set up. Agent runs arrive in a later version."
                  : "Loading…"}
              </p>
            ) : (
              <ol className="next-steps">
                {steps.map((step) => (
                  <li key={step.key}>
                    <span>{step.text}</span>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        onNavigate(step.section);
                      }}
                    >
                      {step.action}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section className="overview-section" aria-labelledby="overview-later">
            <h3 id="overview-later" className="section-heading">
              Not available yet
            </h3>
            <ul className="later-grid">
              {LATER.map((item) => (
                <li key={item.title} className="later-item">
                  <span className="later-icon">{item.icon}</span>
                  <span className="later-text">
                    <span className="later-title">{item.title}</span>
                    <span className="later-description">{item.text}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
