/*
 * Preview data for the UI shell. Profiles, projects and runs become real with
 * F-003 (storage), F-010 (profiles) and F-020 (runs); until then the shell shows
 * this fixed data and labels it "Preview data" so nobody mistakes it for a run.
 */
import type { Profile, Run, Workspace } from "../types";

export const DEMO_PROFILES: readonly Profile[] = [
  { id: "personal", name: "Personal", account: "github: octo-personal", accent: "iris" },
  { id: "work", name: "Work", account: "github: octo-work", accent: "teal" },
];

export const DEMO_AGENTS = ["Senior Developer", "Code Reviewer", "QA Engineer", "Engineering Manager"];
export const DEMO_MODELS = ["Default model", "Fast model", "Deep reasoning"];

const uiShellRun: Run = {
  id: "run-ui-shell",
  title: "Build the UI shell and design system",
  projectId: "vision",
  agent: "Senior Developer",
  model: "Default model",
  branch: "vision/f-005/senior-developer",
  status: "waiting",
  updated: "2 min ago",
  events: [
    {
      kind: "message",
      id: "m1",
      role: "user",
      author: "You",
      status: "complete",
      time: "10:02",
      text: "Build the app shell from PLAN section 2.4: sidebar, conversation column and a resizable side panel. Keep the production CSP strict.",
    },
    {
      kind: "message",
      id: "m2",
      role: "agent",
      author: "Senior Developer",
      status: "complete",
      time: "10:02",
      text: "I'll start by reading the plan and the current placeholder screen, then add design tokens before any component so every colour comes from one file.",
    },
    {
      kind: "tool_call",
      id: "t1",
      tool: "Read",
      summary: "docs/PLAN.md",
      input: '{ "file_path": "docs/PLAN.md", "offset": 163, "limit": 25 }',
      output: "### 2.4 UI design direction\n\nThe owner wants a look and feel similar to ...",
      status: "success",
      durationMs: 41,
    },
    {
      kind: "tool_call",
      id: "t2",
      tool: "Edit",
      summary: "src/styles/tokens.css",
      input: "+ --color-bg: #f8f7f4;\n+ --color-text: #1d1b18;\n+ --accent: #4f46e5;",
      output: "File updated (182 lines).",
      status: "success",
      durationMs: 18,
    },
    {
      kind: "tool_call",
      id: "t3",
      tool: "Bash",
      summary: "npx vitest run tests/ui",
      input: "npx vitest run tests/ui",
      output:
        "FAIL tests/ui/contrast.test.ts\n  dark/iris: --accent-fg on --accent-hover = 4.37\n  expected 4.37 to be greater than or equal to 4.5",
      status: "error",
      durationMs: 2140,
    },
    {
      kind: "message",
      id: "m3",
      role: "agent",
      author: "Senior Developer",
      status: "complete",
      time: "10:05",
      text: "The dark hover colour was too light for white text. I darkened it and the contrast check passes now.\n\nNext I want to add an accessibility checker for the component tests:\n\n```\nnpm install --save-exact -D axe-core@4.14.0\n```",
    },
    {
      kind: "approval",
      id: "a1",
      tool: "Bash",
      title: "Run a command that changes package.json",
      detail: "npm install --save-exact -D axe-core@4.14.0",
      status: "pending",
    },
  ],
  changes: [
    {
      path: "src/styles/tokens.css",
      additions: 6,
      deletions: 1,
      lines: [
        "@@ -1,4 +1,9 @@",
        " :root {",
        "-  font-family: system-ui, sans-serif;",
        "+  color-scheme: light;",
        "+  --color-bg: #f8f7f4;",
        "+  --color-bg-sidebar: #f0eee9;",
        "+  --color-text: #1d1b18;",
        "+  --color-text-muted: #5f5a52;",
        "+  --accent: #4f46e5;",
        " }",
      ],
    },
    {
      path: "src/App.tsx",
      additions: 3,
      deletions: 2,
      lines: [
        "@@ -30,6 +30,7 @@",
        "   return (",
        "-    <main>",
        "-      <h1>Vision</h1>",
        "+    <ErrorBoundary>",
        "+      <AppShell coreStatus={status} />",
        "+    </ErrorBoundary>",
        "   );",
      ],
    },
  ],
};

const personal: Workspace = {
  projects: [
    {
      id: "vision",
      label: "vision",
      kind: "project",
      children: [
        {
          id: "vision-m0",
          label: "M0 Skeleton",
          kind: "folder",
          children: [
            { id: "task-ui-shell", label: "UI shell and design system", kind: "task", runId: "run-ui-shell" },
            { id: "task-ipc", label: "Typed IPC channel", kind: "task", runId: "run-ipc" },
          ],
        },
        { id: "vision-m1", label: "M1 Profiles", kind: "folder", children: [] },
      ],
    },
    {
      id: "dotfiles",
      label: "dotfiles",
      kind: "project",
      children: [{ id: "task-zsh", label: "Tidy shell config", kind: "task", runId: "run-zsh" }],
    },
  ],
  runs: [
    uiShellRun,
    {
      id: "run-ipc",
      title: "Generate TypeScript types for IPC",
      projectId: "vision",
      agent: "Senior Developer",
      model: "Default model",
      branch: "vision/f-004/senior-developer",
      status: "done",
      updated: "Yesterday",
      events: [
        {
          kind: "message",
          id: "m1",
          role: "user",
          author: "You",
          status: "complete",
          time: "16:40",
          text: "Generate the command types from Rust and fail lint when they are stale.",
        },
        {
          kind: "tool_call",
          id: "t1",
          tool: "Bash",
          summary: "cargo test --workspace",
          input: "cargo test --workspace",
          output: "test result: ok. 3 passed; 0 failed",
          status: "success",
          durationMs: 8400,
        },
        {
          kind: "message",
          id: "m2",
          role: "agent",
          author: "Senior Developer",
          status: "complete",
          time: "16:52",
          text: "Done. Types are generated into src/ipc/generated.ts and make lint fails when they differ from the Rust definitions.",
        },
      ],
      changes: [],
    },
    {
      id: "run-zsh",
      title: "Tidy shell config",
      projectId: "dotfiles",
      agent: "Code Reviewer",
      model: "Fast model",
      branch: "vision/zsh/code-reviewer",
      status: "failed",
      updated: "3 days ago",
      events: [
        {
          kind: "message",
          id: "m1",
          role: "user",
          author: "You",
          status: "complete",
          time: "09:12",
          text: "Review my shell config and suggest what to remove.",
        },
        {
          kind: "message",
          id: "m2",
          role: "agent",
          author: "Code Reviewer",
          status: "error",
          time: "09:13",
          text: "The CLI session ended before the review finished: the sign-in for this profile has expired.",
        },
      ],
      changes: [],
    },
  ],
};

const work: Workspace = {
  projects: [
    {
      id: "billing",
      label: "billing-service",
      kind: "project",
      children: [
        { id: "task-invoice", label: "Fix flaky invoice date test", kind: "task", runId: "run-invoice" },
      ],
    },
    { id: "dashboard", label: "web-dashboard", kind: "project", children: [] },
  ],
  runs: [
    {
      id: "run-invoice",
      title: "Fix flaky invoice date test",
      projectId: "billing",
      agent: "QA Engineer",
      model: "Default model",
      branch: "vision/invoice/qa-engineer",
      status: "running",
      updated: "Just now",
      events: [
        {
          kind: "message",
          id: "m1",
          role: "user",
          author: "You",
          status: "complete",
          time: "11:20",
          text: "test_invoice_due_date fails about once a week in CI. Find out why and fix it.",
        },
        {
          kind: "tool_call",
          id: "t1",
          tool: "Grep",
          summary: "datetime.now in src/",
          input: '{ "pattern": "datetime.now", "path": "src/" }',
          output: "src/invoice/dates.py:14: today = datetime.now()",
          status: "success",
          durationMs: 120,
        },
        {
          kind: "tool_call",
          id: "t2",
          tool: "Bash",
          summary: "pytest tests/test_invoice.py -k due_date --count 200",
          input: "pytest tests/test_invoice.py -k due_date --count 200",
          status: "running",
        },
      ],
      changes: [],
    },
  ],
};

const WORKSPACES: Record<string, Workspace> = { personal, work };

/** Loads the preview workspace of a profile, simulating core latency. */
export function loadDemoWorkspace(profileId: string, latencyMs = 350): Promise<Workspace> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const workspace = WORKSPACES[profileId];
      if (workspace) resolve(structuredClone(workspace));
      else reject(new Error(`Unknown profile: ${profileId}`));
    }, latencyMs);
  });
}
