import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import App from "../../src/App";

const invokeMock = vi.mocked(invoke);

describe("App", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("renders_vision_heading", () => {
    invokeMock.mockResolvedValue({ name: "Vision", version: "0.1.0" });
    render(<App />);
    expect(screen.getByRole("heading", { level: 1, name: "Vision" })).toBeInTheDocument();
  });

  it("shows_pending_state_before_the_command_resolves", () => {
    invokeMock.mockReturnValue(new Promise(() => undefined));
    render(<App />);
    expect(screen.getByText(/Connecting to core/)).toBeInTheDocument();
  });

  it("shows_core_version_from_app_info_command", async () => {
    invokeMock.mockResolvedValue({ name: "Vision", version: "0.1.0" });
    render(<App />);
    expect(await screen.findByText("Core 0.1.0")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("app_info");
  });

  it("shows_error_state_when_command_fails", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    render(<App />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not reach the Vision core");
  });
});
