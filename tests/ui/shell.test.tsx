import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDemoWorkspace } from "../../src/demo/workspace";
import { AppShell } from "../../src/shell/AppShell";
import type { Workspace } from "../../src/types";
import { seriousViolations } from "./helpers";

const instantLoad = (profileId: string): Promise<Workspace> => loadDemoWorkspace(profileId, 0);

function renderShell(loadWorkspace: (id: string) => Promise<Workspace> = instantLoad, decisionDelayMs = 0) {
  return render(
    <AppShell
      loadWorkspace={loadWorkspace}
      coreVersion="0.1.0"
      footer={<span>Core 0.1.0</span>}
      streamDelayMs={0}
      decisionDelayMs={decisionDelayMs}
    />,
  );
}

function shell(): HTMLElement {
  const el = document.querySelector<HTMLElement>(".app-shell");
  if (!el) throw new Error("shell not rendered");
  return el;
}

async function openUiShellRun() {
  await screen.findByRole("tree", { name: "Projects" });
  const recent = screen.getByRole("region", { name: "Recent runs" });
  fireEvent.click(within(recent).getByRole("button", { name: /Build the UI shell/ }));
  await screen.findByRole("heading", { level: 2, name: "Build the UI shell and design system" });
}

describe("AppShell", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows loading skeletons, then the project tree and recent runs", async () => {
    renderShell();
    expect(screen.getByLabelText("Loading projects")).toBeInTheDocument();
    expect(await screen.findByRole("tree", { name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "vision" })).toHaveAttribute("aria-expanded", "true");
  });

  it("shows an error with retry when the workspace fails to load", async () => {
    const loader = vi
      .fn<(id: string) => Promise<Workspace>>()
      .mockRejectedValueOnce(new Error("Database locked"))
      .mockImplementation(instantLoad);
    renderShell(loader);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent.includes("Database locked"))).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0] as HTMLElement);
    expect(await screen.findByRole("tree", { name: "Projects" })).toBeInTheDocument();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("has no serious accessibility violations on home and in a run", async () => {
    const { container } = renderShell();
    await screen.findByRole("tree", { name: "Projects" });
    expect(await seriousViolations(container)).toEqual([]);
    await openUiShellRun();
    expect(await seriousViolations(container)).toEqual([]);
  });

  it("opens the command palette with Ctrl+K and closes it with Escape", async () => {
    renderShell();
    await screen.findByRole("tree");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Search commands" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates with the palette", async () => {
    renderShell();
    await screen.findByRole("tree");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "go to settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("heading", { level: 2, name: "Settings" })).toBeInTheDocument();
  });

  it("collapses the sidebar with Ctrl+B and remembers it", async () => {
    renderShell();
    await screen.findByRole("tree");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(shell()).toHaveAttribute("data-sidebar", "collapsed");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(window.localStorage.getItem("vision.ui.sidebarCollapsed")).toBe("true");
  });

  it("opens a run with the side panel and toggles the panel with Ctrl+J", async () => {
    renderShell();
    await openUiShellRun();
    expect(screen.getByRole("complementary", { name: "Run details" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "j", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "Run details" })).toBeNull();
    expect(shell()).toHaveAttribute("data-panel", "closed");
  });

  it("applies the panel width as a CSS variable, not an inline style attribute in markup", async () => {
    renderShell();
    await openUiShellRun();
    fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
    expect(shell().style.getPropertyValue("--panel-width")).toBe("760px");
  });

  it("allows a pending approval and the run continues", async () => {
    renderShell();
    await openUiShellRun();
    expect(screen.getByRole("textbox", { name: "Task description" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText(/Allowed once/)).toBeInTheDocument();
    expect(await screen.findByText(/This is a preview of the Vision interface/)).toBeInTheDocument();
  });

  it("starts a new task from home and opens it", async () => {
    renderShell();
    await screen.findByRole("tree");
    const input = screen.getByRole("textbox", { name: "Task description" });
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: "Add a dark mode toggle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("heading", { level: 2, name: "Add a dark mode toggle" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "Add a dark mode toggle" })).toBeInTheDocument();
  });

  it("switching profile shows only that profile's data", async () => {
    renderShell();
    await openUiShellRun();
    fireEvent.click(screen.getByRole("button", { name: /Switch profile/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Work/ }));
    expect(await screen.findByRole("treeitem", { name: "billing-service" })).toBeInTheDocument();
    expect(screen.queryByText("Build the UI shell and design system")).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "vision" })).toBeNull();
    expect(shell()).toHaveAttribute("data-accent", "teal");
  });

  it("sets the theme from settings", async () => {
    renderShell();
    await screen.findByRole("tree");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: /System/ }));
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("ignores corrupt stored preferences", async () => {
    window.localStorage.setItem("vision.ui.panelWidth", '"wide"');
    window.localStorage.setItem("vision.ui.theme", "{not json");
    renderShell();
    await openUiShellRun();
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "440");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("stops timers on unmount without errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = renderShell();
    await openUiShellRun();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    unmount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("decides an approval once even if the run is reopened while the decision is in flight", async () => {
    renderShell(instantLoad, 100);
    await openUiShellRun();
    const agentMessages = () => document.querySelectorAll(".message-agent").length;
    const before = agentMessages();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    fireEvent.click(within(screen.getByRole("region", { name: "Recent runs" })).getByRole("button", { name: /Build the UI shell/ }));
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(await screen.findByText(/Allowed once/)).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(agentMessages() - before).toBe(1);
  });

  it("ignores layout shortcuts while the palette is open", async () => {
    renderShell();
    await screen.findByRole("tree");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(shell()).toHaveAttribute("data-sidebar", "expanded");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("does not run a palette command on an IME confirmation Enter", async () => {
    renderShell();
    await screen.findByRole("tree");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Search commands" }), { key: "Enter", isComposing: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("never splits an emoji when shortening a long task title", async () => {
    renderShell();
    await screen.findByRole("tree");
    const input = screen.getByRole("textbox", { name: "Task description" });
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: `${"a".repeat(56)}😀😀 and more text after it` } });
    fireEvent.keyDown(input, { key: "Enter" });
    const heading = await screen.findByRole("heading", { level: 2, name: /^a+/ });
    expect(heading.textContent).toBe(`${"a".repeat(56)}😀…`);
  });

  it("keeps the home draft when New task is pressed again", async () => {
    renderShell();
    await screen.findByRole("tree");
    const input = screen.getByRole("textbox", { name: "Task description" });
    await waitFor(() => {
      expect(input).toBeEnabled();
    });
    fireEvent.change(input, { target: { value: "Half-written idea" } });
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Task description" })).toHaveValue("Half-written idea");
    expect(screen.getByRole("textbox", { name: "Task description" })).toHaveFocus();
  });

  it("keeps the side panel closed by default in a narrow window", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
    renderShell();
    await openUiShellRun();
    expect(screen.queryByRole("complementary", { name: "Run details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show side panel" }));
    expect(screen.getByRole("complementary", { name: "Run details" })).toBeInTheDocument();
  });
});
