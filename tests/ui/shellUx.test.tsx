import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { VisionIpcError } from "../../src/ipc/client";
import { findCard, nav, renderApp, settled } from "./appHarness";
import { profile, standardFake, type FakeClient } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
});

async function home(fake: FakeClient): Promise<void> {
  renderApp(fake);
  await settled(screen.findByRole("heading", { level: 2, name: "Home" }));
}

function pressCtrl(key: string): void {
  fireEvent.keyDown(window, { key, ctrlKey: true });
}

function paletteOptions(): string[] {
  return within(screen.getByRole("listbox", { name: "Commands" }))
    .getAllByRole("option")
    .map((o) => o.textContent);
}

describe("global shortcuts (CR-5)", () => {
  it("ignores_the_palette_shortcut_while_a_dialog_is_open", async () => {
    const fake = standardFake();
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    await settled(findCard("GitHub CLI"));
    fireEvent.click(screen.getByRole("button", { name: "Add custom tool" }));
    pressCtrl("k");
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("ignores_the_sidebar_shortcut_while_a_dialog_is_open", async () => {
    await home(standardFake());
    fireEvent.click(screen.getByRole("button", { name: /Switch profile/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New profile…" }));
    pressCtrl("b");
    expect(screen.getByRole("navigation", { name: "Sidebar" })).not.toHaveClass("is-collapsed");
  });
});

describe("command palette (UX-16)", () => {
  it("offers_the_tool_mcp_and_profile_commands", async () => {
    await home(standardFake());
    pressCtrl("k");
    const options = paletteOptions();
    expect(options).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Check all tools"),
        expect.stringContaining("Add custom tool…"),
        expect.stringContaining("Add MCP server…"),
        expect.stringContaining("Sync to Claude Code…"),
        expect.stringContaining("Manage profiles"),
      ]),
    );
  });

  it("does_not_offer_the_side_panel_without_runs", async () => {
    await home(standardFake());
    pressCtrl("k");
    expect(paletteOptions().some((o) => o.includes("side panel"))).toBe(false);
  });

  it("says_what_can_be_searched", async () => {
    await home(standardFake());
    pressCtrl("k");
    expect(screen.getByRole("combobox")).toHaveAttribute("placeholder", "Search commands and settings…");
  });

  it("opens_the_add_server_dialog_from_the_palette", async () => {
    await home(standardFake());
    pressCtrl("k");
    fireEvent.click(screen.getByRole("option", { name: /Add MCP server/ }));
    expect(await settled(screen.findByRole("dialog", { name: "Add MCP server" }))).toBeInTheDocument();
  });
});

describe("window title (UX-36)", () => {
  it("names_the_view_and_the_profile", async () => {
    await home(standardFake());
    fireEvent.click(nav("Tools"));
    await settled(findCard("GitHub CLI"));
    expect(document.title).toBe("Tools · Work · Vision");
  });
});

describe("profile menu", () => {
  it("returns_focus_to_the_menu_button_after_a_dialog_from_the_menu_closes", async () => {
    await home(standardFake());
    const button = screen.getByRole("button", { name: /Switch profile/ });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "New profile…" }));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(button).toHaveFocus();
  });

  it("moves_to_the_item_starting_with_a_typed_letter", async () => {
    await home(standardFake());
    fireEvent.click(screen.getByRole("button", { name: /Switch profile/ }));
    fireEvent.keyDown(screen.getByRole("menu", { name: "Profiles" }), { key: "p" });
    expect(screen.getByRole("menuitemradio", { name: /Personal/ })).toHaveFocus();
  });

  it("uses_only_letters_and_digits_for_initials", async () => {
    const fake = standardFake();
    fake.profiles = [profile("p_work", "(Old) side", { accent: "teal" })];
    await home(fake);
    expect(document.querySelector(".profile-button .avatar")).toHaveTextContent(/^OS$/);
  });

  it("shows_the_full_name_as_a_tooltip", async () => {
    await home(standardFake());
    expect(screen.getByRole("button", { name: /Switch profile/ })).toHaveAttribute("title", "Work");
  });

  it("defaults_a_new_profile_to_the_first_unused_color", async () => {
    await home(standardFake());
    fireEvent.click(screen.getByRole("button", { name: /Switch profile/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New profile…" }));
    const dialog = screen.getByRole("dialog", { name: "New profile" });
    expect(within(dialog).getByRole("group", { name: "Color" })).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "Amber" })).toBeChecked();
  });
});

describe("delete profile", () => {
  async function openDelete(fake: FakeClient, name: string): Promise<HTMLElement> {
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Settings" })));
    fireEvent.click(await settled(screen.findByRole("button", { name: `Delete ${name}` })));
    return screen.getByRole("alertdialog", { name: `Delete ${name}?` });
  }

  it("says_the_name_does_not_match_on_enter", async () => {
    const dialog = await openDelete(standardFake(), "Personal");
    const field = within(dialog).getByLabelText("Type “Personal” to confirm");
    fireEvent.change(field, { target: { value: "Persona" } });
    fireEvent.submit(field.closest("form") as HTMLFormElement);
    expect(field).toHaveAccessibleDescription("The name does not match.");
  });

  it("accepts_the_name_with_surrounding_spaces", async () => {
    const dialog = await openDelete(standardFake(), "Personal");
    fireEvent.change(within(dialog).getByLabelText("Type “Personal” to confirm"), {
      target: { value: " Personal " },
    });
    expect(within(dialog).getByRole("button", { name: "Delete profile" })).toBeEnabled();
  });

  it("lists_signed_in_tools_of_a_profile_that_was_not_visited", async () => {
    const fake = standardFake();
    fake.tools.set("p_home", [
      {
        ...(fake.tools.get("p_home")?.[0] ??
          (() => {
            throw new Error("no tool");
          })()),
        status: { status: "signed_in", account: "me" },
      },
    ]);
    const dialog = await openDelete(fake, "Personal");
    expect(await settled(within(dialog).findByText("Still signed in: Codex."))).toBeInTheDocument();
  });

  it("warns_when_the_profile_was_removed_but_files_remain", async () => {
    const fake = standardFake();
    const remove = fake.profileDelete;
    fake.profileDelete = (args) =>
      remove(args).then(() => {
        throw new VisionIpcError("io", "Could not remove the profile folder.");
      });
    const dialog = await openDelete(fake, "Personal");
    fireEvent.change(within(dialog).getByLabelText("Type “Personal” to confirm"), {
      target: { value: "Personal" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    const warning = await settled(screen.findByRole("alertdialog", { name: "Personal was removed" }));
    expect(warning).toHaveTextContent("The profile was removed, but some of its files remain on disk");
  });
});

describe("startup and core status", () => {
  it("offers_the_latest_version_instead_of_retry_when_the_data_is_too_new", async () => {
    const fake = standardFake().fail(
      "bootstrap",
      "schema_too_new",
      "The database was written by a newer Vision",
    );
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: /^Get the latest version/ })));
    await settled(Promise.resolve());
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(fake.calls("appOpenReleasesPage")).toHaveLength(1);
  });

  it("puts_the_startup_error_in_a_main_landmark", async () => {
    renderApp(standardFake().fail("bootstrap", "io", "Database locked"));
    await settled(screen.findByRole("alert"));
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("shows_that_the_core_is_unreachable_when_app_info_fails_after_bootstrap", async () => {
    const fake = standardFake().fail("appInfo", "internal", "No core");
    await home(fake);
    expect(
      within(screen.getByRole("navigation", { name: "Sidebar" })).getByText(
        "Could not reach the Vision core.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps_the_core_status_readable_in_the_collapsed_sidebar", async () => {
    await home(standardFake());
    await act(async () => {
      await Promise.resolve();
    });
    pressCtrl("b");
    const line = await settled(screen.findByText("Vision 0.1.0"));
    expect(line.closest(".core-status-line")).toHaveAttribute("title", "Vision 0.1.0");
  });
});
