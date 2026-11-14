import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App";

const invokeMock = vi.mocked(invoke);

/** Answers each command like a core with one profile and nothing configured. */
function coreWithOneProfile(command: string): Promise<unknown> {
  const answers: Record<string, unknown> = {
    app_info: { name: "Vision", version: "0.1.0" },
    bootstrap: {
      profiles: [
        { id: "p_work", name: "Work", kind: "work", accent: "teal", created_at: "2026-11-01T00:00:00Z" },
      ],
      active_profile_id: "p_work",
      platform: "linux",
    },
    tools_list: [],
    mcp_list: [],
  };
  return Promise.resolve(answers[command] ?? null);
}

describe("App", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders_vision_heading", async () => {
    invokeMock.mockImplementation(coreWithOneProfile);
    render(<App />);
    expect(await screen.findByRole("heading", { level: 1, name: "Vision" })).toBeInTheDocument();
  });

  it("shows_pending_state_before_the_command_resolves", () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));
    render(<App />);
    expect(screen.getByText(/Connecting to core/)).toBeInTheDocument();
  });

  it("shows_core_version_from_app_info_command", async () => {
    invokeMock.mockImplementation(coreWithOneProfile);
    render(<App />);
    expect(await screen.findByText("Core 0.1.0")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("app_info", undefined);
  });

  it("shows_error_state_when_command_fails", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not reach the Vision core");
  });
});
