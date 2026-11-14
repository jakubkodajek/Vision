/**
 * Development-only in-memory client, used by `npm run dev` in a plain browser where there is
 * no Tauri core. Never part of a production build: `main.tsx` imports it only behind
 * `import.meta.env.DEV`, and the build is checked for {@link DEV_MOCK_MARKER}.
 *
 * Scenarios via the URL: `?mock=welcome` (no profiles), `?mock=error` (schema_too_new),
 * `?mock=slow` (long latency); default is two profiles with mixed states.
 */
import type { VisionClient } from "../data/client";
import type {
  McpServerInput,
  McpServerView,
  Profile,
  ToolSpecView,
  ToolStatus,
  ToolView,
  KeyValueInput,
  KeyValueView,
} from "../ipc/bindings";
import { VisionIpcError } from "../ipc/client";

/** Marker string; its absence from `dist/` proves the mock is tree-shaken out. */
export const DEV_MOCK_MARKER = "__VISION_DEV_MOCK_CLIENT__";

function spec(partial: Partial<ToolSpecView> & Pick<ToolSpecView, "id" | "name" | "binary">): ToolSpecView {
  return {
    description: "",
    install_url: null,
    config_env: [],
    login: ["login"],
    logout: ["logout"],
    status: ["status"],
    status_parser: "exit_code",
    isolation: "unverified",
    builtin: true,
    ...partial,
  };
}

const PRESETS: ToolSpecView[] = [
  spec({
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    description: "Anthropic's coding agent in your terminal.",
    install_url: "https://code.claude.com/docs/en/setup",
    config_env: [{ var: "CLAUDE_CONFIG_DIR", kind: "dir", rel: "" }],
    login: ["auth", "login"],
    logout: ["auth", "logout"],
    status_parser: "claude",
    isolation: "verified",
  }),
  spec({
    id: "codex",
    name: "Codex",
    binary: "codex",
    description: "OpenAI's coding agent CLI.",
    install_url: "https://developers.openai.com/codex/cli",
    config_env: [{ var: "CODEX_HOME", kind: "dir", rel: "" }],
    status_parser: "codex",
    isolation: "verified",
  }),
  spec({
    id: "gh",
    name: "GitHub CLI",
    binary: "gh",
    description: "Pull requests, issues and repositories from the terminal.",
    install_url: "https://cli.github.com/",
    config_env: [{ var: "GH_CONFIG_DIR", kind: "dir", rel: "" }],
    status_parser: "gh",
    isolation: "verified",
  }),
  spec({
    id: "gcloud",
    name: "Google Cloud CLI",
    binary: "gcloud",
    description: "Google Cloud projects and services.",
    install_url: "https://cloud.google.com/sdk/docs/install",
    config_env: [{ var: "CLOUDSDK_CONFIG", kind: "dir", rel: "" }],
    status_parser: "gcloud",
  }),
  spec({
    id: "azure",
    name: "Azure CLI",
    binary: "az",
    description: "Microsoft Azure subscriptions and resources.",
    install_url: "https://learn.microsoft.com/cli/azure/install-azure-cli",
    config_env: [{ var: "AZURE_CONFIG_DIR", kind: "dir", rel: "" }],
    status_parser: "azure",
  }),
  spec({
    id: "aws",
    name: "AWS CLI",
    binary: "aws",
    description: "Amazon Web Services accounts and resources.",
    install_url: "https://aws.amazon.com/cli/",
    logout: null,
    status_parser: "aws",
  }),
];

type Cached = {
  status: ToolStatus | null;
  version: string | null;
  path: string | null;
};

interface ProfileData {
  tools: Map<string, Cached>;
  servers: McpServerView[];
  /** Tools that turn signed in after a few checks (simulated terminal sign-in). */
  signingIn: Map<string, number>;
  signingOut: Map<string, number>;
}

const signedIn = (account: string | null, warning?: string): ToolStatus =>
  warning ? { status: "signed_in", account, warning } : { status: "signed_in", account };

function makeServer(
  partial: Partial<McpServerView> & Pick<McpServerView, "id" | "name" | "transport">,
): McpServerView {
  return {
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
    ...partial,
  };
}

function seed(): {
  profiles: Profile[];
  active: string | null;
  data: Map<string, ProfileData>;
} {
  const scenario = new URLSearchParams(window.location.search).get("mock");
  if (scenario === "welcome") return { profiles: [], active: null, data: new Map() };
  const profiles: Profile[] = [
    {
      id: "p_work00000001",
      name: "Work",
      kind: "work",
      accent: "teal",
      created_at: "2026-11-01T09:00:00Z",
    },
    {
      id: "p_pers00000001",
      name: "Personal",
      kind: "personal",
      accent: "iris",
      created_at: "2026-11-02T09:00:00Z",
    },
  ];
  const work: ProfileData = {
    tools: new Map<string, Cached>([
      [
        "claude",
        {
          status: signedIn("alex.morgan@a-very-long-company-name.example.com"),
          version: "2.3.14 (Claude Code)",
          path: "/opt/homebrew/bin/claude",
        },
      ],
      [
        "codex",
        {
          status: { status: "signed_out" },
          version: "codex-cli 0.98.0",
          path: "/opt/homebrew/bin/codex",
        },
      ],
      [
        "gh",
        {
          status: signedIn(
            "octo-work",
            "Signed in with a token from GH_TOKEN in a parent shell; it is ignored here.",
          ),
          version: "gh version 2.83.1",
          path: "/opt/homebrew/bin/gh",
        },
      ],
      ["gcloud", { status: { status: "not_installed" }, version: null, path: null }],
      ["azure", { status: null, version: null, path: null }],
      [
        "aws",
        {
          status: {
            status: "unknown",
            message: "configure list printed no profile table",
          },
          version: "aws-cli/2.31.2",
          path: "/usr/local/bin/aws",
        },
      ],
    ]),
    servers: [
      makeServer({
        id: "m_files0000001",
        name: "filesystem",
        transport: {
          kind: "stdio",
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/Users/alex/Projects/vision-workspace/really/long/path",
          ],
          env: [
            { key: "LOG_LEVEL", value: { kind: "plain", value: "info" } },
            { key: "API_TOKEN", value: { kind: "secret", has_value: true } },
          ],
        },
        tool_ids: ["gh"],
        health: {
          status: "ok",
          message: null,
          tools: [
            {
              name: "read_file",
              description: "Read the complete contents of a file from the file system.",
            },
            {
              name: "write_file",
              description: "Create a new file or overwrite an existing file. <b>Use with care.</b>",
            },
            {
              name: "list_directory",
              description: "List files and directories in a path.",
            },
            { name: "search_files", description: null },
          ],
          server_name: "secure-filesystem-server",
          server_version: "0.6.2",
          checked_at: "2026-11-14T08:00:00Z",
        },
      }),
      makeServer({
        id: "m_linear000001",
        name: "linear",
        transport: {
          kind: "http",
          url: "https://mcp.linear.app/mcp",
          headers: [
            {
              key: "Authorization",
              value: { kind: "secret", has_value: true },
            },
          ],
        },
        health: {
          status: "needs_auth",
          message: "The server answered 401 Unauthorized",
          tools: [],
          server_name: null,
          server_version: null,
          checked_at: "2026-11-14T08:01:00Z",
        },
      }),
      makeServer({
        id: "m_broken000001",
        name: "local-db",
        transport: {
          kind: "stdio",
          command: "/usr/local/bin/db-mcp",
          args: ["--readonly"],
          env: [],
        },
        enabled: false,
        health: {
          status: "error",
          message: "The server exited before answering initialize (exit code 1)",
          tools: [],
          server_name: null,
          server_version: null,
          checked_at: "2026-11-14T08:02:00Z",
        },
      }),
    ],
    signingIn: new Map(),
    signingOut: new Map(),
  };
  const personal: ProfileData = {
    tools: new Map(PRESETS.map((t) => [t.id, { status: null, version: null, path: null }])),
    servers: [],
    signingIn: new Map(),
    signingOut: new Map(),
  };
  return {
    profiles,
    active: profiles[0]?.id ?? null,
    data: new Map([
      ["p_work00000001", work],
      ["p_pers00000001", personal],
    ]),
  };
}

function entryView(e: KeyValueInput, old: readonly KeyValueView[]): KeyValueView {
  if (e.value.kind === "plain") return { key: e.key, value: { kind: "plain", value: e.value.value } };
  const kept = old.find((o) => o.key === e.key && o.value.kind === "secret");
  const hasValue = e.value.value !== undefined || (kept?.value.kind === "secret" && kept.value.has_value);
  return { key: e.key, value: { kind: "secret", has_value: hasValue } };
}

/** Creates the dev mock client with realistic seeded data. */
export function createDevMockClient(): VisionClient {
  console.info(`[${DEV_MOCK_MARKER}] Vision is running in a browser with mock data; nothing reaches a core.`);
  const scenario = new URLSearchParams(window.location.search).get("mock");
  const latency = scenario === "slow" ? 2500 : 450;
  const state = seed();
  const custom: ToolSpecView[] = [];
  let counter = 0;

  const wait = <T>(value: () => T, ms = latency): Promise<T> =>
    new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(value());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, ms);
    });
  const fail = (code: VisionIpcError["code"], message: string): never => {
    throw new VisionIpcError(code, message);
  };
  const profileData = (id: string): ProfileData => {
    const d = state.data.get(id);
    if (!d) return fail("not_found", "Profile not found");
    return d;
  };
  const allTools = () => [...PRESETS, ...custom];
  const toolView = (pid: string, t: ToolSpecView): ToolView => {
    const c = profileData(pid).tools.get(t.id) ?? {
      status: null,
      version: null,
      path: null,
    };
    return {
      spec: t,
      status: c.status,
      version: c.version,
      binary_path: c.path,
      checked_at: c.status ? "2026-11-14T08:00:00Z" : null,
    };
  };
  const findTool = (id: string) => allTools().find((t) => t.id === id) ?? fail("not_found", "Tool not found");

  return {
    appInfo: () => wait(() => ({ name: "Vision", version: "0.1.0-dev" }), 50),
    bootstrap: () =>
      wait(() => {
        if (scenario === "error")
          fail(
            "schema_too_new",
            "The database was written by a newer version of Vision (schema 7, this build knows 3)",
          );
        return {
          profiles: [...state.profiles],
          active_profile_id: state.active,
          platform: "macos" as const,
        };
      }),
    profileCreate: (args) =>
      wait(() => {
        const name = args.name.trim();
        if (state.profiles.some((p) => p.name.toLowerCase() === name.toLowerCase()))
          fail("conflict", "A profile with this name already exists");
        counter += 1;
        const p: Profile = {
          id: `p_new${String(counter).padStart(9, "0")}`,
          name,
          kind: args.kind,
          accent: args.accent,
          created_at: new Date().toISOString(),
        };
        state.profiles.push(p);
        state.data.set(p.id, {
          tools: new Map(),
          servers: [],
          signingIn: new Map(),
          signingOut: new Map(),
        });
        state.active ??= p.id;
        return p;
      }),
    profileUpdate: (args) =>
      wait(() => {
        const p = state.profiles.find((x) => x.id === args.id) ?? fail("not_found", "Profile not found");
        if (args.name !== undefined) p.name = args.name.trim();
        if (args.kind) p.kind = args.kind;
        if (args.accent) p.accent = args.accent;
        return { ...p };
      }),
    profileDelete: (args) =>
      wait(() => {
        const p = state.profiles.find((x) => x.id === args.id) ?? fail("not_found", "Profile not found");
        if (args.confirm_name !== p.name)
          fail("invalid_input", "The confirmation does not match the profile name");
        state.profiles = state.profiles.filter((x) => x.id !== p.id);
        state.data.delete(p.id);
        if (state.active === p.id) state.active = state.profiles[0]?.id ?? null;
        return null;
      }),
    profileSetActive: (args) =>
      wait(() => {
        state.active = args.id;
        return null;
      }, 60),
    profileOpenTerminal: () => wait(() => null, 200),
    toolsList: (args) => wait(() => allTools().map((t) => toolView(args.profile_id, t)), 150),
    toolCheck: (args) =>
      wait(
        () => {
          const d = profileData(args.profile_id);
          const t = findTool(args.tool_id);
          const c = d.tools.get(t.id) ?? {
            status: { status: "signed_out" },
            version: "1.0.0",
            path: `/usr/local/bin/${t.binary}`,
          };
          const pending = d.signingIn.get(t.id);
          if (pending !== undefined) {
            if (pending <= 1) {
              d.signingIn.delete(t.id);
              c.status = signedIn("alex@example.com");
            } else d.signingIn.set(t.id, pending - 1);
          }
          const out = d.signingOut.get(t.id);
          if (out !== undefined) {
            d.signingOut.delete(t.id);
            c.status = { status: "signed_out" };
          }
          if (c.status === null) c.status = { status: "signed_out" };
          d.tools.set(t.id, c);
          return toolView(args.profile_id, t);
        },
        latency + Math.round(Math.random() * 900),
      ),
    toolSignIn: (args) =>
      wait(() => {
        profileData(args.profile_id).signingIn.set(args.tool_id, 3);
        return null;
      }),
    toolSignOut: (args) =>
      wait(() => {
        profileData(args.profile_id).signingOut.set(args.tool_id, 1);
        return null;
      }),
    toolOpenInstallPage: () => wait(() => null, 100),
    customToolSave: (args) =>
      wait(() => {
        const t = args.tool;
        if (PRESETS.some((p) => p.id === t.id)) fail("conflict", "This id belongs to a built-in tool");
        if (t.binary.includes("/"))
          fail(
            "invalid_input",
            "The binary must be a plain program name (letters, digits, '.', '_', '+', '-'), without a path or shell characters",
          );
        const s = spec({
          id: t.id,
          name: t.name,
          binary: t.binary,
          description: t.description ?? "",
          install_url: t.install_url ?? null,
          config_env: [{ var: t.config_var, kind: t.config_kind, rel: "" }],
          login: t.login,
          logout: t.logout ?? null,
          status: t.status ?? null,
          builtin: false,
        });
        const i = custom.findIndex((c) => c.id === s.id);
        if (i >= 0) custom[i] = s;
        else custom.push(s);
        return s;
      }),
    customToolDelete: (args) =>
      wait(() => {
        const i = custom.findIndex((c) => c.id === args.tool_id);
        if (i < 0) fail("not_found", "Tool not found");
        custom.splice(i, 1);
        return null;
      }),
    mcpList: (args) => wait(() => profileData(args.profile_id).servers.map((s) => structuredClone(s)), 200),
    mcpSave: (args) =>
      wait(() => {
        const d = profileData(args.profile_id);
        const input: McpServerInput = args.server;
        if (d.servers.some((s) => s.name.toLowerCase() === input.name.toLowerCase() && s.id !== input.id))
          fail("conflict", "An MCP server with this name already exists in this profile");
        const old = input.id ? d.servers.find((s) => s.id === input.id) : undefined;
        const oldEntries = old
          ? old.transport.kind === "stdio"
            ? old.transport.env
            : old.transport.headers
          : [];
        counter += 1;
        const view = makeServer({
          id: old?.id ?? `m_new${String(counter).padStart(9, "0")}`,
          name: input.name,
          transport:
            input.transport.kind === "stdio"
              ? {
                  kind: "stdio",
                  command: input.transport.command,
                  args: input.transport.args,
                  env: input.transport.env.map((e) => entryView(e, oldEntries)),
                }
              : {
                  kind: "http",
                  url: input.transport.url,
                  headers: input.transport.headers.map((e) => entryView(e, oldEntries)),
                },
          tool_ids: input.tool_ids,
          enabled: input.enabled,
        });
        d.servers = old ? d.servers.map((s) => (s.id === old.id ? view : s)) : [...d.servers, view];
        return structuredClone(view);
      }),
    mcpDelete: (args) =>
      wait(() => {
        const d = profileData(args.profile_id);
        d.servers = d.servers.filter((s) => s.id !== args.server_id);
        return null;
      }),
    mcpTest: (args) =>
      wait(() => {
        const d = profileData(args.profile_id);
        const s = d.servers.find((x) => x.id === args.server_id) ?? fail("not_found", "Server not found");
        s.health =
          s.transport.kind === "http"
            ? {
                status: "needs_auth",
                message: "The server answered 401 Unauthorized",
                tools: [],
                server_name: null,
                server_version: null,
                checked_at: new Date().toISOString(),
              }
            : {
                status: "ok",
                message: null,
                tools: [{ name: "ping", description: "Answers pong." }],
                server_name: s.name,
                server_version: "1.0.0",
                checked_at: new Date().toISOString(),
              };
        return structuredClone(s);
      }, 1500),
    mcpSyncClaude: (args) =>
      wait(() => {
        const d = profileData(args.profile_id);
        return {
          synced: d.servers.filter((s) => s.enabled).map((s) => s.name),
          removed: d.servers.filter((s) => !s.enabled).map((s) => s.name),
          failed: [],
        };
      }, 1200),
    mcpAuthorize: () => wait(() => null, 300),
  };
}
