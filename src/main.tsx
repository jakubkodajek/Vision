import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/views.css";
import App from "./App";
import { tauriClient, type VisionClient } from "./data/client";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

/**
 * The Tauri client, or in `npm run dev` inside a plain browser (no Tauri bridge) an
 * in-memory mock. `import.meta.env.DEV` is `false` in production builds, so the mock and its
 * dynamic import are removed from `dist/`.
 */
async function pickClient(): Promise<VisionClient> {
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { createDevMockClient } = await import("./dev/mockClient");
    return createDevMockClient();
  }
  return tauriClient;
}

void pickClient().then((client) => {
  createRoot(root).render(
    <StrictMode>
      <App client={client} />
    </StrictMode>,
  );
});
