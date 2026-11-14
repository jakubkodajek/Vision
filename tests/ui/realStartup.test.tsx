import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { nav, renderApp, settled } from "./appHarness";
import { FakeClient, standardFake } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("startup", () => {
  it("shows_connecting_state_until_bootstrap_answers", () => {
    const fake = standardFake().hold("bootstrap");
    renderApp(fake);
    expect(screen.getByRole("status")).toHaveTextContent("Connecting to core…");
  });

  it("shows_full_page_error_with_the_core_message_when_the_schema_is_too_new", async () => {
    const fake = standardFake().fail(
      "bootstrap",
      "schema_too_new",
      "The database was written by a newer Vision",
    );
    renderApp(fake);
    const alert = await settled(screen.findByRole("alert"));
    expect(alert).toHaveTextContent("This version of Vision cannot open your data");
    expect(alert).toHaveTextContent("The database was written by a newer Vision");
    expect(alert).toHaveTextContent("Your data has not been changed.");
  });

  it("does_not_render_the_shell_when_startup_fails", async () => {
    const fake = standardFake().fail("bootstrap", "internal", "Core failed to start");
    renderApp(fake);
    await settled(screen.findByRole("alert"));
    expect(screen.queryByRole("navigation", { name: "Sidebar" })).toBeNull();
  });

  it("retries_bootstrap_from_the_startup_error", async () => {
    const fake = standardFake().fail("bootstrap", "io", "Database locked");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Try again" })));
    expect(await settled(screen.findByRole("heading", { level: 2, name: "Home" }))).toBeInTheDocument();
    expect(fake.calls("bootstrap")).toHaveLength(2);
  });

  it("shows_no_demo_projects_runs_or_accounts", async () => {
    renderApp(standardFake());
    await settled(screen.findByRole("heading", { level: 2, name: "Home" }));
    expect(screen.queryByText("Preview data")).toBeNull();
    expect(screen.queryByText(/Build the UI shell/)).toBeNull();
    expect(screen.queryByText(/octo-personal/)).toBeNull();
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull();
  });
});

describe("first run", () => {
  it("shows_the_welcome_screen_when_there_are_no_profiles", async () => {
    renderApp(new FakeClient());
    expect(
      await settled(screen.findByRole("heading", { level: 2, name: "Create your first profile" })),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
  });

  it("creates_the_first_profile_and_lands_on_tools", async () => {
    const fake = new FakeClient();
    renderApp(fake);
    fireEvent.change(await settled(screen.findByRole("textbox", { name: "Name" })), {
      target: { value: "  Work  " },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Personal" }));
    fireEvent.click(screen.getByRole("radio", { name: "Amber" }));
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    expect(await settled(screen.findByRole("heading", { level: 2, name: "Tools" }))).toBeInTheDocument();
    expect(fake.calls("profileCreate")).toEqual([{ name: "Work", kind: "personal", accent: "amber" }]);
  });

  it("asks_for_a_name_without_calling_the_core", async () => {
    const fake = new FakeClient();
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Create profile" })));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAccessibleDescription(
      "Enter a name for the profile.",
    );
    expect(fake.calls("profileCreate")).toEqual([]);
  });

  it("shows_a_conflict_from_the_core_under_the_name", async () => {
    const fake = new FakeClient().fail(
      "profileCreate",
      "conflict",
      "A profile with this name already exists",
    );
    renderApp(fake);
    fireEvent.change(await settled(screen.findByRole("textbox", { name: "Name" })), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    expect(await settled(screen.findByText("A profile with this name already exists"))).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true");
  });

  it("shows_an_unexpected_create_failure_as_a_form_error", async () => {
    const fake = new FakeClient().fail("profileCreate", "io", "Disk full");
    renderApp(fake);
    fireEvent.change(await settled(screen.findByRole("textbox", { name: "Name" })), {
      target: { value: "Work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    const alert = await settled(screen.findByRole("alert"));
    expect(alert).toHaveTextContent("Could not create the profile");
    expect(alert).toHaveTextContent("Disk full");
  });
});

describe("profile switcher", () => {
  it("lists_the_real_profiles_with_their_kind", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    const menu = screen.getByRole("menu", { name: "Profiles" });
    expect(within(menu).getByRole("menuitemradio", { name: /Work/ })).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getByRole("menuitemradio", { name: /Personal/ })).toHaveTextContent(
      "Personal profile",
    );
  });

  it("enables_new_profile_and_manage_profiles", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    expect(screen.getByRole("menuitem", { name: "New profile…" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("menuitem", { name: "Manage profiles" })).not.toHaveAttribute("aria-disabled");
  });

  it("opens_settings_from_manage_profiles", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    fireEvent.click(screen.getByRole("menuitem", { name: "Manage profiles" }));
    expect(screen.getByRole("heading", { level: 3, name: "Profiles" })).toBeInTheDocument();
  });

  it("creates_a_profile_from_the_menu_with_the_keyboard_and_switches_to_it", async () => {
    const fake = standardFake();
    renderApp(fake);
    const button = await settled(screen.findByRole("button", { name: /Switch profile/ }));
    fireEvent.keyDown(button, { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "New profile…" }), { key: "Enter" });
    const dialog = screen.getByRole("dialog", { name: "New profile" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Client" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create profile" }));
    expect(await settled(screen.findByRole("heading", { level: 2, name: "Tools" }))).toBeInTheDocument();
    expect(fake.calls("profileSetActive")).toEqual([{ id: "p_new1" }]);
  });

  it("switches_profile_and_calls_profile_set_active", async () => {
    const fake = standardFake();
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Personal/ }));
    expect(await settled(screen.findByRole("heading", { level: 2, name: "Home" }))).toBeInTheDocument();
    expect(await settled(screen.findByText("Personal · Personal profile"))).toBeInTheDocument();
    expect(fake.calls("profileSetActive")).toEqual([{ id: "p_home" }]);
  });

  it("shows_a_banner_when_switching_fails_and_keeps_the_current_profile", async () => {
    const fake = standardFake().fail("profileSetActive", "not_found", "Profile not found");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Personal/ }));
    expect(await settled(screen.findByText("Could not switch the profile."))).toBeInTheDocument();
    expect(screen.getByText("Work · Work profile")).toBeInTheDocument();
  });

  it("offers_palette_commands_for_sections_profiles_and_the_terminal", async () => {
    renderApp(standardFake());
    await settled(screen.findByRole("heading", { level: 2, name: "Home" }));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const list = screen.getByRole("listbox");
    expect(within(list).getByRole("option", { name: /Go to Tools/ })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /Go to MCP servers/ })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /Use profile Personal/ })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /New profile…/ })).toBeInTheDocument();
    expect(within(list).getByRole("option", { name: /Open terminal for this profile/ })).toBeInTheDocument();
  });

  it("navigates_to_mcp_servers_from_the_palette", async () => {
    renderApp(standardFake());
    await settled(screen.findByRole("heading", { level: 2, name: "Home" }));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "go to mcp" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("heading", { level: 2, name: "MCP servers" })).toBeInTheDocument();
  });
});

describe("home", () => {
  it("summarises_signed_in_tools_and_mcp_servers_of_the_active_profile", async () => {
    renderApp(standardFake());
    expect(await settled(screen.findByText("1 of 2 signed in"))).toBeInTheDocument();
    expect(await settled(screen.findByText("1 server"))).toBeInTheDocument();
  });

  it("opens_tools_from_the_overview", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: "Open Tools" })));
    expect(screen.getByRole("heading", { level: 2, name: "Tools" })).toBeInTheDocument();
  });

  it("labels_projects_agents_tasks_and_knowledge_as_not_available_yet", async () => {
    renderApp(standardFake());
    const section = await settled(screen.findByRole("region", { name: "Not available yet" }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
  });

  it("shows_the_not_available_placeholder_for_projects", async () => {
    renderApp(standardFake());
    await settled(screen.findByRole("heading", { level: 2, name: "Home" }));
    fireEvent.click(nav("Projects"));
    expect(screen.getByText("Projects are not available yet")).toBeInTheDocument();
  });

  it("shows_an_error_with_retry_when_the_tool_list_fails", async () => {
    const fake = standardFake().fail("toolsList", "io", "Database locked");
    renderApp(fake);
    const alert = await settled(screen.findByRole("alert"));
    expect(alert).toHaveTextContent("Database locked");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await settled(screen.findByText("1 of 2 signed in"))).toBeInTheDocument();
  });
});
