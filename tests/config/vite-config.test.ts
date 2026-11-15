// @vitest-environment node
import { describe, expect, it } from "vitest";
import config from "../../vite.config";

describe("vite build config", () => {
  it("never inlines assets as data: URLs, which the production CSP (font-src 'self') blocks", () => {
    expect(config.build?.assetsInlineLimit).toBe(0);
  });
});
