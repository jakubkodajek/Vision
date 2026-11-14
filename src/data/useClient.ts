import { createContext, useContext } from "react";
import { tauriClient, type VisionClient } from "./client";

/** Context holding the injected IPC client (the Tauri client by default). */
export const ClientContext = createContext<VisionClient>(tauriClient);

/** The injected IPC client. */
export function useClient(): VisionClient {
  return useContext(ClientContext);
}
