// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  IPC_COMMANDS,
  VisionIpcError,
  bootstrap,
  mcpSave,
  profileCreate,
  toIpcError,
  toolCheck,
} from "../../src/ipc/client";

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

describe("ipc client", () => {
  it("passes snake_case arguments to the named command", async () => {
    invokeMock.mockResolvedValue({ id: "p_abcdefghijkl" });
    await profileCreate({ name: "Work", kind: "work", accent: "iris" });
    expect(invokeMock).toHaveBeenCalledWith("profile_create", {
      name: "Work",
      kind: "work",
      accent: "iris",
    });
  });

  it("passes nested inputs unchanged", async () => {
    invokeMock.mockResolvedValue({});
    const server = {
      name: "files",
      transport: { kind: "stdio" as const, command: "npx", args: [], env: [] },
      tool_ids: [],
      enabled: true,
    };
    await mcpSave({ profile_id: "p_abcdefghijkl", server });
    expect(invokeMock).toHaveBeenCalledWith("mcp_save", { profile_id: "p_abcdefghijkl", server });
  });

  it("calls commands without arguments with no argument object", async () => {
    invokeMock.mockResolvedValue({ profiles: [], active_profile_id: null, platform: "linux" });
    await bootstrap();
    expect(invokeMock).toHaveBeenCalledWith("bootstrap", undefined);
  });

  it("keeps the code and message of a core error", async () => {
    invokeMock.mockRejectedValue({ code: "schema_too_new", message: "Update Vision" });
    await expect(bootstrap()).rejects.toEqual(new VisionIpcError("schema_too_new", "Update Vision"));
  });

  it("rejects with a VisionIpcError instance", async () => {
    invokeMock.mockRejectedValue({ code: "not_found", message: "Tool not found" });
    await expect(toolCheck({ profile_id: "p_abcdefghijkl", tool_id: "x" })).rejects.toBeInstanceOf(
      VisionIpcError,
    );
  });

  it("maps a string rejection to internal", () => {
    expect(toIpcError("command mcp_foo not found")).toMatchObject({
      code: "internal",
      message: "command mcp_foo not found",
    });
  });

  it("maps an unknown error code to internal", () => {
    expect(toIpcError({ code: "boom", message: "x" }).code).toBe("internal");
  });

  it("maps undefined to internal with a generic message", () => {
    expect(toIpcError(undefined)).toMatchObject({ code: "internal" });
  });

  it("lists the same commands as the capability file", () => {
    const cap = JSON.parse(
      readFileSync(join(resolve(__dirname, "../.."), "src-tauri/capabilities/main.json"), "utf8"),
    ) as { permissions: string[] };
    expect(IPC_COMMANDS.map((c) => `allow-${c.replaceAll("_", "-")}`)).toEqual(cap.permissions);
  });
});
