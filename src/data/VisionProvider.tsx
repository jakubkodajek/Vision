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
import { mcpTestPhrase, toolStatusPhrase } from "../lib/realLabels";
import { useClient } from "./useClient";
import { DEFAULT_TIMING, VisionContext, type VisionActions, type VisionTiming } from "./context";
import { asIpcError } from "./errors";
import { dataReducer, initialDataState, type AnnounceScope, type WaitKind } from "./store";

interface Poll {
  kind: WaitKind;
  cancel: () => void;
}

/** A "Check all" (or first-visit check) whose summary is announced when every check ended. */
interface Batch {
  pending: Set<string>;
  views: Map<string, ToolView>;
}

function isDone(kind: WaitKind, view: ToolView): boolean {
  const status = view.status?.status;
  return kind === "sign_in" ? status === "signed_in" : status === "signed_out" || status === "not_installed";
}

/** Whether an automatic check (no click on this tool) may run it without a native dialog. */
function autoCheckable(view: ToolView): boolean {
  return view.spec.invalid === null && view.spec.approved;
}

const DECLINED = "you declined to run this command. Nothing was run.";

/**
 * Owns the app's data: bootstrap, profiles, tools and MCP servers per profile. Every
 * response is stored under the profile it was requested for, only the newest request per
 * resource is applied, results of slow operations only update what is still listed (never
 * re-add a deleted tool or server), nothing is dispatched after unmount, and actions that
 * are already running are not started twice.
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
  const checks = useRef(new Set<string>());
  const batches = useRef(new Map<string, Batch>());
  const busy = useRef(new Set<string>());
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });

  const dispatch = useCallback((action: Parameters<typeof rawDispatch>[0]) => {
    if (alive.current) rawDispatch(action);
  }, []);

  const announce = useCallback(
    (scope: AnnounceScope, text: string) => {
      dispatch({ type: "announce", scope, text });
    },
    [dispatch],
  );

  /** Starts request `key`; the returned function says whether it is still the newest. */
  const begin = useCallback((key: string) => {
    const n = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, n);
    return () => alive.current && seq.current.get(key) === n;
  }, []);

  /** Makes every running request whose key matches stale. */
  const invalidate = useCallback((match: (key: string) => boolean) => {
    for (const [key, n] of seq.current) if (match(key)) seq.current.set(key, n + 1);
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

  const toolName = useCallback((profileId: string, toolId: string): string => {
    const slot = stateRef.current.tools[profileId];
    const entry =
      slot?.list.kind === "ready" ? slot.list.data.find((e) => e.view.spec.id === toolId) : undefined;
    return entry?.view.spec.name ?? toolId;
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

  const stopPoll = useCallback((profileId: string, toolId: string) => {
    const key = `${profileId}/${toolId}`;
    polls.current.get(key)?.cancel();
    polls.current.delete(key);
  }, []);

  /** Records a finished check in a running batch and announces the summary at the end. */
  const settleBatch = useCallback(
    (profileId: string, toolId: string, view: ToolView | null) => {
      const batch = batches.current.get(profileId);
      if (!batch?.pending.has(toolId)) return false;
      batch.pending.delete(toolId);
      if (view) batch.views.set(toolId, view);
      if (batch.pending.size === 0) {
        batches.current.delete(profileId);
        const all = [...batch.views.values()];
        const signedIn = all.filter((v) => v.status?.status === "signed_in").length;
        announce("tools", `Check finished: ${String(signedIn)} of ${String(all.length)} signed in.`);
      }
      return true;
    },
    [announce],
  );

  const checkTool = useCallback(
    (profileId: string, toolId: string) => {
      const key = `${profileId}/${toolId}`;
      const current = begin(`check/${key}`);
      checks.current.add(key);
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
          checks.current.delete(key);
          dispatch({ type: "tool/view", profileId, view });
          const poll = polls.current.get(key);
          const waitDone = poll !== undefined && isDone(poll.kind, view);
          if (waitDone) stopPoll(profileId, toolId);
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: { checking: false, ...(waitDone ? { waiting: null } : {}) },
          });
          if (!settleBatch(profileId, toolId, view))
            announce("tools", `${view.spec.name}: ${toolStatusPhrase(view.status)}.`);
        })
        .catch((e: unknown) => {
          if (!current()) return;
          checks.current.delete(key);
          const error = asIpcError(e);
          const declined = error.code === "not_approved";
          if (declined) stopPoll(profileId, toolId);
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: {
              checking: false,
              ...(declined ? { waiting: null } : {}),
              notice: declined
                ? { kind: "declined", action: "check" }
                : { kind: "error", action: "check", error },
            },
          });
          settleBatch(profileId, toolId, null);
          // Errors are shown in the card as an alert; the neutral "declined" is announced here.
          if (declined) announce("tools", `${toolName(profileId, toolId)}: ${DECLINED}`);
        });
    },
    [announce, begin, client, dispatch, settleBatch, stopPoll, toolName],
  );

  /** Checks every tool that can be checked without a native dialog, as one announced batch. */
  const checkAll = useCallback(
    (profileId: string, views: readonly ToolView[]) => {
      const runnable = views.filter(autoCheckable);
      if (runnable.length === 0) return;
      batches.current.set(profileId, {
        pending: new Set(runnable.map((v) => v.spec.id)),
        views: new Map(views.map((v) => [v.spec.id, v])),
      });
      for (const view of runnable) checkTool(profileId, view.spec.id);
    },
    [checkTool],
  );

  /** Profiles whose first visit to Tools still has to check every tool. */
  const wantAutoCheck = useRef(new Set<string>());
  const autoStarted = useRef(new Set<string>());

  /** Live activity of a profile's tools, to rebuild cards after a reload. */
  const activity = useCallback((profileId: string) => {
    const waiting: Record<string, WaitKind> = {};
    for (const [key, poll] of polls.current) {
      if (key.startsWith(`${profileId}/`)) waiting[key.slice(profileId.length + 1)] = poll.kind;
    }
    const checking = [...checks.current]
      .filter((key) => key.startsWith(`${profileId}/`))
      .map((key) => key.slice(profileId.length + 1));
    return { waiting, checking };
  }, []);

  const loadTools = useCallback(
    (profileId: string) => {
      const current = begin(`tools/${profileId}`);
      dispatch({ type: "tools/loading", profileId });
      client
        .toolsList({ profile_id: profileId })
        .then((views) => {
          if (!current()) return;
          dispatch({
            type: "tools/loaded",
            profileId,
            views,
            ...activity(profileId),
          });
          if (wantAutoCheck.current.delete(profileId)) {
            dispatch({ type: "tools/autoChecked", profileId });
            checkAll(profileId, views);
          }
        })
        .catch((e: unknown) => {
          if (current()) dispatch({ type: "tools/failed", profileId, error: asIpcError(e) });
        });
    },
    [activity, begin, checkAll, client, dispatch],
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
          // Polling never asks for a confirmation: stop if the tool is no longer approved.
          const slot = stateRef.current.tools[profileId];
          const entry =
            slot?.list.kind === "ready" ? slot.list.data.find((e) => e.view.spec.id === toolId) : undefined;
          if (entry && !autoCheckable(entry.view)) {
            finish(null);
            return;
          }
          client
            .toolCheck({ profile_id: profileId, tool_id: toolId })
            .then((view) => {
              if (cancelled || !alive.current) return;
              dispatch({ type: "tool/view", profileId, view });
              if (isDone(kind, view)) {
                finish(null);
                announce("tools", `${view.spec.name}: ${toolStatusPhrase(view.status)}.`);
              } else if (Date.now() >= deadline) {
                finish({
                  type: "tool/patch",
                  profileId,
                  toolId,
                  patch: { notice: { kind: "timeout", wait: kind } },
                });
                announce(
                  "tools",
                  `${view.spec.name}: no ${kind === "sign_in" ? "sign-in" : "sign-out"} was detected.`,
                );
              } else schedule();
            })
            .catch((e: unknown) => {
              if (cancelled || !alive.current) return;
              const error = asIpcError(e);
              const declined = error.code === "not_approved";
              finish({
                type: "tool/patch",
                profileId,
                toolId,
                patch: {
                  notice: declined
                    ? { kind: "declined", action: "check" }
                    : { kind: "error", action: "check", error },
                },
              });
              if (declined) announce("tools", `${toolName(profileId, toolId)}: ${DECLINED}`);
            });
        }, timing.pollIntervalMs);
      };
      polls.current.set(key, {
        kind,
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
    [announce, client, dispatch, stopPoll, timing, toolName],
  );

  const runTerminalAction = useCallback(
    (profileId: string, toolId: string, kind: WaitKind) => {
      void once(`${kind}/${profileId}/${toolId}`, async () => {
        // "Open terminal again" during a wait keeps the wait row until the new one starts.
        stopPoll(profileId, toolId);
        dispatch({
          type: "tool/patch",
          profileId,
          toolId,
          patch: { sending: kind, notice: null },
        });
        try {
          const args = { profile_id: profileId, tool_id: toolId };
          await (kind === "sign_in" ? client.toolSignIn(args) : client.toolSignOut(args));
          // The core ran the tool, so it is approved now (built-ins always are).
          dispatch({ type: "tool/approved", toolId });
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: { sending: null },
          });
          if (alive.current) startPoll(profileId, toolId, kind);
        } catch (e: unknown) {
          const error = asIpcError(e);
          const declined = error.code === "not_approved";
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: {
              sending: null,
              waiting: null,
              notice: declined ? { kind: "declined", action: kind } : { kind: "error", action: kind, error },
            },
          });
          if (declined) announce("tools", `${toolName(profileId, toolId)}: ${DECLINED}`);
        }
      });
    },
    [announce, client, dispatch, once, startPoll, stopPoll, toolName],
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
          const error = asIpcError(e);
          dispatch({
            type: "tool/patch",
            profileId,
            toolId,
            patch: {
              sending: null,
              notice: {
                kind: "error",
                action: "install",
                error,
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

  // ---- profiles ----------------------------------------------------------------------

  /** Latest profile the user asked for while a switch is in flight. */
  const switchTarget = useRef<string | null>(null);
  const switching = useRef<Promise<void> | null>(null);

  const switchProfile = useCallback(
    (profileId: string): Promise<void> => {
      switchTarget.current = profileId;
      if (switching.current) return switching.current;
      if (stateRef.current.activeProfileId === profileId) {
        switchTarget.current = null;
        return Promise.resolve();
      }
      const run = async () => {
        try {
          // Each pass persists the newest target; a target chosen meanwhile runs next.
          for (;;) {
            const target = switchTarget.current;
            if (target === null) return;
            await client.profileSetActive({ id: target });
            if (switchTarget.current === target) {
              switchTarget.current = null;
              dispatch({ type: "profile/active", profileId: target });
              return;
            }
          }
        } finally {
          switching.current = null;
          switchTarget.current = null;
        }
      };
      switching.current = run();
      return switching.current;
    },
    [client, dispatch],
  );

  // ---- actions -----------------------------------------------------------------------

  const actions = useMemo<VisionActions>(() => {
    /** Key of a server's row: a save, toggle or delete makes a running test's answer stale. */
    const rowKey = (profileId: string, serverId: string) => `mcp-row/${profileId}/${serverId}`;
    return {
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
      switchProfile,
      openProfileTerminal: async (profileId: string): Promise<void> => {
        await once(`terminal/${profileId}`, () => client.profileOpenTerminal({ profile_id: profileId }));
      },
      openReleasesPage: async (): Promise<void> => {
        await once("releases", () => client.appOpenReleasesPage());
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
        announce("tools", `${toolName(profileId, toolId)}: stopped waiting.`);
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
      saveCustomTool: async (tool: CustomToolInput, replace = false): Promise<ToolSpecView> => {
        const spec = await client.customToolSave({ tool, replace });
        dispatch({ type: "tools/invalidate" });
        const active = stateRef.current.activeProfileId;
        if (active && stateRef.current.tools[active]?.list.kind === "ready") {
          // Show the new or changed tool right away; check it only if that cannot ask.
          dispatch({
            type: "tool/added",
            profileId: active,
            view: {
              spec,
              status: null,
              version: null,
              binary_path: null,
              checked_at: null,
            },
          });
          if (
            autoCheckable({
              spec,
              status: null,
              version: null,
              binary_path: null,
              checked_at: null,
            })
          )
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
        // A check that started before the delete must not bring the tool back.
        invalidate((key) => key.startsWith("check/") && key.endsWith(`/${toolId}`));
        for (const key of [...checks.current]) if (key.endsWith(`/${toolId}`)) checks.current.delete(key);
        dispatch({ type: "tool/removed", toolId });
      },
      ensureMcp,
      reloadMcp: loadMcp,
      saveServer: async (profileId: string, server: McpServerInput): Promise<McpServerView> => {
        if (server.id) begin(rowKey(profileId, server.id));
        const view = await client.mcpSave({ profile_id: profileId, server });
        begin(rowKey(profileId, view.id));
        dispatch({
          type: server.id ? "mcp/updated" : "mcp/added",
          profileId,
          server: view,
        });
        return view;
      },
      setServerEnabled: async (
        profileId: string,
        serverId: string,
        enabled: boolean,
      ): Promise<McpServerView> => {
        begin(rowKey(profileId, serverId));
        const view = await client.mcpSetEnabled({
          profile_id: profileId,
          server_id: serverId,
          enabled,
        });
        begin(rowKey(profileId, serverId));
        dispatch({ type: "mcp/updated", profileId, server: view });
        announce("mcp", `${view.name}: ${view.enabled ? "enabled" : "disabled"}.`);
        return view;
      },
      deleteServer: async (profileId: string, serverId: string): Promise<void> => {
        begin(rowKey(profileId, serverId));
        await client.mcpDelete({ profile_id: profileId, server_id: serverId });
        begin(rowKey(profileId, serverId));
        dispatch({ type: "mcp/removed", profileId, serverId });
      },
      testServer: async (profileId: string, serverId: string): Promise<McpServerView | null> => {
        const current = begin(rowKey(profileId, serverId));
        const slot = stateRef.current.mcp[profileId];
        const name =
          (slot?.kind === "ready" ? slot.data.find((s) => s.id === serverId)?.name : undefined) ??
          "The server";
        try {
          const view = await client.mcpTest({
            profile_id: profileId,
            server_id: serverId,
          });
          if (!current()) return null;
          dispatch({ type: "mcp/updated", profileId, server: view });
          announce("mcp", `${view.name}: ${mcpTestPhrase(view.health)}.`);
          return view;
        } catch (e: unknown) {
          const error = asIpcError(e);
          if (error.code === "not_found") {
            dispatch({ type: "mcp/removed", profileId, serverId });
            announce("mcp", `${name} no longer exists.`);
            return null;
          }
          // Errors are shown on the row as an alert; the neutral "declined" is announced here.
          if (current() && error.code === "not_approved") announce("mcp", `${name}: ${DECLINED}`);
          throw error;
        }
      },
      authorizeServer: async (profileId: string, serverId: string): Promise<void> => {
        await client.mcpAuthorize({
          profile_id: profileId,
          server_id: serverId,
        });
      },
      syncClaude: async (profileId: string): Promise<SyncReport> => {
        const report = await client.mcpSyncClaude({ profile_id: profileId });
        // The sync state of each server changed: reload the list quietly.
        const current = begin(`mcp/${profileId}`);
        client
          .mcpList({ profile_id: profileId })
          .then((servers) => {
            if (current()) dispatch({ type: "mcp/loaded", profileId, servers });
          })
          .catch(() => {
            // The old list stays; the next visit reloads it.
          });
        return report;
      },
      announce,
    };
  }, [
    announce,
    begin,
    checkAll,
    checkTool,
    client,
    dispatch,
    ensureMcp,
    ensureTools,
    invalidate,
    loadBoot,
    loadMcp,
    loadTools,
    once,
    openInstallPage,
    runTerminalAction,
    stopPoll,
    switchProfile,
    toolName,
    visitTools,
  ]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <VisionContext.Provider value={value}>{children}</VisionContext.Provider>;
}
