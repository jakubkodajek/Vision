/**
 * In-memory implementation of the IPC client for UI tests: records every call, can fail the
 * next call of a command, and can hold calls until the test releases them (to control the
 * order in which responses arrive).
 */
import type { VisionClient } from "../../src/data/client";
import type {
  ErrorCode,
  KeyValueInput,
  KeyValueView,
  McpServerInput,
  McpServerView,
  Platform,
  Profile,
  SyncReport,
  ToolSpecView,
  ToolStatus,
  ToolView,
} from "../../src/ipc/bindings";
import { VisionIpcError } from "../../src/ipc/client";

export type Command = keyof VisionClient;

interface Held {
  args: unknown;
  run: () => void;
}

/** A preset-like tool spec. */
export function toolSpec(id: string, name: string, extra: Partial<ToolSpecView> = {}): ToolSpecView {
  return {
    id,
    name,
    description: `${name} description`,
    binary: id,
    install_url: `https://example.com/${id}`,
    config_env: [{ var: `${id.toUpperCase()}_CONFIG_DIR`, kind: "dir", rel: "" }],
    login: ["login"],
    logout: ["logout"],
    status: ["status"],
    status_parser: "exit_code",
    isolation: "verified",
    builtin: true,
    ...extra,
  };
}

/** A tool view with a status. */
export function toolView(
  spec: ToolSpecView,
  status: ToolStatus | null,
  version: string | null = "1.0.0",
): ToolView {
  return {
    spec,
    status,
    version: status?.status === "not_installed" ? null : version,
    binary_path: status?.status === "not_installed" ? null : `/usr/local/bin/${spec.binary}`,
    checked_at: status ? "2026-11-14T08:00:00Z" : null,
  };
}

/** A profile. */
export function profile(id: string, name: string, extra: Partial<Profile> = {}): Profile {
  return { id, name, kind: "work", accent: "teal", created_at: "2026-11-01T00:00:00Z", ...extra };
}

/** An MCP server view. */
export function server(id: string, name: string, extra: Partial<McpServerView> = {}): McpServerView {
  return {
    id,
    name,
    transport: { kind: "stdio", command: "npx", args: ["-y", "pkg"], env: [] },
    tool_ids: [],
    enabled: true,
    health: {
      status: "untested",
      message: null,
      tools: [],
      server_name: null,
      server_version: null,
      checked_at: null,
    },
    ...extra,
  };
}

/** Fake client with a small in-memory model of the core. */
export class FakeClient implements VisionClient {
  profiles: Profile[] = [];
  active: string | null = null;
  platform: Platform = "macos";
  /** Tools per profile, in list order. */
  tools = new Map<string, ToolView[]>();
  /** Status results returned by successive `toolCheck` calls, per `profile/tool`. */
  checkQueue = new Map<string, ToolStatus[]>();
  servers = new Map<string, McpServerView[]>();
  syncReport: SyncReport = { synced: [], removed: [], failed: [] };
  /** Result of the next `mcpTest`, per server id. */
  testResults = new Map<string, McpServerView["health"]>();
  readonly log: { command: Command; args: unknown }[] = [];
  private failures = new Map<Command, { error: VisionIpcError; always: boolean }>();
  private held = new Set<Command>();
  private pending = new Map<Command, Held[]>();
  private counter = 0;

  /** Rejects the next call of `command` (or every call with `always`). */
  fail(command: Command, code: ErrorCode, message: string, always = false): this {
    this.failures.set(command, { error: new VisionIpcError(code, message), always });
    return this;
  }

  /** Holds every later call of `command` until {@link release}. */
  hold(command: Command): this {
    this.held.add(command);
    return this;
  }

  /** Stops holding `command`; already held calls stay pending. */
  unhold(command: Command): this {
    this.held.delete(command);
    return this;
  }

  /** Answers the first held call of `command` whose arguments match. */
  release(command: Command, match: (args: unknown) => boolean = () => true): void {
    const list = this.pending.get(command) ?? [];
    const index = list.findIndex((h) => match(h.args));
    const [entry] = index >= 0 ? list.splice(index, 1) : [];
    if (!entry) throw new Error(`No held ${command} call matches`);
    entry.run();
  }

  /** Number of calls still held for `command`. */
  heldCount(command: Command): number {
    return this.pending.get(command)?.length ?? 0;
  }

  /** Arguments of every call of `command`, in order. */
  calls(command: Command): unknown[] {
    return this.log.filter((c) => c.command === command).map((c) => c.args);
  }

  private answer<T>(command: Command, args: unknown, compute: () => T): Promise<T> {
    this.log.push({ command, args });
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        const failure = this.failures.get(command);
        if (failure) {
          if (!failure.always) this.failures.delete(command);
          reject(failure.error);
          return;
        }
        try {
          resolve(compute());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      if (this.held.has(command)) {
        const list = this.pending.get(command) ?? [];
        list.push({ args, run });
        this.pending.set(command, list);
      } else {
        run();
      }
    });
  }

  private toolList(profileId: string): ToolView[] {
    const list = this.tools.get(profileId);
    if (!list) throw new VisionIpcError("not_found", "Profile not found");
    return list;
  }

  appInfo = () => this.answer("appInfo", undefined, () => ({ name: "Vision", version: "0.1.0" }));

  bootstrap = () =>
    this.answer("bootstrap", undefined, () => ({
      profiles: [...this.profiles],
      active_profile_id: this.active,
      platform: this.platform,
    }));

  profileCreate: VisionClient["profileCreate"] = (args) =>
    this.answer("profileCreate", args, () => {
      this.counter += 1;
      const p = profile(`p_new${String(this.counter)}`, args.name, { kind: args.kind, accent: args.accent });
      this.profiles.push(p);
      this.tools.set(p.id, []);
      this.servers.set(p.id, []);
      this.active ??= p.id;
      return p;
    });

  profileUpdate: VisionClient["profileUpdate"] = (args) =>
    this.answer("profileUpdate", args, () => {
      const p = this.profiles.find((x) => x.id === args.id);
      if (!p) throw new VisionIpcError("not_found", "Profile not found");
      Object.assign(p, {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.accent ? { accent: args.accent } : {}),
      });
      return { ...p };
    });

  profileDelete: VisionClient["profileDelete"] = (args) =>
    this.answer("profileDelete", args, () => {
      this.profiles = this.profiles.filter((p) => p.id !== args.id);
      if (this.active === args.id) this.active = this.profiles[0]?.id ?? null;
      return null;
    });

  profileSetActive: VisionClient["profileSetActive"] = (args) =>
    this.answer("profileSetActive", args, () => {
      this.active = args.id;
      return null;
    });

  profileOpenTerminal: VisionClient["profileOpenTerminal"] = (args) =>
    this.answer("profileOpenTerminal", args, () => null);

  toolsList: VisionClient["toolsList"] = (args) =>
    this.answer("toolsList", args, () => this.toolList(args.profile_id).map((v) => ({ ...v })));

  toolCheck: VisionClient["toolCheck"] = (args) =>
    this.answer("toolCheck", args, () => {
      const list = this.toolList(args.profile_id);
      const index = list.findIndex((v) => v.spec.id === args.tool_id);
      const current = list[index];
      if (!current) throw new VisionIpcError("not_found", "Tool not found");
      const queue = this.checkQueue.get(`${args.profile_id}/${args.tool_id}`);
      const next = queue && queue.length > 0 ? queue.shift() : current.status;
      const view = toolView(current.spec, next ?? { status: "signed_out" }, current.version ?? "1.0.0");
      list[index] = view;
      return { ...view };
    });

  toolSignIn: VisionClient["toolSignIn"] = (args) => this.answer("toolSignIn", args, () => null);
  toolSignOut: VisionClient["toolSignOut"] = (args) => this.answer("toolSignOut", args, () => null);
  toolOpenInstallPage: VisionClient["toolOpenInstallPage"] = (args) =>
    this.answer("toolOpenInstallPage", args, () => null);

  customToolSave: VisionClient["customToolSave"] = (args) =>
    this.answer("customToolSave", args, () => {
      const t = args.tool;
      const spec = toolSpec(t.id, t.name, {
        binary: t.binary,
        builtin: false,
        isolation: "unverified",
        install_url: t.install_url ?? null,
        login: t.login,
        logout: t.logout ?? null,
        status: t.status ?? null,
        description: t.description ?? "",
      });
      for (const list of this.tools.values()) list.push(toolView(spec, null));
      return spec;
    });

  customToolDelete: VisionClient["customToolDelete"] = (args) =>
    this.answer("customToolDelete", args, () => {
      for (const [id, list] of this.tools) {
        this.tools.set(
          id,
          list.filter((v) => v.spec.id !== args.tool_id),
        );
      }
      return null;
    });

  mcpList: VisionClient["mcpList"] = (args) =>
    this.answer("mcpList", args, () => structuredClone(this.servers.get(args.profile_id) ?? []));

  mcpSave: VisionClient["mcpSave"] = (args) =>
    this.answer("mcpSave", args, () => {
      const list = this.servers.get(args.profile_id) ?? [];
      const input: McpServerInput = args.server;
      this.counter += 1;
      const old = input.id ? list.find((s) => s.id === input.id) : undefined;
      const entryView = (e: KeyValueInput): KeyValueView =>
        e.value.kind === "plain"
          ? { key: e.key, value: { kind: "plain", value: e.value.value } }
          : { key: e.key, value: { kind: "secret", has_value: true } };
      const view = server(old?.id ?? `m_new${String(this.counter)}`, input.name, {
        transport:
          input.transport.kind === "stdio"
            ? {
                kind: "stdio",
                command: input.transport.command,
                args: input.transport.args,
                env: input.transport.env.map(entryView),
              }
            : { kind: "http", url: input.transport.url, headers: input.transport.headers.map(entryView) },
        tool_ids: input.tool_ids,
        enabled: input.enabled,
      });
      this.servers.set(
        args.profile_id,
        old ? list.map((s) => (s.id === old.id ? view : s)) : [...list, view],
      );
      return structuredClone(view);
    });

  mcpDelete: VisionClient["mcpDelete"] = (args) =>
    this.answer("mcpDelete", args, () => {
      const list = this.servers.get(args.profile_id) ?? [];
      this.servers.set(
        args.profile_id,
        list.filter((s) => s.id !== args.server_id),
      );
      return null;
    });

  mcpTest: VisionClient["mcpTest"] = (args) =>
    this.answer("mcpTest", args, () => {
      const list = this.servers.get(args.profile_id) ?? [];
      const s = list.find((x) => x.id === args.server_id);
      if (!s) throw new VisionIpcError("not_found", "Server not found");
      const health = this.testResults.get(s.id);
      if (health) s.health = health;
      return structuredClone(s);
    });

  mcpSyncClaude: VisionClient["mcpSyncClaude"] = (args) =>
    this.answer("mcpSyncClaude", args, () => structuredClone(this.syncReport));

  mcpAuthorize: VisionClient["mcpAuthorize"] = (args) => this.answer("mcpAuthorize", args, () => null);
}

/** Two profiles: Work (active, two tools, one server) and Personal (one tool, no servers). */
export function standardFake(): FakeClient {
  const fake = new FakeClient();
  fake.profiles = [
    profile("p_work", "Work", { kind: "work", accent: "teal" }),
    profile("p_home", "Personal", { kind: "personal", accent: "iris" }),
  ];
  fake.active = "p_work";
  const claude = toolSpec("claude", "Claude Code");
  const gh = toolSpec("gh", "GitHub CLI");
  const codex = toolSpec("codex", "Codex");
  fake.tools.set("p_work", [
    toolView(claude, { status: "signed_in", account: "dev@work.example" }),
    toolView(gh, { status: "signed_out" }),
  ]);
  fake.tools.set("p_home", [toolView(codex, { status: "signed_out" })]);
  fake.servers.set("p_work", [
    server("m_files", "filesystem", {
      transport: {
        kind: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem"],
        env: [
          { key: "LOG_LEVEL", value: { kind: "plain", value: "info" } },
          { key: "API_TOKEN", value: { kind: "secret", has_value: true } },
        ],
      },
      health: {
        status: "ok",
        message: null,
        tools: [
          { name: "read_file", description: "Read a file. <img src=x onerror=alert(1)>" },
          { name: "list_directory", description: null },
        ],
        server_name: "fs",
        server_version: "1.0.0",
        checked_at: "2026-11-14T08:00:00Z",
      },
    }),
  ]);
  fake.servers.set("p_home", []);
  return fake;
}
