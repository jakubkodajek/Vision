import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Spinner } from "./components/primitives";
import { loadDemoWorkspace } from "./demo/workspace";
import { AppShell } from "./shell/AppShell";

// Hand-written for now; generated command types arrive with F-004.
type AppInfo = { name: string; version: string };

type Status = { kind: "pending" } | { kind: "ready"; info: AppInfo } | { kind: "error" };

/** Validates the app_info payload instead of trusting the IPC boundary. */
function isAppInfo(value: unknown): value is AppInfo {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.version === "string" && record.version.length <= 64;
}

function CoreStatus({ status }: { status: Status }) {
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

/** Root component: asks the core for its version and renders the app shell. */
export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "pending" });

  useEffect(() => {
    let active = true;
    invoke<unknown>("app_info")
      .then((info) => {
        if (!active) return;
        setStatus(isAppInfo(info) ? { kind: "ready", info } : { kind: "error" });
      })
      .catch(() => {
        if (active) setStatus({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <ErrorBoundary>
      <AppShell
        loadWorkspace={loadDemoWorkspace}
        coreVersion={status.kind === "ready" ? status.info.version : null}
        footer={<CoreStatus status={status} />}
      />
    </ErrorBoundary>
  );
}
