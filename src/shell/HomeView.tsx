import { ArrowRight } from "lucide-react";
import { Composer, type ComposerSubmission, type PickerOption } from "../components/Composer";
import { EmptyState, ErrorState, RunStatusBadge, Skeleton } from "../components/primitives";
import type { LoadState, Profile, Workspace } from "../types";

export interface HomeViewProps {
  profile: Profile;
  workspace: LoadState<Workspace>;
  onRetry: () => void;
  onStart: (submission: ComposerSubmission) => Promise<void>;
  onOpenRun: (runId: string) => void;
  agents: PickerOption[];
  models: PickerOption[];
  focusKey: number;
}

function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** Start screen: a large composer to describe a task, then recent runs. */
export function HomeView({
  profile,
  workspace,
  onRetry,
  onStart,
  onOpenRun,
  agents,
  models,
  focusKey,
}: HomeViewProps) {
  const projects: PickerOption[] =
    workspace.kind === "ready" ? workspace.data.projects.map((p) => ({ id: p.id, label: p.label })) : [];
  return (
    <div className="home-view">
      <div className="home-inner">
        <h2 className="home-title">
          {greeting()}. <span className="home-title-muted">What should we build?</span>
        </h2>
        <Composer
          key={`${profile.id}-${String(focusKey)}`}
          variant="hero"
          onSubmit={onStart}
          agents={agents}
          models={models}
          projects={projects}
          autoFocus
          disabled={workspace.kind !== "ready" || projects.length === 0}
          disabledReason={
            workspace.kind === "loading"
              ? "Loading projects…"
              : workspace.kind === "error"
                ? "Projects could not be loaded."
                : projects.length === 0
                  ? "Add a project to start a task."
                  : undefined
          }
        />
        <p className="home-profile-note">
          Runs in <strong>{profile.name}</strong> use the sign-ins of this profile only.
        </p>
        <section className="home-recent" aria-labelledby="home-recent-heading">
          <h3 id="home-recent-heading" className="section-heading">
            Jump back in
          </h3>
          {workspace.kind === "loading" && (
            <div className="home-recent-grid" aria-busy="true" aria-label="Loading recent runs">
              {[0, 1, 2].map((i) => (
                <div key={i} className="run-card is-loading">
                  <Skeleton width="wide" />
                  <Skeleton width="short" />
                </div>
              ))}
            </div>
          )}
          {workspace.kind === "error" && (
            <ErrorState title="Could not load runs" message={workspace.message} onRetry={onRetry} />
          )}
          {workspace.kind === "ready" &&
            (workspace.data.runs.length === 0 ? (
              <EmptyState title="No runs yet" description="Describe a task above to start your first run." />
            ) : (
              <ul className="home-recent-grid">
                {workspace.data.runs.slice(0, 4).map((run) => (
                  <li key={run.id}>
                    <button
                      type="button"
                      className="run-card"
                      onClick={() => {
                        onOpenRun(run.id);
                      }}
                    >
                      <span className="run-card-title">{run.title}</span>
                      <span className="run-card-meta">
                        <RunStatusBadge status={run.status} />
                        <span>{run.updated}</span>
                      </span>
                      <ArrowRight className="run-card-arrow" width={16} height={16} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      </div>
    </div>
  );
}
