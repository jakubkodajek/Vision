import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findCard, renderApp, settled } from "./appHarness";
import { FakeClient, profile, standardFake } from "./fakeClient";
import { seriousViolations } from "./helpers";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

async function openSettings(fake: FakeClient): Promise<void> {
  renderApp(fake);
  fireEvent.click(await settled(screen.findByRole("button", { name: "Settings" })));
  await settled(screen.findByRole("button", { name: "Delete Work" }));
}

function onlyWork(): FakeClient {
  const fake = new FakeClient();
  fake.profiles = [profile("p_work", "Work", { kind: "work", accent: "teal" })];
  fake.active = "p_work";
  fake.tools.set("p_work", []);
  fake.servers.set("p_work", []);
  return fake;
}

describe("profile settings", () => {
  it("lists_every_profile_and_marks_the_active_one", async () => {
    await openSettings(standardFake());
    expect(screen.getByText("Work profile · Active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Personal" })).toBeInTheDocument();
  });

  it("renames_a_profile_sending_only_the_changed_field", async () => {
    const fake = standardFake();
    await openSettings(fake);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Work" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Acme" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await settled(screen.findByRole("button", { name: "Edit Acme" }))).toBeInTheDocument();
    expect(fake.calls("profileUpdate")).toEqual([{ id: "p_work", name: "Acme" }]);
  });

  it("changes_the_kind", async () => {
    const fake = standardFake();
    await openSettings(fake);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Work" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Other" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settled(screen.findByText("Profile · Active"));
    expect(fake.calls("profileUpdate")).toEqual([{ id: "p_work", kind: "other" }]);
  });

  it("shows_a_name_conflict_under_the_name_field", async () => {
    const fake = standardFake().fail("profileUpdate", "conflict", "A profile with this name already exists");
    await openSettings(fake);
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Work" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Personal" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settled(within(dialog).findByText("A profile with this name already exists"));
    expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription(
      /A profile with this name already exists/,
    );
  });
});

describe("delete profile", () => {
  it("keeps_delete_disabled_until_the_name_is_typed_exactly", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Personal?" });
    fireEvent.change(within(dialog).getByLabelText("Type Personal to confirm"), {
      target: { value: "personal" },
    });
    expect(within(dialog).getByRole("button", { name: "Delete profile" })).toBeDisabled();
  });

  it("enables_delete_when_the_name_matches", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Personal?" });
    fireEvent.change(within(dialog).getByLabelText("Type Personal to confirm"), {
      target: { value: "Personal" },
    });
    expect(within(dialog).getByRole("button", { name: "Delete profile" })).toBeEnabled();
  });

  it("warns_that_sign_ins_and_mcp_servers_are_removed", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Personal?" });
    expect(dialog).toHaveAccessibleDescription(/tool sign-ins .* MCP servers with their secret values/);
    expect(within(dialog).getByText(/Sign out of each tool in Tools first/)).toBeInTheDocument();
  });

  it("lists_the_tools_still_signed_in", async () => {
    const fake = standardFake();
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    await settled(findCard("GitHub CLI"));
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    expect(screen.getByText("Still signed in: Claude Code.")).toBeInTheDocument();
  });

  it("removes_the_profile_after_confirmation", async () => {
    const fake = standardFake();
    await openSettings(fake);
    fireEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Personal?" });
    fireEvent.change(within(dialog).getByLabelText("Type Personal to confirm"), {
      target: { value: "Personal" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    await settled(screen.findByRole("button", { name: "Delete Work" }));
    expect(screen.queryByRole("button", { name: "Delete Personal" })).toBeNull();
    expect(fake.calls("profileDelete")).toEqual([{ id: "p_home", confirm_name: "Personal" }]);
  });

  it("keeps_the_profile_and_shows_the_error_when_delete_fails", async () => {
    const fake = standardFake().fail("profileDelete", "io", "The folder is in use");
    await openSettings(fake);
    fireEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Personal?" });
    fireEvent.change(within(dialog).getByLabelText("Type Personal to confirm"), {
      target: { value: "Personal" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    expect(await settled(within(dialog).findByRole("alert"))).toHaveTextContent("The folder is in use");
    expect(screen.getByRole("button", { name: "Delete Personal" })).toBeInTheDocument();
  });

  it("shows_the_welcome_screen_after_deleting_the_last_profile", async () => {
    await openSettings(onlyWork());
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete Work?" });
    fireEvent.change(within(dialog).getByLabelText("Type Work to confirm"), { target: { value: "Work" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete profile" }));
    expect(
      await settled(screen.findByRole("heading", { name: "Create your first profile" })),
    ).toBeInTheDocument();
  });
});

describe("dialogs", () => {
  it("is_labelled_by_its_heading", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Work" });
    expect(within(dialog).getByRole("heading", { name: "Edit Work" }).id).toBe(
      dialog.getAttribute("aria-labelledby"),
    );
  });

  it("is_modal", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    expect(screen.getByRole("dialog", { name: "Edit Work" })).toHaveAttribute("aria-modal", "true");
  });

  it("closes_on_escape_and_returns_focus_to_the_opener", async () => {
    await openSettings(standardFake());
    const opener = screen.getByRole("button", { name: "Edit Work" });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Edit Work" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("moves_focus_into_the_dialog_when_it_opens", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    expect(within(screen.getByRole("dialog", { name: "Edit Work" })).getByLabelText("Name")).toHaveFocus();
  });

  it("wraps_tab_from_the_last_control_to_the_first", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Work" });
    within(dialog).getByRole("button", { name: "Save changes" }).focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("wraps_shift_tab_from_the_first_control_to_the_last", async () => {
    await openSettings(standardFake());
    fireEvent.click(screen.getByRole("button", { name: "Edit Work" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Work" });
    within(dialog).getByRole("button", { name: "Close" }).focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(within(dialog).getByRole("button", { name: "Save changes" })).toHaveFocus();
  });

  it("focuses_cancel_first_in_a_confirmation", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    fireEvent.click(await settled(screen.findByRole("button", { name: "Delete filesystem" })));
    const dialog = screen.getByRole("alertdialog", { name: "Delete filesystem?" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });
});

describe.each(["light", "dark"])("accessibility in the %s theme", (theme) => {
  beforeEach(() => {
    document.documentElement.dataset.theme = theme;
  });

  it("has_no_serious_violations_on_welcome", async () => {
    const { container } = renderApp(new FakeClient());
    await settled(screen.findByRole("heading", { name: "Create your first profile" }));
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("has_no_serious_violations_on_tools", async () => {
    const { container } = renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    await settled(findCard("GitHub CLI"));
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("has_no_serious_violations_on_mcp_with_tools_expanded", async () => {
    const { container } = renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    fireEvent.click(await settled(screen.findByRole("button", { name: "Show tools (2)" })));
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("has_no_serious_violations_in_the_server_dialog", async () => {
    renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    fireEvent.click(await settled(screen.findByRole("button", { name: "Edit filesystem" })));
    expect(await seriousViolations(screen.getByRole("dialog", { name: "Edit filesystem" }))).toEqual([]);
  });

  it("has_no_serious_violations_on_settings_with_the_delete_dialog", async () => {
    const { container } = renderApp(standardFake());
    fireEvent.click(await settled(screen.findByRole("button", { name: "Settings" })));
    fireEvent.click(await settled(screen.findByRole("button", { name: "Delete Work" })));
    expect(await seriousViolations(container)).toEqual([]);
  });
});
