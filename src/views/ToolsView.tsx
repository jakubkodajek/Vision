import {
  Download,
  LogIn,
  LogOut,
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
import { useEffect, useId, useState } from "react";
import { ToolStatusBadge } from "../components/badges";
import { ConfirmDialog } from "../components/ConfirmDialog";
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
export function ToolsView({ profile }: { profile: Profile }) {
  const { state, actions } = useVision();
  const [adding, setAdding] = useState(false);
  const slot = state.tools[profile.id];
  const terminal = useAsyncAction(actions.openProfileTerminal);

  useEffect(() => {
    actions.visitTools(profile.id);
  }, [actions, profile.id]);

  const list = slot?.list ?? { kind: "loading" as const };
  const anyChecking = list.kind === "ready" && list.data.some((e) => e.checking);

  return (
    <div className="section-view">
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
                disabled={list.kind !== "ready" || anyChecking}
                onClick={() => {
                  actions.checkAllTools(profile.id);
                }}
              >
                Check all
              </Button>
              <Button
                size="sm"
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

/** One tool: status, account, version, isolation and the actions that fit its status. */
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
  const headingId = useId();
  const { view, checking, sending, waiting, notice } = entry;
  const { spec, status } = view;
  const toolId = spec.id;
  const busy = checking || sending !== null || waiting !== null;
  const signedIn = status?.status === "signed_in";
  const notInstalled = status?.status === "not_installed";

  return (
    <article className="service-card" aria-labelledby={headingId} aria-busy={checking || undefined}>
      <header className="service-card-header">
        <h4 id={headingId} className="service-card-title">
          {spec.name}
        </h4>
        <span className="service-card-status">
          {checking ? (
            <span className="badge badge-neutral" role="status">
              <Spinner size={14} />
              <span>Checking…</span>
            </span>
          ) : (
            <ToolStatusBadge status={status} />
          )}
        </span>
      </header>
      {spec.description && <p className="service-card-description">{spec.description}</p>}
      <dl className="meta-list">
        <div>
          <dt>Account</dt>
          <dd className="is-truncated" title={signedIn ? (status.account ?? undefined) : undefined}>
            {signedIn
              ? status.account
                ? `Signed in as ${status.account}`
                : "Signed in (the tool did not report an account name)"
              : status === null
                ? "Not checked yet"
                : "Not signed in"}
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd className="is-truncated">{view.version ?? (notInstalled ? "Not installed" : "Unknown")}</dd>
        </div>
        <div>
          <dt>Program</dt>
          <dd className="is-truncated is-mono" title={view.binary_path ?? spec.binary}>
            {view.binary_path ?? spec.binary}
          </dd>
        </div>
      </dl>
      {signedIn && status.warning && (
        <p className="inline-warning">
          <TriangleAlert width={14} height={14} aria-hidden="true" />
          <span>{status.warning}</span>
        </p>
      )}
      {status?.status === "unknown" && (
        <p className="inline-warning">
          <TriangleAlert width={14} height={14} aria-hidden="true" />
          <span>The status command answered in an unexpected way: {status.message}</span>
        </p>
      )}
      <IsolationNote isolation={spec.isolation} />
      {waiting && (
        <div className="wait-row" role="status">
          <Spinner size={14} />
          <span>
            {waiting === "sign_in"
              ? "Waiting for sign-in in the terminal…"
              : "Waiting for sign-out in the terminal…"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              actions.cancelWait(profileId, toolId);
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {notice?.kind === "timeout" && (
        <div className="card-notice" role="status">
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
      <div className="service-card-actions">
        {notInstalled && spec.install_url && (
          <Button
            size="sm"
            variant="primary"
            icon={<Download width={14} height={14} aria-hidden="true" />}
            loading={sending === "install"}
            onClick={() => {
              actions.openInstallPage(profileId, toolId);
            }}
          >
            Install
          </Button>
        )}
        {!notInstalled && !signedIn && !waiting && (
          <Button
            size="sm"
            variant="primary"
            icon={<LogIn width={14} height={14} aria-hidden="true" />}
            loading={sending === "sign_in"}
            disabled={busy && sending !== "sign_in"}
            onClick={() => {
              actions.signIn(profileId, toolId);
            }}
          >
            Sign in
          </Button>
        )}
        {signedIn && spec.logout && !waiting && (
          <Button
            size="sm"
            icon={<LogOut width={14} height={14} aria-hidden="true" />}
            loading={sending === "sign_out"}
            disabled={busy && sending !== "sign_out"}
            onClick={() => {
              actions.signOut(profileId, toolId);
            }}
          >
            Sign out
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw width={14} height={14} aria-hidden="true" />}
          disabled={checking}
          onClick={() => {
            actions.checkTool(profileId, toolId);
          }}
        >
          Check again
        </Button>
        {!spec.builtin && (
          <Button
            size="sm"
            variant="ghost"
            className="is-danger-text push-end"
            icon={<Trash2 width={14} height={14} aria-hidden="true" />}
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            Delete
          </Button>
        )}
      </div>
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
