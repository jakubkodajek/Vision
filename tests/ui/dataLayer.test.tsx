import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { card, findCard, renderApp, settled } from "./appHarness";
import { dataReducer, initialDataState } from "../../src/data/store";
import { profile, server, standardFake, toolSpec, toolView, type FakeClient } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
});

function withTool(approved: boolean): FakeClient {
  const fake = standardFake();
  fake.tools.get("p_work")?.push(toolView(toolSpec("mytool", "My Tool", { builtin: false, approved }), null));
  return fake;
}

async function openTools(fake: FakeClient): Promise<void> {
  renderApp(fake);
  fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
  await settled(findCard("GitHub CLI"));
}

async function settle(): Promise<void> {
  await settled(Promise.resolve());
}

async function switchTo(name: RegExp): Promise<void> {
  fireEvent.click(await settled(screen.findByRole("button", { name: /Switch profile/ })));
  fireEvent.click(screen.getByRole("menuitemradio", { name }));
  await settle();
}

describe("automatic checks (A3)", () => {
  it("does_not_check_an_unapproved_custom_tool_on_the_first_visit", async () => {
    const fake = withTool(false);
    await openTools(fake);
    expect(fake.calls("toolCheck")).not.toContainEqual({
      profile_id: "p_work",
      tool_id: "mytool",
    });
  });

  it("checks_an_approved_custom_tool_on_the_first_visit", async () => {
    const fake = withTool(true);
    await openTools(fake);
    expect(fake.calls("toolCheck")).toContainEqual({
      profile_id: "p_work",
      tool_id: "mytool",
    });
  });

  it("skips_an_unapproved_custom_tool_in_check_all", async () => {
    const fake = withTool(false);
    await openTools(fake);
    fireEvent.click(screen.getByRole("button", { name: "Check all" }));
    await settle();
    expect(fake.calls("toolCheck")).not.toContainEqual({
      profile_id: "p_work",
      tool_id: "mytool",
    });
  });

  it("shows_a_declined_confirmation_as_a_neutral_notice", async () => {
    const fake = withTool(false);
    await openTools(fake);
    fake.fail("toolCheck", "not_approved", "The user declined");
    fireEvent.click(within(card("My Tool")).getByRole("button", { name: "Check" }));
    expect(
      await settled(within(card("My Tool")).findByText(/You declined to run this command/)),
    ).toHaveTextContent("You declined to run this command. Nothing was run.");
    expect(within(card("My Tool")).queryByRole("alert")).toBeNull();
  });
});

describe("late answers", () => {
  it("does_not_bring_back_a_custom_tool_whose_check_answers_after_its_delete", async () => {
    const fake = withTool(true);
    await openTools(fake);
    await settled(findCard("My Tool"));
    fake.computeAtCall("toolCheck").hold("toolCheck");
    fireEvent.click(within(card("My Tool")).getByRole("button", { name: "Check again" }));
    fireEvent.click(within(card("My Tool")).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete My Tool?" })).getByRole("button", {
        name: "Delete tool",
      }),
    );
    await settle();
    await act(async () => {
      fake.release("toolCheck");
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByRole("article", { name: "My Tool" })).toBeNull();
  });

  it("ignores_delete_on_a_server_row_while_its_test_runs", async () => {
    const fake = standardFake().hold("mcpTest");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    await settled(findCard("filesystem"));
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    const del = within(card("filesystem")).getByRole("button", {
      name: "Delete filesystem",
    });
    fireEvent.click(del);
    expect(del).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("removes_a_server_row_when_its_test_says_it_no_longer_exists", async () => {
    const fake = standardFake().fail("mcpTest", "not_found", "MCP server not found");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "MCP servers" })));
    await settled(findCard("filesystem"));
    fireEvent.click(within(card("filesystem")).getByRole("button", { name: "Test" }));
    await settle();
    expect(screen.queryByRole("article", { name: "filesystem" })).toBeNull();
  });
});

describe("update-only results", () => {
  const ready = <T,>(data: T) => ({ kind: "ready" as const, data });

  it("does_not_add_a_server_that_is_no_longer_listed", () => {
    const state = { ...initialDataState, mcp: { p_work: ready([]) } };
    const next = dataReducer(state, {
      type: "mcp/updated",
      profileId: "p_work",
      server: server("m_x", "x"),
    });
    expect(next.mcp.p_work).toEqual(ready([]));
  });

  it("does_not_add_a_tool_that_is_no_longer_listed", () => {
    const state = dataReducer(initialDataState, {
      type: "tools/loaded",
      profileId: "p_work",
      views: [],
      waiting: {},
      checking: [],
    });
    const next = dataReducer(state, {
      type: "tool/view",
      profileId: "p_work",
      view: toolView(toolSpec("mytool", "My Tool"), { status: "signed_out" }),
    });
    expect(next.tools.p_work?.list).toEqual(ready([]));
  });

  it("rebuilds_a_running_wait_when_the_list_is_loaded_again", () => {
    const next = dataReducer(initialDataState, {
      type: "tools/loaded",
      profileId: "p_work",
      views: [toolView(toolSpec("gh", "GitHub CLI"), null)],
      waiting: { gh: "sign_in" },
      checking: [],
    });
    const list = next.tools.p_work?.list;
    expect(list?.kind === "ready" ? list.data[0]?.waiting : null).toBe("sign_in");
  });
});

describe("profile switching (CR-11)", () => {
  it("applies_the_latest_profile_chosen_while_a_switch_is_in_flight", async () => {
    const fake = standardFake().hold("profileSetActive");
    fake.profiles.push(profile("p_side", "Side", { kind: "other", accent: "amber" }));
    fake.tools.set("p_side", []);
    fake.servers.set("p_side", []);
    renderApp(fake);
    await switchTo(/Personal/);
    await switchTo(/Side/);
    await act(async () => {
      fake.release("profileSetActive");
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      fake.release("profileSetActive");
      await Promise.resolve();
    });
    await settle();
    expect(fake.calls("profileSetActive")).toEqual([{ id: "p_home" }, { id: "p_side" }]);
    expect(screen.getByRole("button", { name: /Switch profile/ })).toHaveTextContent("Side");
  });
});

describe("tool reloads (CR-6)", () => {
  it("keeps_showing_a_sign_in_wait_after_the_list_was_reloaded", async () => {
    const fake = standardFake();
    await openTools(fake);
    fireEvent.click(within(card("GitHub CLI")).getByRole("button", { name: "Sign in" }));
    await settle();
    await switchTo(/Personal/);
    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    await settled(findCard("Codex"));
    fireEvent.click(screen.getByRole("button", { name: "Add custom tool" }));
    const dialog = screen.getByRole("dialog", { name: "Add custom tool" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "My Tool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Program"), {
      target: { value: "mytool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Config variable"), {
      target: { value: "MYTOOL_HOME" },
    });
    fireEvent.change(within(dialog).getByLabelText("Sign-in arguments"), {
      target: { value: "login" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    await settled(findCard("My Tool"));
    await switchTo(/Work/);
    await settled(findCard("GitHub CLI"));
    expect(within(card("GitHub CLI")).getByRole("button", { name: "Stop waiting" })).toBeInTheDocument();
  });
});
