import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApprovalCard } from "../../src/components/ApprovalCard";
import { CommandPalette } from "../../src/components/CommandPalette";
import { Composer } from "../../src/components/Composer";
import { MessageItem } from "../../src/components/MessageItem";
import { Panel } from "../../src/components/Panel";
import { EmptyState, ErrorState } from "../../src/components/primitives";
import { ToolCallCard } from "../../src/components/ToolCallCard";
import { Tree } from "../../src/components/Tree";
import type { Command } from "../../src/lib/commands";
import type { ApprovalEvent, MessageEvent, ToolCallEvent, TreeNode } from "../../src/types";
import { seriousViolations } from "./helpers";

const message = (patch: Partial<MessageEvent> = {}): MessageEvent => ({
  kind: "message",
  id: "m",
  role: "agent",
  author: "Senior Developer",
  text: "Hello",
  status: "complete",
  time: "10:00",
  ...patch,
});

describe("MessageItem", () => {
  it("renders model output as inert text, never as HTML", () => {
    const { container } = render(
      <MessageItem message={message({ text: '<img src=x onerror="alert(1)"> [x](javascript:alert(1))' })} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument();
  });

  it("renders fenced code as a code block", () => {
    const { container } = render(<MessageItem message={message({ text: "Run:\n```\nnpm test\n```" })} />);
    expect(container.querySelector("pre code")).toHaveTextContent("npm test");
  });

  it("shows a placeholder while streaming with no text yet", () => {
    render(<MessageItem message={message({ text: "", status: "streaming" })} />);
    expect(screen.getByText("Agent is writing")).toBeInTheDocument();
    expect(screen.getByRole("article")).toHaveAttribute("aria-busy", "true");
  });

  it("shows the error state", () => {
    render(<MessageItem message={message({ status: "error" })} />);
    expect(screen.getByText("The agent stopped with an error.")).toBeInTheDocument();
  });
});

const call = (patch: Partial<ToolCallEvent> = {}): ToolCallEvent => ({
  kind: "tool_call",
  id: "t",
  tool: "Bash",
  summary: "npm test",
  input: "npm test",
  output: "ok",
  status: "success",
  durationMs: 2140,
  ...patch,
});

describe("ToolCallCard", () => {
  it("is collapsed by default and expands on click", () => {
    render(<ToolCallCard call={call()} />);
    const header = screen.getByRole("button", { name: /Bash/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("ok")).not.toBeVisible();
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("ok")).toBeVisible();
  });

  it.each([
    ["running", "Running"],
    ["error", "Failed"],
    ["pending", "Queued"],
    ["success", "Succeeded"],
  ] as const)("announces the %s status", (status, label) => {
    render(<ToolCallCard call={call({ status })} />);
    expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
  });

  it("shows a waiting message while there is no output", () => {
    render(<ToolCallCard call={call({ status: "running", output: undefined })} defaultExpanded />);
    expect(screen.getByText("Waiting for output…")).toBeInTheDocument();
  });
});

const approval = (patch: Partial<ApprovalEvent> = {}): ApprovalEvent => ({
  kind: "approval",
  id: "a",
  tool: "Bash",
  title: "Run a command",
  detail: "npm install",
  status: "pending",
  ...patch,
});

describe("ApprovalCard", () => {
  it("sends allow and shows a loading state until the core answers", async () => {
    let resolve: () => void = () => undefined;
    const onDecide = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(<ApprovalCard approval={approval()} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledWith("allow");
    expect(screen.getByRole("button", { name: "Allow once" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
    // A second click while submitting is ignored.
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Allow once" })).not.toHaveAttribute("aria-busy");
  });

  it("shows an error and re-enables the actions when sending fails", async () => {
    render(<ApprovalCard approval={approval()} onDecide={() => Promise.reject(new Error("Core offline"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Core offline");
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });

  it.each([
    ["allowed", /Allowed once/],
    ["denied", /Denied/],
    ["expired", /expired/],
  ] as const)("shows the %s outcome without actions", (status, text) => {
    render(<ApprovalCard approval={approval({ status })} onDecide={() => Promise.resolve()} />);
    expect(screen.getByRole("status")).toHaveTextContent(text);
    expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  });

  it("disables both actions when disabled", () => {
    render(<ApprovalCard approval={approval()} onDecide={() => Promise.resolve()} disabled />);
    expect(screen.getByRole("button", { name: "Allow once" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });
});

describe("Composer", () => {
  const options = [{ id: "a", label: "A" }];
  const setup = (props: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<Composer onSubmit={onSubmit} agents={options} models={options} projects={options} {...props} />);
    return { onSubmit, input: screen.getByRole("textbox", { name: "Task description" }) };
  };

  it("sends on Enter and clears the input", async () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: "  Fix the bug  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith({ text: "Fix the bug", agent: "a", model: "a", projectId: "a" });
    await screen.findByDisplayValue("");
  });

  it("does not send on Shift+Enter or while composing with an IME", () => {
    const { onSubmit, input } = setup();
    fireEvent.change(input, { target: { value: "line" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the send button disabled for blank input", () => {
    const { input } = setup();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows the reason when disabled", () => {
    const { input } = setup({ disabled: true, disabledReason: "Loading projects…" });
    expect(input).toBeDisabled();
    expect(input).toHaveAccessibleDescription("Loading projects…");
  });

  it("keeps the text and shows an error when sending fails", async () => {
    const onSubmit = vi.fn(() => Promise.reject(new Error("Profile signed out")));
    render(<Composer onSubmit={onSubmit} agents={options} models={options} projects={options} />);
    const input = screen.getByRole("textbox", { name: "Task description" });
    fireEvent.change(input, { target: { value: "Task" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Profile signed out");
    expect(input).toHaveValue("Task");
  });

  it("labels every picker", () => {
    setup();
    expect(screen.getByRole("combobox", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toBeInTheDocument();
  });
});

const nodes: TreeNode[] = [
  {
    id: "p",
    label: "vision",
    kind: "project",
    children: [{ id: "t", label: "Task one", kind: "task", runId: "r" }],
  },
  { id: "q", label: "dotfiles", kind: "project", children: [] },
];

describe("Tree", () => {
  it("supports arrow keys, expand, collapse and select", () => {
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const { rerender } = render(
      <Tree label="Projects" nodes={nodes} expanded={new Set()} selectedId={null} onToggle={onToggle} onSelect={onSelect} />,
    );
    const tree = screen.getByRole("tree", { name: "Projects" });
    const items = screen.getAllByRole("treeitem");
    expect(items[0]).toHaveAttribute("tabindex", "0");
    expect(items[1]).toHaveAttribute("tabindex", "-1");
    items[0]?.focus();
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    expect(onToggle).toHaveBeenCalledWith("p");
    rerender(
      <Tree label="Projects" nodes={nodes} expanded={new Set(["p"])} selectedId={null} onToggle={onToggle} onSelect={onSelect} />,
    );
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByRole("treeitem", { name: /Task one/ })).toHaveFocus();
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "t" }));
    fireEvent.keyDown(tree, { key: "ArrowLeft" });
    expect(screen.getByRole("treeitem", { name: /vision/ })).toHaveFocus();
    fireEvent.keyDown(tree, { key: "End" });
    expect(screen.getByRole("treeitem", { name: /dotfiles/ })).toHaveFocus();
  });

  it("shows an empty group for a branch without children", () => {
    render(<Tree label="Projects" nodes={nodes} expanded={new Set(["q"])} selectedId={null} onToggle={vi.fn()} onSelect={vi.fn()} />);
    expect(screen.getByText("No tasks yet")).toBeInTheDocument();
  });
});

describe("Panel", () => {
  const renderPanel = (onResize = vi.fn(), onClose = vi.fn(), onTabChange = vi.fn()) => {
    render(
      <Panel
        title="Run details"
        tabs={[
          { id: "a", label: "Changes" },
          { id: "b", label: "Files" },
        ]}
        activeTab="a"
        onTabChange={onTabChange}
        onClose={onClose}
        width={440}
        minWidth={320}
        maxWidth={760}
        onResize={onResize}
      >
        content
      </Panel>,
    );
    return { onResize, onClose, onTabChange };
  };

  it("resizes with the keyboard within limits", () => {
    const { onResize } = renderPanel();
    const separator = screen.getByRole("separator", { name: "Resize side panel" });
    expect(separator).toHaveAttribute("aria-valuenow", "440");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(456);
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith(424);
    fireEvent.keyDown(separator, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith(760);
    fireEvent.keyDown(separator, { key: "End" });
    expect(onResize).toHaveBeenLastCalledWith(320);
  });

  it("closes and switches tabs with arrow keys", () => {
    const { onClose, onTabChange } = renderPanel();
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(onTabChange).toHaveBeenCalledWith("b");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CommandPalette", () => {
  const make = () => {
    const runs = { a: vi.fn(), b: vi.fn(), c: vi.fn() };
    const commands: Command[] = [
      { id: "a", label: "New task", group: "Actions", run: runs.a },
      { id: "b", label: "Disabled thing", group: "Actions", disabled: true, run: runs.b },
      { id: "c", label: "Go to Settings", group: "Navigation", run: runs.c },
    ];
    return { runs, commands };
  };

  it("renders nothing when closed", () => {
    render(<CommandPalette open={false} commands={[]} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("focuses the input, skips disabled commands and runs the active one on Enter", () => {
    const { runs, commands } = make();
    const onClose = vi.fn();
    render(<CommandPalette open commands={commands} onClose={onClose} />);
    const input = screen.getByRole("combobox", { name: "Search commands" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(runs.c).toHaveBeenCalled();
    expect(runs.b).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("filters and shows an empty state", () => {
    const { commands } = make();
    render(<CommandPalette open commands={commands} onClose={vi.fn()} />);
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "settings" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the opener", () => {
    const { commands } = make();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { rerender } = render(<CommandPalette open commands={commands} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    rerender(<CommandPalette open={false} commands={commands} onClose={onClose} />);
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe("states", () => {
  it("ErrorState announces and retries", () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Could not load" message="Disk full" onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("EmptyState renders title and description", () => {
    render(<EmptyState title="No runs yet" description="Start one." />);
    expect(screen.getByText("No runs yet")).toBeInTheDocument();
  });
});

describe("component accessibility (axe-core)", () => {
  it("has no serious violations across components and states", async () => {
    const { commands } = make2();
    const { container } = render(
      <div>
        <MessageItem message={message()} />
        <MessageItem message={message({ status: "streaming", text: "" })} />
        <ToolCallCard call={call()} defaultExpanded />
        <ApprovalCard approval={approval()} onDecide={() => Promise.resolve()} />
        <ApprovalCard approval={approval({ id: "b", status: "denied" })} onDecide={() => Promise.resolve()} />
        <Composer onSubmit={() => Promise.resolve()} agents={[]} models={[]} projects={[]} disabled disabledReason="Off" />
        <Tree label="Projects" nodes={nodes} expanded={new Set(["p", "q"])} selectedId="t" onToggle={vi.fn()} onSelect={vi.fn()} />
        <ErrorState title="Error" onRetry={vi.fn()} />
        <CommandPalette open commands={commands} onClose={vi.fn()} />
      </div>,
    );
    expect(await seriousViolations(container)).toEqual([]);
  });
});

function make2() {
  const commands: Command[] = [{ id: "a", label: "New task", group: "Actions", run: vi.fn() }];
  return { commands };
}
