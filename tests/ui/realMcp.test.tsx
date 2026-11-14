import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { card, findCard, renderApp, settled } from "./appHarness";
import { server, standardFake, type FakeClient } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
});

async function openMcp(fake: FakeClient): Promise<void> {
  renderApp(fake);
  fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
  await settled(findCard("filesystem"));
}

async function openAdd(fake: FakeClient): Promise<HTMLElement> {
  await openMcp(fake);
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  return screen.getByRole("dialog", { name: "Add MCP server" });
}

async function openEdit(fake: FakeClient): Promise<HTMLElement> {
  await openMcp(fake);
  fireEvent.click(screen.getByRole("button", { name: "Edit filesystem" }));
  return screen.getByRole("dialog", { name: "Edit filesystem" });
}

function withHttpServer(): FakeClient {
  const fake = standardFake();
  fake.servers.get("p_work")?.push(
    server("m_issues", "issues", {
      transport: { kind: "http", url: "https://mcp.example.com/mcp", headers: [] },
      health: {
        status: "needs_auth",
        message: "The server asks for authorization",
        tools: [],
        server_name: null,
        server_version: null,
        checked_at: "2026-11-14T08:00:00Z",
      },
    }),
  );
  return fake;
}

describe("server list", () => {
  it("shows_each_server_with_transport_and_health", async () => {
    await openMcp(standardFake());
    const row = card("filesystem");
    expect(within(row).getByText("stdio")).toBeInTheDocument();
    expect(within(row).getByText("Working")).toBeInTheDocument();
    expect(within(row).getByText("2 tools")).toBeInTheDocument();
  });

  it("lists_the_tools_when_expanded", async () => {
    await openMcp(standardFake());
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Show tools (2)" }));
    expect(within(card("filesystem")).getByText("list_directory")).toBeVisible();
    expect(within(card("filesystem")).getByRole("button", { name: "Hide tools (2)" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("renders_tool_descriptions_as_plain_text", async () => {
    await openMcp(standardFake());
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Show tools (2)" }));
    expect(within(card("filesystem")).getByText("Read a file. <img src=x onerror=alert(1)>")).toBeVisible();
    expect(card("filesystem").querySelector("img")).toBeNull();
  });

  it("shows_the_empty_state", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Personal/ }));
    await settled(screen.findByText("Personal · Personal profile"));
    fireEvent.click(screen.getByRole("button", { name: "MCP servers" }));
    expect(await settled(screen.findByText("No MCP servers yet"))).toBeInTheDocument();
  });

  it("shows_an_error_with_retry_when_the_list_fails", async () => {
    const fake = standardFake().fail("mcpList", "io", "Database locked");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    expect(await settled(screen.findByText("Could not load the MCP servers"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await settled(findCard("filesystem"))).toBeInTheDocument();
  });
});

describe("add server", () => {
  it("adds_a_stdio_server_with_a_secret_variable", async () => {
    const fake = standardFake();
    const dialog = await openAdd(fake);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "github" } });
    fireEvent.change(within(dialog).getByLabelText("Command", { exact: true }), { target: { value: "npx" } });
    fireEvent.change(within(dialog).getByLabelText(/^Arguments/), {
      target: { value: "-y\n@github/mcp" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add variable" }));
    fireEvent.change(within(dialog).getByLabelText("Variable 1 name"), { target: { value: "GH_TOKEN" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Variable 1 is secret" }));
    fireEvent.change(within(dialog).getByLabelText("Variable 1 value"), { target: { value: "ghp_x" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Claude Code" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    expect(await settled(findCard("github"))).toBeInTheDocument();
    expect(fake.calls("mcpSave")).toEqual([
      {
        profile_id: "p_work",
        server: {
          name: "github",
          transport: {
            kind: "stdio",
            command: "npx",
            args: ["-y", "@github/mcp"],
            env: [{ key: "GH_TOKEN", value: { kind: "secret", value: "ghp_x" } }],
          },
          tool_ids: ["claude"],
          enabled: true,
        },
      },
    ]);
  });

  it("masks_a_secret_value_while_typing", async () => {
    const dialog = await openAdd(standardFake());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add variable" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Variable 1 is secret" }));
    expect(within(dialog).getByLabelText("Variable 1 value")).toHaveAttribute("type", "password");
  });

  it("adds_an_http_server", async () => {
    const fake = standardFake();
    const dialog = await openAdd(fake);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "issues" } });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Remote (HTTP)" }));
    fireEvent.change(within(dialog).getByLabelText("URL"), { target: { value: "https://mcp.example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    expect(await settled(findCard("issues"))).toBeInTheDocument();
    expect(fake.calls("mcpSave")).toEqual([
      {
        profile_id: "p_work",
        server: {
          name: "issues",
          transport: { kind: "http", url: "https://mcp.example.com", headers: [] },
          tool_ids: [],
          enabled: true,
        },
      },
    ]);
  });

  it("shows_errors_under_the_invalid_fields", async () => {
    const fake = standardFake();
    const dialog = await openAdd(fake);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription(/Enter a name\./);
    expect(fake.calls("mcpSave")).toHaveLength(0);
  });

  it("rejects_plain_http_for_a_remote_host", async () => {
    const dialog = await openAdd(standardFake());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Remote (HTTP)" }));
    fireEvent.change(within(dialog).getByLabelText("URL"), { target: { value: "http://example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    expect(within(dialog).getByLabelText("URL")).toHaveAccessibleDescription(/only allowed for localhost/);
  });

  it("shows_a_name_conflict_under_the_name_field", async () => {
    const fake = standardFake().fail("mcpSave", "conflict", "A server with this name already exists");
    const dialog = await openAdd(fake);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "filesystem" } });
    fireEvent.change(within(dialog).getByLabelText("Command", { exact: true }), { target: { value: "npx" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    await settled(within(dialog).findByText("A server with this name already exists"));
    expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription(
      /A server with this name already exists/,
    );
  });

  it("explains_secret_store_unavailable", async () => {
    const fake = standardFake().fail("mcpSave", "secret_store_unavailable", "No keyring");
    const dialog = await openAdd(fake);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "github" } });
    fireEvent.change(within(dialog).getByLabelText("Command", { exact: true }), { target: { value: "npx" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    const alert = await settled(within(dialog).findByRole("alert"));
    expect(alert).toHaveTextContent("Could not add the server");
    expect(alert).toHaveTextContent("Nothing was saved");
  });
});

describe("edit server", () => {
  it("shows_a_stored_secret_as_hidden_without_its_value", async () => {
    const dialog = await openEdit(standardFake());
    expect(within(dialog).getByText("Stored (hidden)")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Variable 2 value")).toBeNull();
    expect(within(dialog).getByLabelText("Variable 1 value")).toHaveValue("info");
  });

  it("keeps_a_stored_secret_that_was_not_replaced", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settled(findCard("filesystem"));
    expect(fake.calls("mcpSave")).toMatchObject([
      {
        server: {
          id: "m_files",
          transport: {
            env: [
              { key: "LOG_LEVEL", value: { kind: "plain", value: "info" } },
              { key: "API_TOKEN", value: { kind: "secret" } },
            ],
          },
        },
      },
    ]);
  });

  it("sends_the_new_value_after_replace", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fireEvent.click(within(dialog).getByRole("button", { name: "Replace API_TOKEN" }));
    fireEvent.change(within(dialog).getByLabelText("Variable 2 value"), { target: { value: "new-token" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settled(findCard("filesystem"));
    expect(fake.calls("mcpSave")).toMatchObject([
      {
        server: {
          transport: {
            env: [{ key: "LOG_LEVEL" }, { key: "API_TOKEN", value: { kind: "secret", value: "new-token" } }],
          },
        },
      },
    ]);
  });
});

describe("server actions", () => {
  it("shows_a_spinner_while_testing", async () => {
    const fake = standardFake().hold("mcpTest");
    await openMcp(fake);
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    expect(within(card("filesystem")).getByRole("status")).toHaveTextContent("Testing…");
  });

  it("shows_the_test_result", async () => {
    const fake = standardFake();
    fake.testResults.set("m_files", {
      status: "error",
      message: "The command exited with code 1",
      tools: [],
      server_name: null,
      server_version: null,
      checked_at: "2026-11-14T09:00:00Z",
    });
    await openMcp(fake);
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    expect(
      await settled(within(card("filesystem")).findByText("The command exited with code 1")),
    ).toBeVisible();
  });

  it("shows_an_error_when_the_test_cannot_run", async () => {
    const fake = standardFake().fail("mcpTest", "io", "Could not start npx");
    await openMcp(fake);
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    const alert = await settled(within(card("filesystem")).findByRole("alert"));
    expect(alert).toHaveTextContent("Could not run the test");
    expect(alert).toHaveTextContent("Could not start npx");
  });

  it("disables_a_server_with_the_switch", async () => {
    const fake = standardFake();
    await openMcp(fake);
    fireEvent.click(within(card("filesystem")).getByRole("switch"));
    await settled(Promise.resolve());
    expect(within(card("filesystem")).getByRole("switch")).not.toBeChecked();
    expect(fake.calls("mcpSave")).toMatchObject([{ server: { id: "m_files", enabled: false } }]);
  });

  it("deletes_a_server_after_confirmation", async () => {
    const fake = standardFake();
    await openMcp(fake);
    fireEvent.click(screen.getByRole("button", { name: "Delete filesystem" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete filesystem?" })).getByRole("button", {
        name: "Delete server",
      }),
    );
    expect(await settled(screen.findByText("No MCP servers yet"))).toBeInTheDocument();
    expect(fake.calls("mcpDelete")).toEqual([{ profile_id: "p_work", server_id: "m_files" }]);
  });

  it("keeps_the_server_when_delete_fails", async () => {
    const fake = standardFake().fail("mcpDelete", "io", "Disk full");
    await openMcp(fake);
    fireEvent.click(screen.getByRole("button", { name: "Delete filesystem" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete filesystem?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete server" }));
    expect(await settled(within(dialog).findByRole("alert"))).toHaveTextContent("Disk full");
    expect(card("filesystem")).toBeInTheDocument();
  });

  it("offers_authorize_only_for_http_servers", async () => {
    await openMcp(withHttpServer());
    expect(within(card("issues")).getByRole("button", { name: "Authorize" })).toBeInTheDocument();
    expect(within(card("filesystem")).queryByRole("button", { name: "Authorize" })).toBeNull();
  });

  it("opens_the_authorization_in_the_terminal", async () => {
    const fake = withHttpServer();
    await openMcp(fake);
    fireEvent.click(within(card("issues")).getByRole("button", { name: "Authorize" }));
    expect(
      await settled(within(card("issues")).findByText(/Authorization opened in your terminal/)),
    ).toBeVisible();
    expect(fake.calls("mcpAuthorize")).toEqual([{ profile_id: "p_work", server_id: "m_issues" }]);
  });
});

describe("sync to Claude Code", () => {
  it("warns_that_secret_values_are_written_before_syncing", async () => {
    const fake = standardFake();
    await openMcp(fake);
    fireEvent.click(screen.getByRole("button", { name: "Sync to Claude Code" }));
    const dialog = screen.getByRole("dialog", { name: "Sync to Claude Code" });
    expect(
      within(dialog).getByText(/Secret values are written into that Claude Code configuration/),
    ).toBeVisible();
    expect(fake.calls("mcpSyncClaude")).toHaveLength(0);
  });

  it("shows_the_sync_summary", async () => {
    const fake = standardFake();
    fake.syncReport = {
      synced: ["filesystem"],
      removed: ["old"],
      failed: [{ name: "broken", message: "Bad" }],
    };
    await openMcp(fake);
    fireEvent.click(screen.getByRole("button", { name: "Sync to Claude Code" }));
    const dialog = screen.getByRole("dialog", { name: "Sync to Claude Code" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync now" }));
    expect(await settled(within(dialog).findByText("Synced (1)"))).toBeInTheDocument();
    expect(within(dialog).getByText("Removed from Claude Code (1)")).toBeInTheDocument();
    expect(within(dialog).getByText("Failed (1)")).toBeInTheDocument();
  });

  it("explains_not_installed_when_claude_code_is_missing", async () => {
    const fake = standardFake().fail("mcpSyncClaude", "not_installed", "Claude Code is not installed");
    await openMcp(fake);
    fireEvent.click(screen.getByRole("button", { name: "Sync to Claude Code" }));
    const dialog = screen.getByRole("dialog", { name: "Sync to Claude Code" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync now" }));
    const alert = await settled(within(dialog).findByRole("alert"));
    expect(alert).toHaveTextContent("Could not sync");
    expect(alert).toHaveTextContent("Install it from its official page");
  });
});
