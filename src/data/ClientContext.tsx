import type { ReactNode } from "react";
import type { VisionClient } from "./client";
import { ClientContext } from "./useClient";

/** Provides the IPC client to everything below it. */
export function ClientProvider({ client, children }: { client: VisionClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>;
}
