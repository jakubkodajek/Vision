/*
 * UI domain types. Hand-written until F-004 generates IPC types from Rust;
 * the shapes follow docs/PLAN.md (profiles, projects, runs, run events).
 */

/** Accent palettes defined in styles/tokens.css. */
export type AccentName = "iris" | "teal" | "amber" | "rose" | "green";

export const ACCENT_NAMES: readonly AccentName[] = ["iris", "teal", "amber", "rose", "green"];

export interface Profile {
  id: string;
  name: string;
  /** Short label of the signed-in identity, e.g. a GitHub login. Never a secret. */
  account: string;
  accent: AccentName;
}

export type TreeNodeKind = "project" | "folder" | "task";

export interface TreeNode {
  id: string;
  label: string;
  kind: TreeNodeKind;
  children?: TreeNode[];
  /** Set when selecting the node opens a run. */
  runId?: string;
}

export type MessageRole = "user" | "agent" | "system";
export type MessageStatus = "streaming" | "complete" | "error";

export interface MessageEvent {
  kind: "message";
  id: string;
  role: MessageRole;
  author: string;
  text: string;
  status: MessageStatus;
  time: string;
}

export type ToolCallStatus = "pending" | "running" | "success" | "error";

export interface ToolCallEvent {
  kind: "tool_call";
  id: string;
  tool: string;
  summary: string;
  input: string;
  output?: string;
  status: ToolCallStatus;
  durationMs?: number;
}

export type ApprovalStatus = "pending" | "allowed" | "denied" | "expired";
export type ApprovalDecision = "allow" | "deny";

export interface ApprovalEvent {
  kind: "approval";
  id: string;
  tool: string;
  title: string;
  detail: string;
  status: ApprovalStatus;
}

export type RunEvent = MessageEvent | ToolCallEvent | ApprovalEvent;

export type RunStatus = "running" | "waiting" | "done" | "failed";

export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines: string[];
}

export interface Run {
  id: string;
  title: string;
  projectId: string;
  agent: string;
  model: string;
  branch: string;
  status: RunStatus;
  updated: string;
  events: RunEvent[];
  changes: DiffFile[];
}

export interface Workspace {
  projects: TreeNode[];
  runs: Run[];
}

/** Async data with every state the UI has to design for. */
export type LoadState<T> =
  { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; message: string };

export type Section = "home" | "projects" | "agents" | "tasks" | "knowledge" | "settings";

export type ThemePreference = "system" | "light" | "dark";
