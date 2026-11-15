import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

// Hand-written for now; generated command types arrive with F-004.
type AppInfo = { name: string; version: string };

type Status =
  | { kind: "pending" }
  | { kind: "ready"; info: AppInfo }
  | { kind: "error" };

/** Placeholder shell: shows the product name and the core version. */
export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "pending" });

  useEffect(() => {
    let active = true;
    invoke<AppInfo>("app_info")
      .then((info) => {
        if (active) setStatus({ kind: "ready", info });
      })
      .catch(() => {
        if (active) setStatus({ kind: "error" });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <h1>Vision</h1>
      <p>Orchestrate your AI coding agents.</p>
      {status.kind === "pending" && <p>Connecting to core...</p>}
      {status.kind === "ready" && <p>Core {status.info.version}</p>}
      {status.kind === "error" && <p role="alert">Could not reach the Vision core.</p>}
    </main>
  );
}
