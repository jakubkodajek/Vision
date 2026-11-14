import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { card, findCard, flush, nav, renderApp, settled } from "./appHarness";
import { standardFake, toolSpec, toolView, type FakeClient } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function openTools(fake: FakeClient): Promise<void> {
  renderApp(fake);
  fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
  await settled(findCard("GitHub CLI"));
}

async function openToolsWithFakeTimers(fake: FakeClient): Promise<void> {
  vi.useFakeTimers();
  renderApp(fake);
  await flush();
  fireEvent.click(nav("Tools"));
  await flush();
}

function live(): HTMLElement {
  const region = document.querySelector<HTMLElement>('[data-live="tools"]');
  if (!region) throw new Error("no tools live region");
  return region;
}

function customTool(extra: Parameters<typeof toolSpec>[2]): FakeClient {
  const fake = standardFake();
  fake.tools.get("p_work")?.push(toolView(toolSpec("mytool", "My Tool", { builtin: false, ...extra }), null));
  return fake;
}

describe("approval and invalid tools (A3, B)", () => {
  it("shows_an_unapproved_tool_as_needing_approval_with_a_check_button", async () => {
    await openTools(customTool({ approved: false }));
    const myTool = card("My Tool");
    expect(within(myTool).getByText("Needs your approval to run")).toBeInTheDocument();
    expect(within(myTool).getByRole("button", { name: "Check" })).toHaveClass("btn-primary");
    expect(within(myTool).queryByRole("button", { name: "Sign in" })).toBeNull();
  });

  it("runs_an_unapproved_tool_only_on_an_explicit_check", async () => {
    const fake = customTool({ approved: false });
    await openTools(fake);
    fireEvent.click(within(card("My Tool")).getByRole("button", { name: "Check" }));
    await settled(Promise.resolve());
    expect(fake.calls("toolCheck")).toContainEqual({
      profile_id: "p_work",
      tool_id: "mytool",
    });
  });

  it("shows_the_reason_and_only_edit_and_delete_for_an_invalid_tool", async () => {
    const fake = customTool({
      invalid: "The config variable BROWSER is not allowed.",
      approved: false,
    });
    await openTools(fake);
    const myTool = card("My Tool");
    expect(within(myTool).getByText(/The config variable BROWSER is not allowed\./)).toBeInTheDocument();
    expect(
      within(myTool)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Edit", "Delete"]);
    expect(fake.calls("toolCheck")).not.toContainEqual({
      profile_id: "p_work",
      tool_id: "mytool",
    });
  });

  it("saves_an_edited_tool_with_replace", async () => {
    const fake = customTool({
      approved: true,
      config_env: [{ var: "MYTOOL_HOME", kind: "dir", rel: "" }],
    });
    await openTools(fake);
    fireEvent.click(within(card("My Tool")).getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit My Tool" });
    expect(within(dialog).getByLabelText("Identifier")).toHaveAttribute("readonly");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "My Tool 2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await settled(findCard("My Tool 2"));
    expect(fake.calls("customToolSave")).toEqual([expect.objectContaining({ replace: true })]);
  });
});

describe("tool card content", () => {
  it("labels_a_sign_in_with_a_warning_as_see_note", async () => {
    const fake = standardFake();
    fake.checkQueue.set("p_work/claude", [
      {
        status: "signed_in",
        account: "dev@work.example",
        warning: "The login may be shared.",
      },
    ]);
    await openTools(fake);
    expect(within(card("Claude Code")).getByText("Signed in, see note")).toBeInTheDocument();
  });

  it("names_the_install_action_and_says_it_opens_the_browser", async () => {
    const fake = standardFake();
    fake.tools.set("p_work", [toolView(toolSpec("gh", "GitHub CLI"), { status: "not_installed" })]);
    fake.checkQueue.set("p_work/gh", [{ status: "not_installed" }]);
    await openTools(fake);
    expect(
      within(card("GitHub CLI")).getByRole("button", {
        name: "Get installer, opens the official install page in your browser",
      }),
    ).toBeInTheDocument();
  });

  it("shows_account_only_when_signed_in_and_version_only_when_installed", async () => {
    const fake = standardFake();
    fake.checkQueue.set("p_work/gh", [{ status: "not_installed" }]);
    await openTools(fake);
    expect(within(card("GitHub CLI")).queryByText("Account")).toBeNull();
    expect(within(card("GitHub CLI")).queryByText("Version")).toBeNull();
    expect(within(card("Claude Code")).getByText("Account")).toBeInTheDocument();
  });

  it("does_not_mark_per_card_progress_as_a_live_region", async () => {
    const fake = standardFake().hold("toolCheck");
    await openTools(fake);
    expect(within(card("GitHub CLI")).queryByRole("status")).toBeNull();
  });
});

describe("announcements (UX-4)", () => {
  it("announces_the_check_all_summary_once_every_check_finished", async () => {
    const fake = standardFake();
    await openTools(fake);
    expect(live()).toHaveTextContent("Check finished: 1 of 2 signed in.");
  });

  it("announces_a_single_check", async () => {
    const fake = standardFake();
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Check again" }));
    await settled(Promise.resolve());
    expect(live()).toHaveTextContent("GitHub CLI: signed out.");
  });

  it("keeps_the_stop_button_out_of_the_live_region", async () => {
    const fake = standardFake();
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await settled(Promise.resolve());
    const stop = within(card("GitHub CLI")).getByRole("button", {
      name: "Stop waiting",
    });
    expect(stop.closest('[aria-live], [role="status"]')).toBeNull();
  });
});

describe("focus (UX-2)", () => {
  it("moves_focus_to_stop_waiting_after_sign_in_starts", async () => {
    const fake = standardFake();
    await openTools(fake);
    const signIn = within(card("GitHub CLI")).getByRole("button", {
      name: "Sign in",
    });
    signIn.focus();
    fireEvent.click(signIn);
    await settled(Promise.resolve());
    expect(within(card("GitHub CLI")).getByRole("button", { name: "Stop waiting" })).toHaveFocus();
  });

  it("moves_focus_to_the_card_primary_action_after_stop_waiting", async () => {
    const fake = standardFake();
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await settled(Promise.resolve());
    const stop = within(card("GitHub CLI")).getByRole("button", {
      name: "Stop waiting",
    });
    stop.focus();
    fireEvent.click(stop);
    expect(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" })).toHaveFocus();
  });

  it("keeps_check_all_focusable_while_checks_run", async () => {
    const fake = standardFake();
    await openTools(fake);
    fake.hold("toolCheck");
    const checkAll = screen.getByRole("button", { name: "Check all" });
    checkAll.focus();
    fireEvent.click(checkAll);
    await settled(Promise.resolve());
    expect(checkAll).toHaveAttribute("aria-disabled", "true");
    expect(checkAll).not.toBeDisabled();
    expect(checkAll).toHaveFocus();
  });
});

describe("waiting row (UX-12)", () => {
  it("offers_open_terminal_again_and_check_now_while_waiting", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    fireEvent.click(
      within(card("GitHub CLI")).getByRole("button", {
        name: "Open terminal again",
      }),
    );
    await flush();
    expect(fake.calls("toolSignIn")).toHaveLength(2);
    fake.checkQueue.set("p_work/gh", [{ status: "signed_in", account: "octo" }]);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Check now" }));
    await flush();
    expect(within(card("GitHub CLI")).getByText("Signed in as octo")).toBeInTheDocument();
    expect(
      within(card("GitHub CLI")).queryByRole("button", {
        name: "Stop waiting",
      }),
    ).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});
