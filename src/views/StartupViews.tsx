import { ExternalLink, KeyRound, Plug, UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, ErrorState, LogoMark, Spinner } from "../components/primitives";
import { useVision } from "../data/context";
import { errorHint, errorText, type VisionIpcError } from "../data/errors";
import { useAsyncAction } from "../data/useAsyncAction";
import type { Accent } from "../ipc/bindings";
import { firstUnusedAccent } from "../lib/realLabels";
import { ProfileCreateForm } from "./ProfileCreateForm";

/** Full-page state while the core answers `bootstrap`. */
export function StartupLoading() {
  return (
    <main className="startup-page" data-accent="iris">
      <div className="startup-loading" role="status">
        <Spinner size={16} />
        <span>Starting Vision…</span>
      </div>
    </main>
  );
}

/**
 * Full-page error when the core could not start, with its message and a retry. Data from a
 * newer Vision cannot be opened by retrying, so that case offers the releases page instead.
 */
export function StartupError({
  error,
  onRetry,
  version,
}: {
  error: VisionIpcError;
  onRetry: () => void;
  version: string | null;
}) {
  const { actions } = useVision();
  const releases = useAsyncAction(actions.openReleasesPage);
  const tooNew = error.code === "schema_too_new";
  const title =
    error.code === "schema_too_new"
      ? "This version of Vision cannot open your data"
      : "Could not reach the Vision core";
  const hint = errorHint(error);
  return (
    <main className="startup-page" data-accent="iris">
      <section className="startup-card" aria-labelledby="startup-error-title">
        <div className="startup-brand">
          <LogoMark size={32} />
          <h1 className="startup-wordmark">Vision</h1>
        </div>
        <div className="startup-error" role="alert">
          <h2 id="startup-error-title" className="startup-title">
            {title}
          </h2>
          <p className="startup-message">{error.message}</p>
          {hint && <p className="startup-hint">{hint}</p>}
        </div>
        {releases.error && (
          <ErrorState compact title="Could not open the releases page" message={errorText(releases.error, null)} />
        )}
        <div className="form-actions is-start">
          {tooNew ? (
            <Button
              variant="primary"
              icon={<ExternalLink width={14} height={14} aria-hidden="true" />}
              loading={releases.busy}
              onClick={() => void releases.run()}
            >
              Get the latest version
              <span className="visually-hidden">, opens the Vision releases page in your browser</span>
            </Button>
          ) : (
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
        {version && <p className="startup-version">Vision {version}</p>}
      </section>
    </main>
  );
}

const POINTS = [
  {
    icon: <UserRound width={16} height={16} aria-hidden="true" />,
    text: "A profile keeps its own sign-ins, so work and personal accounts never mix.",
  },
  {
    icon: <KeyRound width={16} height={16} aria-hidden="true" />,
    text: "You sign in with each tool's own command in your terminal. Vision never sees passwords or tokens.",
  },
  {
    icon: <Plug width={16} height={16} aria-hidden="true" />,
    text: "MCP servers you add belong to the profile and can be synced to its Claude Code.",
  },
];

/** First run: explains profiles and creates the first one (the app then opens Tools). */
export function WelcomeView() {
  const { state } = useVision();
  const nameRef = useRef<HTMLInputElement>(null);
  // The page previews the accent chosen for the new profile.
  const [accent, setAccent] = useState<Accent>(() => firstUnusedAccent(state.profiles));
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  return (
    <div className="startup-page" data-accent={accent}>
      <main className="startup-card is-wide" aria-labelledby="welcome-title">
        <div className="startup-brand">
          <LogoMark size={32} />
          <h1 className="startup-wordmark">Vision</h1>
        </div>
        <div className="welcome-intro">
          <h2 id="welcome-title" className="startup-title">
            Create your first profile
          </h2>
          <ul className="welcome-points">
            {POINTS.map((point) => (
              <li key={point.text}>
                <span className="welcome-point-icon">{point.icon}</span>
                <span>{point.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <ProfileCreateForm submitLabel="Create profile" nameRef={nameRef} onAccentChange={setAccent} />
        <p className="startup-footnote">You can add more profiles and change these settings later.</p>
      </main>
    </div>
  );
}
