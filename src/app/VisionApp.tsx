import { SquareTerminal, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../components/Dialog";
import { Button, Spinner } from "../components/primitives";
import { useClient } from "../data/useClient";
import { useVision } from "../data/context";
import { asIpcError, errorText, type VisionIpcError } from "../data/errors";
import type { AppInfo, Profile } from "../ipc/bindings";
import type { Command } from "../lib/commands";
import { profileKindLabel } from "../lib/realLabels";
import { AppShell } from "../shell/AppShell";
import type { Profile as ShellProfile, Section } from "../types";
import { McpView } from "../views/McpView";
import { OverviewHome } from "../views/OverviewHome";
import { ProfileCreateForm } from "../views/ProfileCreateForm";
import { ProfilesSettings } from "../views/ProfilesSettings";
import { StartupError, StartupLoading, WelcomeView } from "../views/StartupViews";
import { ToolsView } from "../views/ToolsView";

type CoreInfo = { kind: "pending" } | { kind: "ready"; info: AppInfo } | { kind: "error" };

function CoreStatus({ status }: { status: CoreInfo }) {
  return (
    <div className="core-status">
      {status.kind === "pending" && (
        <p className="core-status-line" role="status">
          <Spinner size={12} />
          <span>Connecting to core...</span>
        </p>
      )}
      {status.kind === "ready" && (
        <p className="core-status-line">
          <span className="core-dot is-ok" aria-hidden="true" />
          <span>Core {status.info.version}</span>
        </p>
      )}
      {status.kind === "error" && (
        <p className="core-status-line is-error" role="alert">
          <span className="core-dot is-error" aria-hidden="true" />
          <span>Could not reach the Vision core.</span>
        </p>
      )}
    </div>
  );
}

function useCoreInfo(): CoreInfo {
  const client = useClient();
  const [info, setInfo] = useState<CoreInfo>({ kind: "pending" });
  useEffect(() => {
    let active = true;
    client
      .appInfo()
      .then((value) => {
        if (active) setInfo({ kind: "ready", info: value });
      })
      .catch(() => {
        if (active) setInfo({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, [client]);
  return info;
}

function NewProfileDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (profile: Profile) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      title="New profile"
      description="A profile has its own tool sign-ins and MCP servers."
      onClose={onClose}
      initialFocus={nameRef}
    >
      <div className="dialog-content">
        <ProfileCreateForm
          nameRef={nameRef}
          defaultKind="personal"
          submitLabel="Create profile"
          onCreated={onCreated}
          secondary={<Button onClick={onClose}>Cancel</Button>}
        />
      </div>
    </Dialog>
  );
}

function Banner({
  title,
  error,
  onDismiss,
}: {
  title: string;
  error: VisionIpcError;
  onDismiss: () => void;
}) {
  const { state } = useVision();
  return (
    <div className="app-banner" role="alert">
      <div className="app-banner-text">
        <strong>{title}</strong> {errorText(error, state.platform)}
      </div>
      <button
        type="button"
        className="icon-btn icon-btn-sm"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
      >
        <X width={14} height={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The shipped app: startup states, first run, and the shell with real profiles, Tools and
 * MCP servers. Shows no demo data.
 */
export function VisionApp() {
  const { state, actions } = useVision();
  const core = useCoreInfo();
  const [section, setSection] = useState<Section>("home");
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [banner, setBanner] = useState<{
    title: string;
    error: VisionIpcError;
  } | null>(null);

  // The first profile created on the welcome screen lands on Tools.
  const hadProfiles = useRef<boolean | null>(null);
  const profileCount = state.profiles.length;
  const ready = state.boot.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    if (hadProfiles.current === false && profileCount > 0) setSection("tools");
    hadProfiles.current = profileCount > 0;
  }, [ready, profileCount]);

  const switchProfile = useCallback(
    (profileId: string) => {
      setBanner(null);
      actions.switchProfile(profileId).catch((e: unknown) => {
        setBanner({
          title: "Could not switch the profile.",
          error: asIpcError(e),
        });
      });
    },
    [actions],
  );

  const active = state.profiles.find((p) => p.id === state.activeProfileId) ?? null;
  const activeId = active?.id ?? null;

  const openTerminal = useCallback(() => {
    if (!activeId) return;
    actions.openProfileTerminal(activeId).catch((e: unknown) => {
      setBanner({ title: "Could not open a terminal.", error: asIpcError(e) });
    });
  }, [actions, activeId]);

  const shellProfiles = useMemo<ShellProfile[]>(
    () =>
      state.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        accent: p.accent,
        account: profileKindLabel(p.kind),
      })),
    [state.profiles],
  );

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "open-terminal",
        label: "Open terminal for this profile",
        group: "Actions",
        icon: <SquareTerminal width={16} height={16} />,
        keywords: "shell console sign in",
        run: openTerminal,
      },
    ],
    [openTerminal],
  );

  const openNewProfile = useCallback(() => {
    setNewProfileOpen(true);
  }, []);
  const manageProfiles = useCallback(() => {
    setSection("settings");
  }, []);

  if (state.boot.kind === "loading") return <StartupLoading />;
  if (state.boot.kind === "error") {
    return (
      <StartupError
        error={state.boot.error}
        onRetry={actions.retryBoot}
        version={core.kind === "ready" ? core.info.version : null}
      />
    );
  }
  if (!active) return <WelcomeView />;

  const renderSection = (target: Section): ReactNode => {
    switch (target) {
      case "home":
        return <OverviewHome profile={active} onNavigate={setSection} />;
      case "tools":
        return <ToolsView key={active.id} profile={active} />;
      case "mcp":
        return <McpView key={active.id} profile={active} />;
      default:
        return undefined;
    }
  };

  return (
    <>
      <AppShell
        key="shell"
        profiles={shellProfiles}
        activeProfileId={active.id}
        onSwitchProfile={switchProfile}
        onNewProfile={openNewProfile}
        onManageProfiles={manageProfiles}
        section={section}
        onNavigate={setSection}
        renderSection={renderSection}
        settingsTop={<ProfilesSettings onNewProfile={openNewProfile} />}
        extraCommands={commands}
        banner={
          banner && (
            <Banner
              title={banner.title}
              error={banner.error}
              onDismiss={() => {
                setBanner(null);
              }}
            />
          )
        }
        coreVersion={core.kind === "ready" ? core.info.version : null}
        footer={<CoreStatus status={core} />}
      />
      {newProfileOpen && (
        <div className="dialog-accent" data-accent={active.accent}>
          <NewProfileDialog
            onClose={() => {
              setNewProfileOpen(false);
            }}
            onCreated={(profile) => {
              setNewProfileOpen(false);
              switchProfile(profile.id);
              setSection("tools");
            }}
          />
        </div>
      )}
    </>
  );
}
