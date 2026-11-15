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

async function openEdit(fake: FakeClient): Promise<HTMLElement> {
  await openMcp(fake);
  fireEvent.click(screen.getByRole("button", { name: "Edit filesystem" }));
  return screen.getByRole("dialog", { name: "Edit filesystem" });
}

async function openAdd(fake: FakeClient): Promise<HTMLElement> {
  await openMcp(fake);
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  return screen.getByRole("dialog", { name: "Add MCP server" });
}

async function settle(): Promise<void> {
  await settled(Promise.resolve());
}

function live(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[data-live="mcp"]');
  if (!region) throw new Error("no mcp live region");
  return region;
}

function needsAuthServer(synced: boolean): FakeClient {
  const fake = standardFake();
  fake.servers.get("p_work")?.push(
    server("m_lin", "linear", {
      transport: {
        kind: "http",
        url: "https://mcp.linear.app/mcp",
        headers: [],
      },
      synced,
      health: {
        status: "needs_auth",
        message: null,
        tools: [],
        server_name: null,
        server_version: null,
        checked_at: "2026-11-14T08:00:00Z",
      },
    }),
  );
  return fake;
}

describe("stored secrets (CR-1)", () => {
  it("does_not_send_an_empty_plain_value_when_secret_is_unticked_on_a_stored_secret", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fireEvent.click(within(dialog).getByLabelText("Variable 2 is secret"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settle();
    expect(fake.calls("mcpSave")).toHaveLength(0);
    expect(within(dialog).getByLabelText("Variable 2 value")).toHaveAccessibleDescription(
      /Enter the new plain value, or tick Secret again to keep the stored one\./,
    );
  });

  it("keeps_the_stored_secret_when_secret_is_ticked_again", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fireEvent.click(within(dialog).getByLabelText("Variable 2 is secret"));
    fireEvent.click(within(dialog).getByLabelText("Variable 2 is secret"));
    expect(within(dialog).getByText("Stored (hidden)")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settle();
    expect(fake.calls("mcpSave")).toMatchObject([
      {
        server: {
          transport: {
            env: [{ key: "LOG_LEVEL" }, { key: "API_TOKEN", value: { kind: "secret" } }],
          },
        },
      },
    ]);
  });
});

describe("destination change", () => {
  it("asks_for_a_stored_secret_again_when_the_command_changes", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fireEvent.change(within(dialog).getByLabelText("Command", { exact: true }), { target: { value: "uvx" } });
    expect(within(dialog).queryByText("Stored (hidden)")).toBeNull();
    expect(
      within(dialog).getByText("Enter this value again because the server address or command changed."),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settle();
    expect(fake.calls("mcpSave")).toHaveLength(0);
  });

  it("does_not_treat_reformatted_arguments_as_a_change", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fireEvent.change(within(dialog).getByLabelText(/^Arguments/), {
      target: { value: "-y\n\n@modelcontextprotocol/server-filesystem\n" },
    });
    expect(within(dialog).getByText("Stored (hidden)")).toBeInTheDocument();
  });
});

describe("row errors (UX-13)", () => {
  it("reports_every_row_problem_on_its_own_input", async () => {
    const dialog = await openAdd(standardFake());
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "web" },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Remote \(HTTP\)/ }));
    fireEvent.change(within(dialog).getByLabelText("URL"), {
      target: { value: "https://mcp.example.com" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add header" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add header" }));
    fireEvent.change(within(dialog).getByLabelText("Header 1 name"), {
      target: { value: "X-Team" },
    });
    fireEvent.change(within(dialog).getByLabelText("Header 1 value"), {
      target: { value: "a" },
    });
    fireEvent.change(within(dialog).getByLabelText("Header 2 name"), {
      target: { value: "x-team" },
    });
    fireEvent.change(within(dialog).getByLabelText("Header 2 value"), {
      target: { value: "b" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    const second = within(dialog).getByLabelText("Header 2 name");
    expect(second).toHaveAttribute("aria-invalid", "true");
    expect(second).toHaveAccessibleDescription(/'x-team' is listed twice/);
    expect(second).toHaveFocus();
  });

  it("shows_a_core_entry_error_on_the_row_it_names", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fake.fail(
      "mcpSave",
      "invalid_input",
      "The value of 'LOG_LEVEL' is not allowed",
      false,
      "env",
      "LOG_LEVEL",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settle();
    expect(within(dialog).getByLabelText("Variable 1 name")).toHaveAccessibleDescription(
      /The value of 'LOG_LEVEL' is not allowed/,
    );
  });

  it("shows_a_core_error_for_a_field_that_is_not_shown_for_the_whole_form", async () => {
    const fake = standardFake();
    const dialog = await openEdit(fake);
    fake.fail("mcpSave", "invalid_input", "The URL has no host", false, "url");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settle();
    expect(within(dialog).getByText("The URL has no host")).toBeInTheDocument();
  });
});

describe("arguments (CR-13)", () => {
  it("keeps_spaces_inside_an_argument_and_drops_empty_lines", async () => {
    const fake = standardFake();
    const dialog = await openAdd(fake);
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "tool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Command", { exact: true }), {
      target: { value: "node" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Arguments/), {
      target: { value: "--title= My App \r\n\n x" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add server" }));
    await settle();
    expect(fake.calls("mcpSave")).toMatchObject([
      { server: { transport: { args: ["--title= My App ", " x"] } } },
    ]);
  });
});

describe("server rows (CR-12, UX-10, UX-19)", () => {
  it("names_each_switch_after_its_server", async () => {
    await openMcp(standardFake());
    expect(
      within(card("filesystem")).getByRole("switch", {
        name: "Enabled: filesystem",
      }),
    ).toBeInTheDocument();
  });

  it("keeps_one_row_error_until_dismissed", async () => {
    const fake = standardFake().fail("mcpTest", "io", "Could not start npx", true);
    await openMcp(fake);
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    await settle();
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    await settle();
    expect(within(card("filesystem")).getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Dismiss" }));
    expect(within(card("filesystem")).queryByRole("alert")).toBeNull();
  });

  it("clears_the_row_error_after_the_next_successful_action", async () => {
    const fake = standardFake().fail("mcpTest", "io", "Could not start npx");
    await openMcp(fake);
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    await settle();
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    await settle();
    expect(within(card("filesystem")).queryByRole("alert")).toBeNull();
  });

  it("shows_the_sync_state_of_each_server", async () => {
    await openMcp(needsAuthServer(false));
    expect(within(card("filesystem")).getByText("Not synced: has secret values")).toBeInTheDocument();
    expect(within(card("linear")).getByText("Not synced")).toBeInTheDocument();
  });

  it("makes_sync_the_primary_action_of_an_unsynced_server_that_needs_authorization", async () => {
    await openMcp(needsAuthServer(false));
    expect(
      within(card("linear")).getByRole("button", {
        name: "Sync to Claude Code",
      }),
    ).toHaveClass("btn-primary");
    expect(within(card("linear")).getByRole("button", { name: "Authorize" })).not.toHaveClass("btn-primary");
  });

  it("makes_authorize_the_primary_action_once_synced", async () => {
    await openMcp(needsAuthServer(true));
    expect(within(card("linear")).getByText("Synced to Claude Code")).toBeInTheDocument();
    expect(within(card("linear")).getByRole("button", { name: "Authorize" })).toHaveClass("btn-primary");
  });

  it("announces_a_test_result", async () => {
    await openMcp(standardFake());
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    await settle();
    expect(live()).toHaveTextContent("filesystem: test finished, working, 2 tools.");
  });
});

describe("sync result", () => {
  async function runSync(fake: FakeClient): Promise<HTMLElement> {
    await openMcp(fake);
    // The header button comes first; a row may offer its own.
    const [headerSync] = screen.getAllByRole("button", {
      name: "Sync to Claude Code",
    });
    if (!headerSync) throw new Error("no sync button");
    fireEvent.click(headerSync);
    const dialog = screen.getByRole("dialog", { name: "Sync to Claude Code" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sync now" }));
    await settled(within(dialog).findByText("Sync finished"));
    return dialog;
  }

  it("lists_skipped_servers_with_the_reason", async () => {
    const fake = standardFake();
    fake.syncReport = {
      synced: [],
      removed: [],
      failed: [],
      skipped: [{ name: "filesystem", reason: "It has secret values." }],
    };
    const dialog = await runSync(fake);
    expect(within(dialog).getByText("Skipped (1)")).toBeInTheDocument();
    expect(within(dialog).getByText(/It has secret values\./)).toBeInTheDocument();
    expect(within(dialog).queryByText(/nothing to sync/)).toBeNull();
  });

  it("moves_focus_to_the_result_heading", async () => {
    const dialog = await runSync(standardFake());
    expect(within(dialog).getByText("Sync finished")).toHaveFocus();
  });

  it("says_what_to_do_next_for_a_synced_server_that_needs_authorization", async () => {
    const fake = needsAuthServer(false);
    fake.syncReport = {
      synced: ["linear"],
      removed: [],
      failed: [],
      skipped: [],
    };
    const dialog = await runSync(fake);
    expect(within(dialog).getByText("Next: select Authorize on linear.")).toBeInTheDocument();
  });

  it("keeps_sync_unavailable_with_an_explanation_when_there_are_no_servers", async () => {
    const fake = standardFake();
    fake.servers.set("p_work", []);
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    await settled(screen.findByText("No MCP servers yet"));
    const sync = screen.getByRole("button", { name: "Sync to Claude Code" });
    expect(sync).toHaveAttribute("aria-disabled", "true");
    expect(sync).toHaveAccessibleDescription(/available once this profile has a server/);
    expect(screen.getAllByRole("button", { name: "Add server" })).toHaveLength(1);
  });
});
