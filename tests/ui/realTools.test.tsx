import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { card, findCard, flush, nav, renderApp, settled } from "./appHarness";
import type { ToolStatus } from "../../src/ipc/bindings";
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

/** Renders with fake timers installed and opens Tools. */
async function openToolsWithFakeTimers(fake: FakeClient): Promise<void> {
  vi.useFakeTimers();
  renderApp(fake);
  await flush();
  fireEvent.click(nav("Tools"));
  await flush();
}

describe("tools view", () => {
  it("checks_every_tool_on_the_first_visit_with_a_spinner_per_card", async () => {
    const fake = standardFake().hold("toolCheck");
    await openTools(fake);
    expect(within(card("Claude Code")).getByRole("status")).toHaveTextContent("Checking…");
    expect(within(card("GitHub CLI")).getByRole("status")).toHaveTextContent("Checking…");
    expect(fake.calls("toolCheck")).toEqual([
      { profile_id: "p_work", tool_id: "claude" },
      { profile_id: "p_work", tool_id: "gh" },
    ]);
  });

  it("does_not_check_again_on_a_second_visit", async () => {
    const fake = standardFake();
    await openTools(fake);
    fireEvent.click(nav("Home"));
    fireEvent.click(nav("Tools"));
    await settled(findCard("GitHub CLI"));
    expect(fake.calls("toolCheck")).toHaveLength(2);
  });

  it("shows_the_signed_in_account", async () => {
    await openTools(standardFake());
    expect(within(card("Claude Code")).getByText("Signed in as dev@work.example")).toBeInTheDocument();
  });

  it("shows_status_as_text_next_to_an_icon", async () => {
    await openTools(standardFake());
    const badge = within(card("GitHub CLI")).getByText("Signed out").closest(".badge");
    expect(badge?.querySelector("svg")).not.toBeNull();
  });

  it("shows_version_and_isolation_note", async () => {
    await openTools(standardFake());
    const claude = card("Claude Code");
    expect(within(claude).getByText("1.0.0")).toBeInTheDocument();
    expect(within(claude).getByText("Sign-in isolated per profile (verified)")).toBeInTheDocument();
  });

  it("shows_a_warning_from_the_status", async () => {
    const fake = standardFake();
    fake.tools.set("p_work", [
      toolView(toolSpec("claude", "Claude Code"), {
        status: "signed_in",
        account: "dev@work.example",
        warning: "Signed in with an API key, not a subscription",
      }),
    ]);
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    expect(
      await settled(screen.findByText("Signed in with an API key, not a subscription")),
    ).toBeInTheDocument();
  });

  it("shows_an_error_with_retry_when_the_list_fails", async () => {
    const fake = standardFake().fail("toolsList", "io", "Database locked", true);
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    const main = screen.getByRole("main");
    expect(await settled(within(main).findAllByText("Database locked"))).not.toHaveLength(0);
    expect(within(main).getAllByRole("button", { name: "Try again" })).not.toHaveLength(0);
  });

  it("shows_the_check_error_on_the_card", async () => {
    const fake = standardFake();
    await openTools(fake);
    fake.fail("toolCheck", "timeout", "The status command did not answer within 20 s");
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Check again" }));
    const alert = await settled(within(card("GitHub CLI")).findByRole("alert"));
    expect(alert).toHaveTextContent("Could not check the status");
    expect(alert).toHaveTextContent("The status command did not answer within 20 s");
  });

  it("dismisses_a_card_error", async () => {
    const fake = standardFake();
    await openTools(fake);
    fake.fail("toolCheck", "timeout", "Too slow");
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Check again" }));
    fireEvent.click(await settled(within(card("GitHub CLI")).findByRole("button", { name: "Dismiss" })));
    expect(within(card("GitHub CLI")).queryByRole("alert")).toBeNull();
  });

  it("opens_the_terminal_for_the_profile", async () => {
    const fake = standardFake();
    await openTools(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal for this profile" }));
    await flushReal();
    expect(fake.calls("profileOpenTerminal")).toEqual([{ profile_id: "p_work" }]);
  });

  it("explains_terminal_unavailable_when_opening_the_profile_terminal", async () => {
    const fake = standardFake().fail("profileOpenTerminal", "terminal_unavailable", "No terminal found");
    await openTools(fake);
    fireEvent.click(screen.getByRole("button", { name: "Open terminal for this profile" }));
    const alert = await settled(screen.findByRole("alert"));
    expect(alert).toHaveTextContent("No terminal found");
    expect(alert).toHaveTextContent("Vision opens sign-ins in the Terminal app");
  });
});

async function flushReal(): Promise<void> {
  await settled(Promise.resolve());
}

describe("install", () => {
  it("opens_the_official_install_page_for_a_missing_tool", async () => {
    const fake = standardFake();
    fake.tools.set("p_work", [toolView(toolSpec("gh", "GitHub CLI"), { status: "not_installed" })]);
    fake.checkQueue.set("p_work/gh", [{ status: "not_installed" }]);
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Install" }));
    await flushReal();
    expect(fake.calls("toolOpenInstallPage")).toEqual([{ tool_id: "gh" }]);
  });

  it("shows_an_error_when_the_install_page_cannot_open", async () => {
    const fake = standardFake().fail("toolOpenInstallPage", "io", "No browser available");
    fake.tools.set("p_work", [toolView(toolSpec("gh", "GitHub CLI"), { status: "not_installed" })]);
    fake.checkQueue.set("p_work/gh", [{ status: "not_installed" }]);
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Install" }));
    expect(await settled(within(card("GitHub CLI")).findByRole("alert"))).toHaveTextContent(
      "No browser available",
    );
  });
});

describe("sign-in", () => {
  it("sends_one_sign_in_for_a_double_click", async () => {
    const fake = standardFake().hold("toolSignIn");
    await openTools(fake);
    const button = within(card("GitHub CLI")).getByRole("button", { name: "Sign in" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fake.calls("toolSignIn")).toHaveLength(1);
  });

  it("explains_terminal_unavailable_on_sign_in", async () => {
    const fake = standardFake().fail("toolSignIn", "terminal_unavailable", "No terminal app found");
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    const alert = await settled(within(card("GitHub CLI")).findByRole("alert"));
    expect(alert).toHaveTextContent("Could not start the sign-in");
    expect(alert).toHaveTextContent("Check that Terminal is installed");
  });

  it("explains_not_installed_on_sign_in", async () => {
    const fake = standardFake().fail("toolSignIn", "not_installed", "GitHub CLI is not installed");
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    const alert = await settled(within(card("GitHub CLI")).findByRole("alert"));
    expect(alert).toHaveTextContent("Install it from its official page, then select Check again.");
  });

  it("waits_for_the_terminal_after_sign_in", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    expect(within(card("GitHub CLI")).getByRole("status")).toHaveTextContent(
      "Waiting for sign-in in the terminal…",
    );
  });

  it("polls_every_3_seconds_until_signed_in_and_shows_the_account", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fake.checkQueue.set("p_work/gh", [
      { status: "signed_out" },
      { status: "signed_in", account: "octo-work" },
    ]);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    await flush(3000);
    await flush(3000);
    expect(within(card("GitHub CLI")).getByText("Signed in as octo-work")).toBeInTheDocument();
    expect(within(card("GitHub CLI")).queryByText(/Waiting for sign-in/)).toBeNull();
  });

  it("does_not_check_before_the_first_3_seconds", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    const before = fake.calls("toolCheck").length;
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush(2999);
    expect(fake.calls("toolCheck")).toHaveLength(before);
  });

  it("stops_polling_when_cancelled", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    const before = fake.calls("toolCheck").length;
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Cancel" }));
    await flush(30_000);
    expect(fake.calls("toolCheck")).toHaveLength(before);
    expect(within(card("GitHub CLI")).queryByText(/Waiting for sign-in/)).toBeNull();
  });

  it("gives_up_after_10_minutes_with_a_message", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    await flush(10 * 60_000 + 3000);
    expect(
      within(card("GitHub CLI")).getByText(/No sign-in was detected within 10 minutes/),
    ).toBeInTheDocument();
    expect(within(card("GitHub CLI")).queryByText(/Waiting for sign-in/)).toBeNull();
  });

  it("stops_polling_after_the_timeout", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    await flush(10 * 60_000 + 3000);
    const after = fake.calls("toolCheck").length;
    await flush(60_000);
    expect(fake.calls("toolCheck")).toHaveLength(after);
  });

  it("polls_after_sign_out_until_signed_out", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fake.checkQueue.set("p_work/claude", [{ status: "signed_out" }]);
    fireEvent.click(within(card("Claude Code")).getByRole("button", { name: "Sign out" }));
    await flush();
    expect(within(card("Claude Code")).getByRole("status")).toHaveTextContent(
      "Waiting for sign-out in the terminal…",
    );
    await flush(3000);
    expect(within(card("Claude Code")).getByText("Signed out")).toBeInTheDocument();
    expect(within(card("Claude Code")).getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("gives_up_waiting_for_sign_out_after_2_minutes", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fake.checkQueue.set(
      "p_work/claude",
      Array<ToolStatus>(60).fill({ status: "signed_in", account: "dev@work.example" }),
    );
    fireEvent.click(within(card("Claude Code")).getByRole("button", { name: "Sign out" }));
    await flush();
    await flush(2 * 60_000 + 3000);
    expect(
      within(card("Claude Code")).getByText(/No sign-out was detected within 2 minutes/),
    ).toBeInTheDocument();
  });

  it("stops_polling_and_shows_the_error_when_a_check_fails", async () => {
    const fake = standardFake();
    await openToolsWithFakeTimers(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    fake.fail("toolCheck", "io", "Could not run gh");
    await flush(3000);
    expect(within(card("GitHub CLI")).getByRole("alert")).toHaveTextContent("Could not run gh");
    expect(within(card("GitHub CLI")).queryByText(/Waiting for sign-in/)).toBeNull();
  });

  it("stops_polling_on_unmount", async () => {
    const fake = standardFake();
    vi.useFakeTimers();
    const { unmount } = renderApp(fake);
    await flush();
    fireEvent.click(nav("Tools"));
    await flush();
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await flush();
    const before = fake.calls("toolCheck").length;
    unmount();
    await flush(30_000);
    expect(fake.calls("toolCheck")).toHaveLength(before);
  });
});

describe("profile isolation", () => {
  it("shows_only_the_tools_of_the_new_profile_after_switching", async () => {
    await openTools(standardFake());
    fireEvent.click(screen.getByRole("button", { name: /Switch profile/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Personal/ }));
    expect(await settled(findCard("Codex"))).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Claude Code" })).toBeNull();
    expect(screen.getByText("Sign-ins for the Personal profile")).toBeInTheDocument();
  });

  it("ignores_a_late_tool_list_from_the_previous_profile", async () => {
    const fake = standardFake().hold("toolsList");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Personal/ }));
    await settled(screen.findByText("Personal · Personal profile"));
    fake.release("toolsList", (args) => (args as { profile_id: string }).profile_id === "p_home");
    await settled(screen.findByText("0 of 1 signed in"));
    fake.release("toolsList", (args) => (args as { profile_id: string }).profile_id === "p_work");
    await flushReal();
    expect(screen.getByText("0 of 1 signed in")).toBeInTheDocument();
    expect(screen.queryByText("1 of 2 signed in")).toBeNull();
  });

  it("ignores_a_late_status_check_from_the_previous_profile", async () => {
    const fake = standardFake().hold("toolCheck");
    await openTools(fake);
    fireEvent.click(screen.getByRole("button", { name: /Switch profile/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Personal/ }));
    await settled(findCard("Codex"));
    fake.release("toolCheck", (args) => (args as { tool_id: string }).tool_id === "claude");
    await flushReal();
    expect(screen.queryByRole("article", { name: "Claude Code" })).toBeNull();
  });
});
