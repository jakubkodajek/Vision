import {
  ExternalLink,
  LogIn,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, useEffect } from "react";
import { ToolGateBadge, ToolStatusBadge } from "../components/badges";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { LiveRegion } from "../components/LiveRegion";
import { Button, EmptyState, ErrorState, Skeleton, Spinner } from "../components/primitives";
import { useVision } from "../data/context";
import { errorText } from "../data/errors";
import type { ToolEntry } from "../data/store";
import { useAsyncAction } from "../data/useAsyncAction";
import type { Platform, Profile } from "../ipc/bindings";
import { isolationLabel } from "../lib/realLabels";
import { CustomToolDialog } from "./CustomToolDialog";

const ACTION_TITLE: Record<"check" | "sign_in" | "sign_out" | "install", string> = {
  check: "Could not check the status",
  sign_in: "Could not start the sign-in",
  sign_out: "Could not start the sign-out",
  install: "Could not open the install page",
};

/** Tools of the active profile: one card per tool, sign-in and sign-out in the terminal. */
export function ToolsView({
  profile,
  request = null,
  onRequestDone,
}: {
  profile: Profile;
  /** "add-tool" from the command palette keeps the add dialog open until it closes. */
  request?: "add-tool" | null;
  onRequestDone?: () => void;
}) {
  const { state, actions } = useVision();
  const [addingHere, setAdding] = useState(false);
  const adding = addingHere || request === "add-tool";
  const slot = state.tools[profile.id];
  const terminal = useAsyncAction(actions.openProfileTerminal);

  useEffect(() => {
    actions.visitTools(profile.id);
  }, [actions, profile.id]);

  const list = slot?.list ?? { kind: "loading" as const };
  const anyChecking = list.kind === "ready" && list.data.some((e) => e.checking);

  return (
    <div className="section-view">
      <LiveRegion scope="tools" />
      <header className="view-header">
        <div className="view-header-main">
          <h2 className="view-title" tabIndex={-1} data-focus-fallback>
            Tools
          </h2>
          <p className="view-subtitle">Sign-ins for the {profile.name} profile</p>
        </div>
        <div className="view-header-actions">
          <Button
            size="sm"
            icon={<SquareTerminal width={14} height={14} aria-hidden="true" />}
            loading={terminal.busy}
            onClick={() => void terminal.run(profile.id)}
          >
            Open terminal for this profile
          </Button>
        </div>
      </header>
      <div className="page-scroll">
        <div className="page-inner">
          <p className="page-intro">
            Each tool signs in separately in every profile. Sign-in runs the tool's own command in a terminal
            window, so Vision never sees your password or token.
          </p>
          {terminal.error && (
            <ErrorState
              compact
              title="Could not open a terminal"
              message={errorText(terminal.error, state.platform)}
            />
          )}
          <div className="toolbar">
            <h3 className="section-heading">
              {list.kind === "ready" ? `${String(list.data.length)} tools` : "Tools"}
            </h3>
            <div className="toolbar-actions">
              <Button
                size="sm"
                variant="ghost"
                icon={<RefreshCw width={14} height={14} aria-hidden="true" />}
                inactive={list.kind !== "ready" || anyChecking}
                onClick={() => {
                  actions.checkAllTools(profile.id);
                }}
              >
                Check all
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Plus width={14} height={14} aria-hidden="true" />}
                onClick={() => {
                  setAdding(true);
                }}
              >
                Add custom tool
              </Button>
            </div>
          </div>
          {list.kind === "loading" && (
            <ul className="card-grid" aria-busy="true" aria-label="Loading tools">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className="service-card is-loading">
                  <Skeleton width="medium" />
                  <Skeleton width="wide" />
                  <Skeleton width="short" />
                </li>
              ))}
            </ul>
          )}
          {list.kind === "error" && (
            <ErrorState
              title="Could not load the tools"
              message={errorText(list.error, state.platform)}
              onRetry={() => {
                actions.reloadTools(profile.id);
              }}
            />
          )}
          {list.kind === "ready" && list.data.length === 0 && (
            <EmptyState title="No tools" description="Add a custom tool to sign in to it per profile." />
          )}
          {list.kind === "ready" && list.data.length > 0 && (
            <ul className="card-grid">
              {list.data.map((entry) => (
                <li key={entry.view.spec.id}>
                  <ToolCard profileId={profile.id} entry={entry} platform={state.platform} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {adding && (
        <CustomToolDialog
          onClose={() => {
            setAdding(false);
            onRequestDone?.();
          }}
        />
      )}
    </div>
  );
}

function IsolationNote({ isolation }: { isolation: ToolEntry["view"]["spec"]["isolation"] }) {
  const Icon =
    isolation === "verified" ? ShieldCheck : isolation === "unverified" ? ShieldQuestion : ShieldAlert;
  return (
    <p className={`isolation-note is-${isolation}`}>
      <Icon width={14} height={14} aria-hidden="true" />
      <span>{isolationLabel(isolation)}</span>
    </p>
  );
}

const ICON = { width: 14, height: 14, "aria-hidden": true } as const;

/**
 * One tool: status, account, version, isolation and the actions that fit its status. A
 * custom tool that is not approved is never run by Vision on its own: it shows "Needs your
 * approval to run" and a Check button; an invalid one shows why and offers Edit and Delete.
 * Busy buttons stay focusable (`aria-disabled`); when the wait row appears or goes, focus
 * moves to its Stop button or to the card's first action instead of falling to the page.
 */
export function ToolCard({
  profileId,
  entry,
  platform,
}: {
  profileId: string;
  entry: ToolEntry;
  platform: Platform | null;
}) {
  const { actions } = useVision();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const { view, checking, sending, waiting, notice } = entry;
  const { spec, status } = view;
  const toolId = spec.id;
  const busy = checking || sending !== null || waiting !== null;
  const signedIn = status?.status === "signed_in";
  const notInstalled = status?.status === "not_installed";
  const invalid = spec.invalid !== null;
  const needsApproval = !invalid && !spec.approved;

  // Keep focus in the card when the control that had it is replaced by the wait row or back.
  const previousWaiting = useRef(waiting);
  useLayoutEffect(() => {
    const was = previousWaiting.current;
    previousWaiting.current = waiting;
    if (was === waiting) return;
    const active = document.activeElement;
    const lost = active === null || active === document.body || !active.isConnected;
    if (!lost && !cardRef.current?.contains(active)) return;
    if (waiting) stopRef.current?.focus();
    else actionsRef.current?.querySelector<HTMLElement>(".btn-primary, .btn")?.focus();
  });

  return (
    <article
      ref={cardRef}
      className="service-card"
      aria-labelledby={headingId}
      aria-busy={checking || undefined}
    >
      <header className="service-card-header">
        <h4 id={headingId} className="service-card-title">
          {spec.name}
        </h4>
        <span className="service-card-status">
          {checking ? (
            <span className="badge badge-neutral">
              <Spinner size={14} />
              <span>Checking…</span>
            </span>
          ) : invalid ? (
            <ToolGateBadge kind="invalid" />
          ) : needsApproval && status === null ? (
            <ToolGateBadge kind="approval" />
          ) : (
            <ToolStatusBadge status={status} />
          )}
        </span>
      </header>
      {spec.description && <p className="service-card-description">{spec.description}</p>}
      <dl className="meta-list">
        {signedIn && (
          <div>
            <dt>Account</dt>
            <dd className="is-wrap">
              {status.account
                ? `Signed in as ${status.account}`
                : "Signed in (the tool did not report an account name)"}
            </dd>
          </div>
        )}
        {view.version !== null && !notInstalled && (
          <div>
            <dt>Version</dt>
            <dd className="is-wrap">{view.version}</dd>
          </div>
        )}
        <div>
          <dt>Program</dt>
          <dd className="is-wrap is-mono">{view.binary_path ?? spec.binary}</dd>
        </div>
      </dl>
      {invalid && (
        <p className="inline-warning">
          <TriangleAlert {...ICON} />
          <span>
            This tool's definition is no longer accepted: {spec.invalid} Edit it to fix it, or delete it.
          </span>
        </p>
      )}
      {needsApproval && (
        <p className="inline-note">
          <ShieldQuestion {...ICON} />
          <span>
            Vision runs this tool's commands only after you confirm them. Select Check to see the command and
            allow it.
          </span>
        </p>
      )}
      {signedIn && status.warning && (
        <p className="inline-warning">
          <TriangleAlert {...ICON} />
          <span>{status.warning}</span>
        </p>
      )}
      {status?.status === "unknown" && (
        <p className="inline-warning">
          <TriangleAlert {...ICON} />
          <span>The status command answered in an unexpected way: {status.message}</span>
        </p>
      )}
      <IsolationNote isolation={spec.isolation} />
      {waiting && (
        <div className="wait-row">
          <p className="wait-row-text">
            <Spinner size={14} />
            <span>
              {waiting === "sign_in"
                ? "A terminal window opened. Finish signing in there; Vision checks every few seconds."
                : "A terminal window opened. Finish signing out there; Vision checks every few seconds."}
            </span>
          </p>
          <div className="wait-row-actions">
            <Button
              size="sm"
              icon={<SquareTerminal {...ICON} />}
              loading={sending === waiting}
              onClick={() => {
                if (waiting === "sign_in") actions.signIn(profileId, toolId);
                else actions.signOut(profileId, toolId);
              }}
            >
              Open terminal again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw {...ICON} />}
              loading={checking}
              onClick={() => {
                actions.checkTool(profileId, toolId);
              }}
            >
              Check now
            </Button>
            <Button
              ref={stopRef}
              size="sm"
              variant="ghost"
              icon={<X {...ICON} />}
              onClick={() => {
                actions.cancelWait(profileId, toolId);
              }}
            >
              Stop waiting
            </Button>
          </div>
        </div>
      )}
      {notice?.kind === "timeout" && (
        <div className="card-notice">
          <p>
            {notice.wait === "sign_in"
              ? "No sign-in was detected within 10 minutes. If you finished signing in, select Check again."
              : "No sign-out was detected within 2 minutes. If you finished signing out, select Check again."}
          </p>
          <DismissButton
            onClick={() => {
              actions.dismissNotice(profileId, toolId);
            }}
          />
        </div>
      )}
      {notice?.kind === "declined" && (
        <div className="card-notice">
          <p>You declined to run this command. Nothing was run.</p>
          <DismissButton
            onClick={() => {
              actions.dismissNotice(profileId, toolId);
            }}
          />
        </div>
      )}
      {notice?.kind === "error" && (
        <div className="card-notice is-error" role="alert">
          <div>
            <p className="card-notice-title">{ACTION_TITLE[notice.action]}</p>
            <p>{errorText(notice.error, platform)}</p>
          </div>
          <DismissButton
            onClick={() => {
              actions.dismissNotice(profileId, toolId);
            }}
          />
        </div>
      )}
      <div ref={actionsRef} className="service-card-actions">
        {!invalid && !needsApproval && notInstalled && spec.install_url && (
          <Button
            size="sm"
            variant="primary"
            icon={<ExternalLink {...ICON} />}
            loading={sending === "install"}
            inactive={busy && sending !== "install"}
            onClick={() => {
              actions.openInstallPage(profileId, toolId);
            }}
          >
            Get installer
            <span className="visually-hidden">, opens the official install page in your browser</span>
          </Button>
        )}
        {!invalid && !needsApproval && !notInstalled && !signedIn && !waiting && (
          <Button
            size="sm"
            variant="primary"
            icon={<LogIn {...ICON} />}
            loading={sending === "sign_in"}
            inactive={busy && sending !== "sign_in"}
            onClick={() => {
              actions.signIn(profileId, toolId);
            }}
          >
            Sign in
          </Button>
        )}
        {!invalid && !needsApproval && signedIn && spec.logout && !waiting && (
          <Button
            size="sm"
            icon={<LogOut {...ICON} />}
            loading={sending === "sign_out"}
            inactive={busy && sending !== "sign_out"}
            onClick={() => {
              actions.signOut(profileId, toolId);
            }}
          >
            Sign out
          </Button>
        )}
        {!invalid && !waiting && (
          <Button
            size="sm"
            variant={needsApproval ? "primary" : "ghost"}
            icon={<RefreshCw {...ICON} />}
            loading={checking}
            inactive={busy && !checking}
            onClick={() => {
              actions.checkTool(profileId, toolId);
            }}
          >
            {needsApproval ? "Check" : "Check again"}
          </Button>
        )}
        {!spec.builtin && (
          <Button
            size="sm"
            variant={invalid ? "primary" : "ghost"}
            className="push-end"
            icon={<Pencil {...ICON} />}
            inactive={sending !== null || waiting !== null}
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
        {!spec.builtin && (
          <Button
            size="sm"
            variant="ghost"
            className="is-danger-text"
            icon={<Trash2 {...ICON} />}
            inactive={sending !== null || waiting !== null}
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            Delete
          </Button>
        )}
      </div>
      {editing && (
        <CustomToolDialog
          tool={spec}
          onClose={() => {
            setEditing(false);
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${spec.name}?`}
          description="The custom tool is removed from every profile. Its sign-in files in each profile folder stay until the profile is deleted. Sign out first if you want to end those sessions."
          confirmLabel="Delete tool"
          errorTitle="Could not delete the tool"
          platform={platform}
          onConfirm={() => actions.deleteCustomTool(toolId)}
          onClose={() => {
            setConfirmDelete(false);
          }}
        />
      )}
    </article>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn-sm"
      aria-label="Dismiss"
      title="Dismiss"
      onClick={onClick}
    >
      <X width={14} height={14} aria-hidden="true" />
    </button>
  );
}
