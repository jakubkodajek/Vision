import { ErrorBoundary } from "./components/ErrorBoundary";
import { VisionApp } from "./app/VisionApp";
import { tauriClient, type VisionClient } from "./data/client";
import { ClientProvider } from "./data/ClientContext";
import { VisionProvider } from "./data/VisionProvider";

/**
 * Root component: injects the IPC client (the Tauri one unless given) and renders the app.
 * The shipped UI shows only data from the core; demo data is used by tests and previews only.
 */
export default function App({ client = tauriClient }: { client?: VisionClient }) {
  return (
    <ErrorBoundary>
      <ClientProvider client={client}>
        <VisionProvider>
          <VisionApp />
        </VisionProvider>
      </ClientProvider>
    </ErrorBoundary>
  );
}
