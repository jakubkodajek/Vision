import { ChevronRight, KeyRound, Pencil, Plus, RefreshCw, Trash2, UploadCloud, Zap } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { McpHealthBadge } from "../components/badges";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Dialog } from "../components/Dialog";
import { Button, EmptyState, ErrorState, Skeleton, Spinner } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { McpServerView, Platform, Profile, SyncReport } from "../ipc/bindings";
import { cx } from "../lib/cx";
import { serverToInput } from "../lib/mcp";
import { plural, transportLabel, transportTarget } from "../lib/realLabels";
import { McpServerDialog } from "./McpServerDialog";

type Editing = { kind: "add" } | { kind: "edit"; server: McpServerView } | null;

/** MCP servers of the active profile. */
export function McpView({ profile }: { profile: Profile }) {
  const { state, actions } = useVision();
  const [editing, setEditing] = useState<Editing>(null);
  const [syncing, setSyncing] = useState(false);
  const slot = state.mcp[profile.id] ?? { kind: "loading" as const };

  useEffect(() => {
    actions.ensureMcp(profile.id);
    actions.ensureTools(profile.id);
  }, [actions, profile.id]);

  const toolNames = new Map<string, string>();
  const tools = state.tools[profile.id];
  if (tools?.list.kind === "ready")
    for (const e of tools.list.data) toolNames.set(e.view.spec.id, e.view.spec.name);

  return (
    <div className="section-view">
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title" tabIndex={-1} data-focus-fallback>
            MCP servers
          </h2>
          <p className="view-subtitle">Servers of the {profile.name} profile</p>
        </div>
        <div className="view-header-actions">
          <Button
            size="sm"
            icon={<UploadCloud width={14} height={14} aria-hidden="true" />}
            disabled={slot.kind !== "ready"}
            onClick={() => {
              setSyncing(true);
            }}
          >
            Sync to Claude Code
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus width={14} height={14} aria-hidden="true" />}
            onClick={() => {
              setEditing({ kind: "add" });
            }}
          >
            Add server
          </Button>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-inner">
          <p className="page-intro">
            MCP servers give agents extra tools, such as file access or an issue tracker. Each profile has its
            own servers and secret values.
          </p>
          {slot.kind === "loading" && (
            <ul className="server-list" aria-busy="true" aria-label="Loading MCP servers">
              {[0, 1].map((i) => (
                <li key={i} className="server-row is-loading">
                  <Skeleton width="medium" />
                  <Skeleton width="wide" />
                </li>
              ))}
            </ul>
          )}
          {slot.kind === "error" && (
            <ErrorState
              title="Could not load the MCP servers"
              message={errorText(slot.error, state.platform)}
              onRetry={() => {
                actions.reloadMcp(profile.id);
              }}
            />
          )}
          {slot.kind === "ready" && slot.data.length === 0 && (
            <EmptyState
              icon={<Zap width={28} height={28} />}
              title="No MCP servers yet"
              description="Add a local command (stdio) or a remote server (HTTP). Test it to see which tools it offers."
              action={
                <Button
                  variant="primary"
                  icon={<Plus width={14} height={14} aria-hidden="true" />}
                  onClick={() => {
                    setEditing({ kind: "add" });
                  }}
                >
                  Add server
                </Button>
              }
            />
          )}
          {slot.kind === "ready" && slot.data.length > 0 && (
            <ul className="server-list">
              {slot.data.map((server) => (
                <li key={server.id}>
                  <ServerRow
                    profileId={profile.id}
                    server={server}
                    platform={state.platform}
                    toolNames={toolNames}
                    onEdit={() => {
                      setEditing({ kind: "edit", server });
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {editing && (
        <McpServerDialog
          profileId={profile.id}
          server={editing.kind === "edit" ? editing.server : undefined}
          onClose={() => {
            setEditing(null);
          }}
        />
      )}
      {syncing && (
        <SyncDialog
          profile={profile}
          platform={state.platform}
          onClose={() => {
            setSyncing(false);
          }}
        />
      )}
    </div>
  );
}

/** One server: health, tools, enabled switch and actions. */
export function ServerRow({
  profileId,
  server,
  platform,
  toolNames,
  onEdit,
}: {
  profileId: string;
  server: McpServerView;
  platform: Platform | null;
  toolNames: ReadonlyMap<string, string>;
  onEdit: () => void;
}) {
  const { actions } = useVision();
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const headingId = useId();
  const toolsId = useId();
  const test = useAsyncAction(() => actions.testServer(profileId, server.id));
  const toggle = useAsyncAction((enabled: boolean) =>
    actions.saveServer(profileId, serverToInput(server, { enabled })),
  );
  const authorize = useAsyncAction(() => actions.authorizeServer(profileId, server.id));
  const { health } = server;
  const tested = health.status !== "untested";
  const isHttp = server.transport.kind === "http";
  const error = test.error ?? toggle.error ?? authorize.error;
  const errorTitle = test.error
    ? "Could not run the test"
    : toggle.error
      ? "Could not change the server"
      : "Could not open the authorization";
  const logins = server.tool_ids.map((id) => toolNames.get(id) ?? id);

  return (
    <article className={cx("server-row", !server.enabled && "is-disabled")} aria-labelledby={headingId}>
      <div className="server-main">
        <div className="server-heading">
          <h3 id={headingId} className="server-name">
            {server.name}
          </h3>
          <span className="server-transport">{transportLabel(server)}</span>
          {test.busy ? (
            <span className="badge badge-neutral" role="status">
              <Spinner size={14} />
              <span>Testing…</span>
            </span>
          ) : (
            <McpHealthBadge status={health.status} />
          )}
          {health.status === "ok" && (
            <span className="server-tool-count">{plural(health.tools.length, "tool")}</span>
          )}
        </div>
        <p className="server-target" title={transportTarget(server)}>
          {transportTarget(server)}
        </p>
        {logins.length > 0 && <p className="server-logins">Uses sign-ins of {logins.join(", ")}</p>}
        {health.message && (health.status === "error" || health.status === "needs_auth") && (
          <p className={cx("server-health-message", health.status === "error" && "is-error")}>
            {health.message}
          </p>
        )}
        {health.status === "needs_auth" && isHttp && (
          <p className="server-health-message">
            Sync to Claude Code first, then select Authorize to sign in to the server in your terminal.
          </p>
        )}
        {authorized && (
          <p className="server-health-message" role="status">
            Authorization opened in your terminal. Test the server again when you have finished.
          </p>
        )}
        {error && <ErrorState compact title={errorTitle} message={errorText(error, platform)} />}
      </div>
      <div className="server-side">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={server.enabled}
            disabled={toggle.busy}
            aria-describedby={headingId}
            onChange={(e) => void toggle.run(e.target.checked)}
          />
          <span className="switch-track" aria-hidden="true" />
          <span>Enabled</span>
        </label>
        <div className="server-actions">
          <Button
            size="sm"
            icon={<RefreshCw width={14} height={14} aria-hidden="true" />}
            loading={test.busy}
            aria-describedby={headingId}
            onClick={() => void test.run()}
          >
            Test
          </Button>
          {isHttp && (
            <Button
              size="sm"
              variant={health.status === "needs_auth" ? "primary" : "secondary"}
              icon={<KeyRound width={14} height={14} aria-hidden="true" />}
              loading={authorize.busy}
              aria-describedby={headingId}
              onClick={() =>
                void authorize.run().then((r) => {
                  if (r.ok) setAuthorized(true);
                })
              }
            >
              Authorize
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil width={14} height={14} aria-hidden="true" />}
            aria-label={`Edit ${server.name}`}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="is-danger-text"
            icon={<Trash2 width={14} height={14} aria-hidden="true" />}
            aria-label={`Delete ${server.name}`}
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {tested && health.tools.length > 0 && (
        <div className="server-tools">
          <button
            type="button"
            className="disclosure"
            aria-expanded={expanded}
            aria-controls={toolsId}
            onClick={() => {
              setExpanded((v) => !v);
            }}
          >
            <ChevronRight
              className={cx("disclosure-chevron", expanded && "is-open")}
              width={14}
              height={14}
              aria-hidden="true"
            />
            <span>
              {expanded ? "Hide tools" : "Show tools"} ({String(health.tools.length)})
            </span>
          </button>
          <ul id={toolsId} className="mcp-tool-list" hidden={!expanded}>
            {health.tools.map((tool) => (
              <li key={tool.name}>
                <code className="mcp-tool-name">{tool.name}</code>
                {/* Untrusted text from the server: rendered as a text node, never as HTML. */}
                {tool.description && <p className="mcp-tool-description">{tool.description}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${server.name}?`}
          description="The server and its secret values are removed from this profile. If you synced it to Claude Code, sync again to remove it there too."
          confirmLabel="Delete server"
          errorTitle="Could not delete the server"
          platform={platform}
          onConfirm={() => actions.deleteServer(profileId, server.id)}
          onClose={() => {
            setConfirmDelete(false);
          }}
        />
      )}
    </article>
  );
}

function SyncResult({ report }: { report: SyncReport }) {
  const nothing = report.synced.length === 0 && report.removed.length === 0 && report.failed.length === 0;
  return (
    <div className="sync-result" role="status">
      {nothing && <p>There was nothing to sync: no server is enabled and none was synced before.</p>}
      {report.synced.length > 0 && (
        <div className="sync-group">
          <h3 className="sync-heading">Synced ({String(report.synced.length)})</h3>
          <p className="is-mono">{report.synced.join(", ")}</p>
        </div>
      )}
      {report.removed.length > 0 && (
        <div className="sync-group">
          <h3 className="sync-heading">Removed from Claude Code ({String(report.removed.length)})</h3>
          <p className="is-mono">{report.removed.join(", ")}</p>
        </div>
      )}
      {report.failed.length > 0 && (
        <div className="sync-group is-error">
          <h3 className="sync-heading">Failed ({String(report.failed.length)})</h3>
          <ul>
            {report.failed.map((f) => (
              <li key={f.name}>
                <span className="is-mono">{f.name}</span>: {f.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Confirms the sync (it writes secret values into Claude Code's config), then shows the result. */
export function SyncDialog({
  profile,
  platform,
  onClose,
}: {
  profile: Profile;
  platform: Platform | null;
  onClose: () => void;
}) {
  const { actions } = useVision();
  const sync = useAsyncAction(() => actions.syncClaude(profile.id));
  const [report, setReport] = useState<SyncReport | null>(null);
  return (
    <Dialog
      title="Sync to Claude Code"
      description={`Writes the enabled MCP servers of ${profile.name} into this profile's Claude Code configuration.`}
      onClose={onClose}
      size="sm"
      dismissible={!sync.busy}
    >
      <div className="dialog-form">
        <div className="dialog-content">
          {report ? (
            <SyncResult report={report} />
          ) : (
            <>
              <p className="dialog-text">
                Secret values are written into that Claude Code configuration, because Claude Code keeps
                server settings in its own config file. Servers that Vision synced before and that are now
                disabled or deleted are removed there.
              </p>
              {sync.error && (
                <ErrorState compact title="Could not sync" message={errorText(sync.error, platform)} />
              )}
            </>
          )}
        </div>
        <div className="dialog-footer">
          {report ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={onClose} disabled={sync.busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                loading={sync.busy}
                onClick={() =>
                  void sync.run().then((r) => {
                    if (r.ok) setReport(r.value);
                  })
                }
              >
                Sync now
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
