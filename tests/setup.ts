import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest globals are disabled, so RTL's automatic cleanup must be wired explicitly.
afterEach(() => {
  cleanup();
});
