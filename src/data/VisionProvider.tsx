import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type {
  CustomToolInput,
  McpServerInput,
  McpServerView,
  Profile,
  ProfileCreateArgs,
  ProfileUpdateArgs,
  SyncReport,
  ToolSpecView,
  ToolView,
} from "../ipc/bindings";
import { useClient } from "./useClient";
import { DEFAULT_TIMING, VisionContext, type VisionActions, type VisionTiming } from "./context";
import { asIpcError } from "./errors";
import { dataReducer, initialDataState, type WaitKind } from "./store";

interface Poll {
  cancel: () => void;
}

function isDone(kind: WaitKind, view: ToolView): boolean {
  const status = view.status?.status;
  return kind === "sign_in" ? status === "signed_in" : status === "signed_out" || status === "not_installed";
}

/**
 * Owns the app's data: bootstrap, profiles, tools and MCP servers per profile. Every
 * response is stored under the profile it was requested for, only the newest request per
 * resource is applied, nothing is dispatched after unmount, and actions that are already
 * running are not started twice.
 */
export function VisionProvider({
  children,
  timing = DEFAULT_TIMING,
}: {
  children: ReactNode;
  /** Polling interval and timeouts; tests pass their own with fake timers. */
  timing?: VisionTiming;
}) {
  const client = useClient();
  const [state, rawDispatch] = useReducer(dataReducer, initialDataState);
  const alive = useRef(true);
  const seq = useRef(new Map<string, number>());
  const polls = useRef(new Map<string, Poll>());
  const busy = useRef(new Set<string>());
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });

  const dispatch = useCallback((action: Parameters<typeof rawDispatch>[0]) => {
    if (alive.current) rawDispatch(action);
  }, []);

  /** Starts request `key`; the returned function says whether it is still the newest. */
  const begin = useCallback((key: string) => {
    const n = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, n);
    return () => alive.current && seq.current.get(key) === n;
  }, []);

  /** Runs `fn` unless an action with the same key is running (double-click guard). */
  const once = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current.has(key)) return undefined;
    busy.current.add(key);
    try {
      return await fn();
    } finally {
      busy.current.delete(key);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const running = polls.current;
    return () => {
      alive.current = false;
      for (const poll of running.values()) poll.cancel();
      running.clear();
    };
  }, []);

  // ---- bootstrap ---------------------------------------------------------------------

  const loadBoot = useCallback(
    (quiet: boolean) => {
      const current = begin("boot");
      if (!quiet) dispatch({ type: "boot/loading" });
      client
        .bootstrap()
        .then((b) => {
          if (current())
            dispatch({
              type: "boot/ready",
              profiles: b.profiles,
              activeProfileId: b.active_profile_id,
              platform: b.platform,
            });
        })
        .catch((e: unknown) => {
          if (current() && !quiet) dispatch({ type: "boot/failed", error: asIpcError(e) });
        });
    },
    [begin, client, dispatch],
  );

  useEffect(() => {
    loadBoot(false);
  }, [loadBoot]);

  // ---- tools -------------------------------------------------------------------------

  const checkTool = useCallback(
    (profileId: string, toolId: string) => {
      const current = begin(`check/${profileId}/${toolId}`);
      dispatch({
        type: "tool/patch",
        profileId,
        toolId,
        patch: { checking: true, notice: null },
      });
      client
        .toolCheck({ profile_id: profileId, tool_id: toolId })
        .then((view) => {
          if (!current()) return;
          dispatch({ type: "tool/view", profileId, view });
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: { checking: false },
          });
        })
        .catch((e: unknown) => {
          if (!current()) return;
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: {
              checking: false,
              notice: { kind: "error", action: "check", error: asIpcError(e) },
            },
          });
        });
    },
    [begin, client, dispatch],
  );

  const checkAll = useCallback(
    (profileId: string, views: readonly ToolView[]) => {
      for (const view of views) checkTool(profileId, view.spec.id);
    },
    [checkTool],
  );

  /** Profiles whose first visit to Tools still has to check every tool. */
  const wantAutoCheck = useRef(new Set<string>());
  const autoStarted = useRef(new Set<string>());

  const loadTools = useCallback(
    (profileId: string) => {
      const current = begin(`tools/${profileId}`);
      dispatch({ type: "tools/loading", profileId });
      client
        .toolsList({ profile_id: profileId })
        .then((views) => {
          if (!current()) return;
          dispatch({ type: "tools/loaded", profileId, views });
          if (wantAutoCheck.current.delete(profileId)) {
            dispatch({ type: "tools/autoChecked", profileId });
            checkAll(profileId, views);
          }
        })
        .catch((e: unknown) => {
          if (current()) dispatch({ type: "tools/failed", profileId, error: asIpcError(e) });
        });
    },
    [begin, checkAll, client, dispatch],
  );

  const visitTools = useCallback(
    (profileId: string) => {
      if (!autoStarted.current.has(profileId)) {
        autoStarted.current.add(profileId);
        wantAutoCheck.current.add(profileId);
      }
      const slot = stateRef.current.tools[profileId];
      if (!slot || slot.list.kind === "error") {
        loadTools(profileId);
      } else if (slot.list.kind === "ready" && wantAutoCheck.current.delete(profileId)) {
        dispatch({ type: "tools/autoChecked", profileId });
        checkAll(
          profileId,
          slot.list.data.map((e) => e.view),
        );
      }
      // While a list is loading, its response runs the pending first check.
    },
    [checkAll, dispatch, loadTools],
  );

  const ensureTools = useCallback(
    (profileId: string) => {
      if (!stateRef.current.tools[profileId]) loadTools(profileId);
    },
    [loadTools],
  );

  const stopPoll = useCallback((profileId: string, toolId: string) => {
    const key = `${profileId}/${toolId}`;
    polls.current.get(key)?.cancel();
    polls.current.delete(key);
  }, []);

  const startPoll = useCallback(
    (profileId: string, toolId: string, kind: WaitKind) => {
      stopPoll(profileId, toolId);
      const key = `${profileId}/${toolId}`;
      const deadline = Date.now() + (kind === "sign_in" ? timing.signInTimeoutMs : timing.signOutTimeoutMs);
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (patch: Parameters<typeof dispatch>[0] | null) => {
        polls.current.delete(key);
        dispatch({
          type: "tool/patch",
          profileId,
          toolId,
          patch: { waiting: null },
        });
        if (patch) dispatch(patch);
      };
      const schedule = () => {
        timer = setTimeout(() => {
          if (cancelled) return;
          client
            .toolCheck({ profile_id: profileId, tool_id: toolId })
            .then((view) => {
              if (cancelled || !alive.current) return;
              dispatch({ type: "tool/view", profileId, view });
              if (isDone(kind, view)) finish(null);
              else if (Date.now() >= deadline)
                finish({
                  type: "tool/patch",
                  profileId,
                  toolId,
                  patch: { notice: { kind: "timeout", wait: kind } },
                });
              else schedule();
            })
            .catch((e: unknown) => {
              if (cancelled || !alive.current) return;
              finish({
                type: "tool/patch",
                profileId,
                toolId,
                patch: {
                  notice: {
                    kind: "error",
                    action: "check",
                    error: asIpcError(e),
                  },
                },
              });
            });
        }, timing.pollIntervalMs);
      };
      polls.current.set(key, {
        cancel: () => {
          cancelled = true;
          if (timer !== undefined) clearTimeout(timer);
        },
      });
      dispatch({
        type: "tool/patch",
        profileId,
        toolId,
        patch: { waiting: kind, notice: null },
      });
      schedule();
    },
    [client, dispatch, stopPoll, timing],
  );

  const runTerminalAction = useCallback(
    (profileId: string, toolId: string, kind: WaitKind) => {
      void once(`${kind}/${profileId}/${toolId}`, async () => {
        stopPoll(profileId, toolId);
        dispatch({
          type: "tool/patch",
          profileId,
          toolId,
          patch: { sending: kind, notice: null, waiting: null },
        });
        try {
          const args = { profile_id: profileId, tool_id: toolId };
          await (kind === "sign_in" ? client.toolSignIn(args) : client.toolSignOut(args));
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: { sending: null },
          });
          if (alive.current) startPoll(profileId, toolId, kind);
        } catch (e: unknown) {
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: {
              sending: null,
              notice: { kind: "error", action: kind, error: asIpcError(e) },
            },
          });
        }
      });
    },
    [client, dispatch, once, startPoll, stopPoll],
  );

  const openInstallPage = useCallback(
    (profileId: string, toolId: string) => {
      void once(`install/${toolId}`, async () => {
        dispatch({
          type: "tool/patch",
          profileId,
          toolId,
          patch: { sending: "install", notice: null },
        });
        try {
          await client.toolOpenInstallPage({ tool_id: toolId });
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: { sending: null },
          });
        } catch (e: unknown) {
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: {
              sending: null,
              notice: {
                kind: "error",
                action: "install",
                error: asIpcError(e),
              },
            },
          });
        }
      });
    },
    [client, dispatch, once],
  );

  // ---- MCP ---------------------------------------------------------------------------

  const loadMcp = useCallback(
    (profileId: string) => {
      const current = begin(`mcp/${profileId}`);
      dispatch({ type: "mcp/loading", profileId });
      client
        .mcpList({ profile_id: profileId })
        .then((servers) => {
          if (current()) dispatch({ type: "mcp/loaded", profileId, servers });
        })
        .catch((e: unknown) => {
          if (current()) dispatch({ type: "mcp/failed", profileId, error: asIpcError(e) });
        });
    },
    [begin, client, dispatch],
  );

  const ensureMcp = useCallback(
    (profileId: string) => {
      const slot = stateRef.current.mcp[profileId];
      if (!slot) loadMcp(profileId);
    },
    [loadMcp],
  );

  // ---- actions -----------------------------------------------------------------------

  const actions = useMemo<VisionActions>(
    () => ({
      retryBoot: () => {
        loadBoot(false);
      },
      createProfile: async (args: ProfileCreateArgs): Promise<Profile> => {
        const profile = await client.profileCreate(args);
        dispatch({ type: "profile/added", profile });
        return profile;
      },
      updateProfile: async (args: ProfileUpdateArgs): Promise<Profile> => {
        const profile = await client.profileUpdate(args);
        dispatch({ type: "profile/updated", profile });
        return profile;
      },
      deleteProfile: async (profileId: string, confirmName: string): Promise<void> => {
        try {
          await client.profileDelete({
            id: profileId,
            confirm_name: confirmName,
          });
        } catch (e: unknown) {
          // An `io` error can mean the row is gone but files remained: resync the list.
          loadBoot(true);
          throw asIpcError(e);
        }
        for (const key of [...polls.current.keys()]) {
          if (key.startsWith(`${profileId}/`)) {
            polls.current.get(key)?.cancel();
            polls.current.delete(key);
          }
        }
        const s = stateRef.current;
        const remaining = s.profiles.filter((p) => p.id !== profileId);
        const nextActiveId = s.activeProfileId === profileId ? (remaining[0]?.id ?? null) : s.activeProfileId;
        dispatch({ type: "profile/removed", profileId, nextActiveId });
      },
      switchProfile: async (profileId: string): Promise<void> => {
        if (stateRef.current.activeProfileId === profileId) return;
        await once("switch", async () => {
          await client.profileSetActive({ id: profileId });
          dispatch({ type: "profile/active", profileId });
        });
      },
      openProfileTerminal: async (profileId: string): Promise<void> => {
        await once(`terminal/${profileId}`, () => client.profileOpenTerminal({ profile_id: profileId }));
      },
      visitTools,
      ensureTools,
      reloadTools: loadTools,
      checkTool,
      checkAllTools: (profileId: string) => {
        const slot = stateRef.current.tools[profileId];
        if (slot?.list.kind === "ready")
          checkAll(
            profileId,
            slot.list.data.map((e) => e.view),
          );
      },
      signIn: (profileId: string, toolId: string) => {
        runTerminalAction(profileId, toolId, "sign_in");
      },
      signOut: (profileId: string, toolId: string) => {
        runTerminalAction(profileId, toolId, "sign_out");
      },
      cancelWait: (profileId: string, toolId: string) => {
        stopPoll(profileId, toolId);
        dispatch({
          type: "tool/patch",
          profileId,
          toolId,
          patch: { waiting: null },
        });
      },
      dismissNotice: (profileId: string, toolId: string) => {
        dispatch({
          type: "tool/patch",
          profileId,
          toolId,
          patch: { notice: null },
        });
      },
      openInstallPage,
      saveCustomTool: async (tool: CustomToolInput): Promise<ToolSpecView> => {
        const spec = await client.customToolSave({ tool });
        dispatch({ type: "tools/invalidate" });
        const active = stateRef.current.activeProfileId;
        if (active && stateRef.current.tools[active]?.list.kind === "ready") {
          // Show the new or changed tool right away, then detect its status.
          dispatch({
            type: "tool/view",
            profileId: active,
            view: {
              spec,
              status: null,
              version: null,
              binary_path: null,
              checked_at: null,
            },
          });
          checkTool(active, spec.id);
        } else if (active) {
          loadTools(active);
        }
        return spec;
      },
      deleteCustomTool: async (toolId: string): Promise<void> => {
        await client.customToolDelete({ tool_id: toolId });
        for (const key of [...polls.current.keys()]) {
          if (key.endsWith(`/${toolId}`)) {
            polls.current.get(key)?.cancel();
            polls.current.delete(key);
          }
        }
        dispatch({ type: "tool/removed", toolId });
      },
      ensureMcp,
      reloadMcp: loadMcp,
      saveServer: async (profileId: string, server: McpServerInput): Promise<McpServerView> => {
        const view = await client.mcpSave({ profile_id: profileId, server });
        dispatch({ type: "mcp/upsert", profileId, server: view });
        return view;
      },
      deleteServer: async (profileId: string, serverId: string): Promise<void> => {
        await client.mcpDelete({ profile_id: profileId, server_id: serverId });
        dispatch({ type: "mcp/removed", profileId, serverId });
      },
      testServer: async (profileId: string, serverId: string): Promise<McpServerView> => {
        const view = await client.mcpTest({
          profile_id: profileId,
          server_id: serverId,
        });
        dispatch({ type: "mcp/upsert", profileId, server: view });
        return view;
      },
      authorizeServer: async (profileId: string, serverId: string): Promise<void> => {
        await client.mcpAuthorize({
          profile_id: profileId,
          server_id: serverId,
        });
      },
      syncClaude: (profileId: string): Promise<SyncReport> => client.mcpSyncClaude({ profile_id: profileId }),
    }),
    [
      checkAll,
      checkTool,
      client,
      dispatch,
      ensureMcp,
      ensureTools,
      loadBoot,
      loadMcp,
      loadTools,
      once,
      openInstallPage,
      runTerminalAction,
      stopPoll,
      visitTools,
    ],
  );

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <VisionContext.Provider value={value}>{children}</VisionContext.Provider>;
}
