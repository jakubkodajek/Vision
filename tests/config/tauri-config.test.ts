// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const tauriDir = join(root, "src-tauri");

interface TauriConfig {
  productName?: string;
  app: {
    withGlobalTauri?: boolean;
    windows: { label?: string; title?: string }[];
    security: { freezePrototype?: boolean; csp: Record<string, string> };
  };
}

interface Capability {
  windows?: string[];
  permissions?: unknown[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function config(): TauriConfig {
  return readJson<TauriConfig>(join(tauriDir, "tauri.conf.json"));
}

describe("scaffold files (FC2)", () => {
  const required = [
    "Cargo.toml",
    "crates/vision-core/Cargo.toml",
    "src-tauri/tauri.conf.json",
    "src-tauri/capabilities/main.json",
    "src-tauri/icons/32x32.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/128x128@2x.png",
    "src-tauri/icons/icon.icns",
    "src-tauri/icons/icon.ico",
    "src-tauri/icons/icon.png",
    "package.json",
    "vite.config.ts",
    "index.html",
    "src/main.tsx",
    "src/App.tsx",
  ];
  it.each(required)("%s exists", (p) => {
    expect(existsSync(join(root, p))).toBe(true);
  });

  it("workspace lists vision-core and src-tauri", () => {
    const toml = readFileSync(join(root, "Cargo.toml"), "utf8");
    expect(toml).toContain("crates/vision-core");
    expect(toml).toContain("src-tauri");
  });

  it("vision-core has no tauri dependency", () => {
    const toml = readFileSync(join(root, "crates/vision-core/Cargo.toml"), "utf8");
    expect(toml).not.toMatch(/^\s*tauri[\w-]*\s*[=.]/m);
  });

  it("index.html has no inline script or style", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });
});

describe("tauri.conf.json security baseline (PLAN 2.3)", () => {
  it("uses the product name Vision for the window", () => {
    const c = config();
    expect(c.productName).toBe("Vision");
    expect(c.app.windows[0]?.label).toBe("main");
    expect(c.app.windows[0]?.title).toBe("Vision");
  });

  it("does not expose the global Tauri object", () => {
    expect(config().app.withGlobalTauri).toBe(false);
  });

  it("freezes the prototype", () => {
    expect(config().app.security.freezePrototype).toBe(true);
  });

  it("does not disable asset CSP modification", () => {
    expect(JSON.stringify(config())).not.toContain("dangerousDisableAssetCspModification");
  });

  describe("production CSP", () => {
    const csp = () => config().app.security.csp;

    it("is an object of directives", () => {
      expect(typeof csp()).toBe("object");
      expect(csp()).not.toBeNull();
    });

    it.each([
      ["default-src", "'self'"],
      ["script-src", "'self'"],
      ["object-src", "'none'"],
      ["base-uri", "'none'"],
      ["frame-ancestors", "'none'"],
      ["form-action", "'none'"],
    ])("%s is %s", (directive, value) => {
      expect(csp()[directive]).toBe(value);
    });

    it("script-src allows no unsafe-inline or unsafe-eval", () => {
      const script = csp()["script-src"] ?? "";
      expect(script).not.toContain("unsafe-inline");
      expect(script).not.toContain("unsafe-eval");
    });
  });
});

describe("capabilities", () => {
  const dir = join(tauriDir, "capabilities");
  const files = () =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];

  it("has at least one capability file", () => {
    expect(files().length).toBeGreaterThan(0);
  });

  it("every capability grants only allow-app-info to the main window, no remote", () => {
    for (const f of files()) {
      const cap = readJson<Capability>(join(dir, f));
      expect(cap.windows).toEqual(["main"]);
      expect(cap.permissions).toEqual(["allow-app-info"]);
      expect(cap).not.toHaveProperty("remote");
    }
  });
});
