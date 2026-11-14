// @vitest-environment node
// Installer packaging and the build workflow (spec real-app-foundation §4, AC13).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const tauriDir = join(root, "src-tauri");
const workflowsDir = join(root, ".github/workflows");

interface Point {
  x: number;
  y: number;
}

interface BundleConfig {
  active?: boolean;
  targets?: string | string[];
  icon: string[];
  publisher?: string;
  copyright?: string;
  category?: string;
  shortDescription?: string;
  longDescription?: string;
  createUpdaterArtifacts?: unknown;
  macOS: {
    signingIdentity?: string;
    minimumSystemVersion?: string;
    dmg: {
      background: string;
      windowSize: { width: number; height: number };
      appPosition: Point;
      applicationFolderPosition: Point;
    };
  };
  windows: { nsis: { installMode?: string } };
  linux: { deb?: object; appimage?: object };
}

interface TauriConfig {
  productName: string;
  bundle: BundleConfig;
  plugins?: Record<string, unknown>;
}

function config(): TauriConfig {
  return JSON.parse(
    readFileSync(join(tauriDir, "tauri.conf.json"), "utf8"),
  ) as TauriConfig;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (
    !bytes.subarray(0, 8).equals(signature) ||
    bytes.toString("latin1", 12, 16) !== "IHDR"
  ) {
    throw new Error("not a PNG");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function pngFileSize(path: string): { width: number; height: number } {
  return pngSize(readFileSync(path));
}

/** Entries of an .icns file: type code and payload. */
function icnsEntries(bytes: Buffer): { type: string; data: Buffer }[] {
  expect(bytes.toString("latin1", 0, 4)).toBe("icns");
  expect(bytes.readUInt32BE(4)).toBe(bytes.length);
  const entries = [];
  let offset = 8;
  while (offset < bytes.length) {
    const type = bytes.toString("latin1", offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    expect(length).toBeGreaterThan(8);
    entries.push({ type, data: bytes.subarray(offset + 8, offset + length) });
    offset += length;
  }
  return entries;
}

/** Entries of an .ico file: nominal size and payload. */
function icoEntries(bytes: Buffer): { size: number; data: Buffer }[] {
  expect(bytes.readUInt16LE(0)).toBe(0);
  expect(bytes.readUInt16LE(2)).toBe(1);
  const count = bytes.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const size = bytes.readUInt8(at) || 256;
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    entries.push({ size, data: bytes.subarray(offset, offset + length) });
  }
  return entries;
}

function workflowFiles(): string[] {
  return readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
}

function workflow(name: string): string {
  return readFileSync(join(workflowsDir, name), "utf8");
}

/** Top-level jobs of a workflow as {job id: its text}, split on two-space indentation. */
function jobs(text: string): Record<string, string> {
  const body = text.split(/^jobs:\s*$/m)[1] ?? "";
  const out: Record<string, string> = {};
  let current: string | undefined;
  for (const line of body.split("\n")) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m?.[1]) {
      current = m[1];
      out[current] = "";
    } else if (current) {
      out[current] = `${out[current] ?? ""}${line}\n`;
    }
  }
  return out;
}

/** Every non-local `uses:` reference that is not pinned to a SHA with a version comment. */
function unpinnedActions(): string[] {
  return workflowFiles().flatMap((file) =>
    workflow(file)
      .split("\n")
      .map((line) => /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line))
      .filter(
        (m): m is RegExpExecArray =>
          m !== null && !(m[1] ?? "").startsWith("./"),
      )
      .filter(
        (m) =>
          !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(m[1] ?? "") ||
          !/^\s+#\s*v\d/.test(m[2] ?? ""),
      )
      .map((m) => `${file}: ${m[0].trim()}`),
  );
}

function usesCount(): number {
  return workflowFiles().reduce(
    (n, f) => n + (workflow(f).match(/^\s*(?:-\s+)?uses:/gm)?.length ?? 0),
    0,
  );
}

/** Every `toolchain:` input across the workflows. */
function toolchainInputs(): string[] {
  return workflowFiles().flatMap((file) =>
    [...workflow(file).matchAll(/^\s*toolchain:\s*"?([^"\s#]+)"?/gm)].map(
      (m) => m[1] ?? "",
    ),
  );
}

function pinnedChannel(): string | undefined {
  const toml = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
  return /^channel\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
}

/** The workflow text before `jobs:` (triggers, top-level permissions). */
function header(text: string): string {
  return text.split(/^jobs:\s*$/m)[0] ?? "";
}

describe("bundle settings (spec §4)", () => {
  const bundle = () => config().bundle;

  it("bundles every platform's installers", () => {
    expect(bundle().active).toBe(true);
    expect(bundle().targets).toBe("all");
  });

  it("ad-hoc signs the macOS app", () => {
    expect(bundle().macOS.signingIdentity).toBe("-");
  });

  it("sets a minimum macOS version of at least 11 (Apple Silicon)", () => {
    const v = bundle().macOS.minimumSystemVersion ?? "";
    expect(v).toMatch(/^\d+\.\d+$/);
    expect(Number(v.split(".")[0])).toBeGreaterThanOrEqual(11);
  });

  it("has category, copyright, publisher, short and long description", () => {
    const b = bundle();
    expect(b.category).toBe("DeveloperTool");
    expect(b.copyright).toMatch(/^Copyright © \d{4} /);
    expect(b.publisher?.trim()).toBeTruthy();
    expect(b.shortDescription?.trim()).toBeTruthy();
    expect(b.shortDescription?.length ?? 0).toBeLessThanOrEqual(80);
    expect(
      (b.longDescription?.length ?? 0) > (b.shortDescription?.length ?? 0),
    ).toBe(true);
  });

  it("does not use Anthropic or Claude in the product name, publisher or copyright", () => {
    const c = config();
    const names = [c.productName, c.bundle.publisher, c.bundle.copyright].join(
      " | ",
    );
    expect(names).not.toMatch(/anthropic|claude/i);
  });

  it("installs per user on Windows (no admin prompt)", () => {
    expect(bundle().windows.nsis.installMode).toBe("currentUser");
  });

  it("configures the Linux deb and AppImage bundles", () => {
    expect(bundle().linux.deb).toBeDefined();
    expect(bundle().linux.appimage).toBeDefined();
  });

  it("has no auto-updater", () => {
    expect(bundle().createUpdaterArtifacts ?? false).toBe(false);
    expect(config().plugins?.updater).toBeUndefined();
  });

  describe("DMG", () => {
    const dmg = () => bundle().macOS.dmg;

    it("background exists at 1x with the window's size", () => {
      const path = join(tauriDir, dmg().background);
      expect(existsSync(path)).toBe(true);
      expect(pngFileSize(path)).toEqual(dmg().windowSize);
    });

    it("has a @2x background at twice the size", () => {
      const path = join(
        tauriDir,
        dmg().background.replace(/\.png$/, "@2x.png"),
      );
      expect(existsSync(path)).toBe(true);
      const { width, height } = dmg().windowSize;
      expect(pngFileSize(path)).toEqual({
        width: width * 2,
        height: height * 2,
      });
    });

    it("places the app left of Applications on one row, inside the window", () => {
      const {
        appPosition: app,
        applicationFolderPosition: apps,
        windowSize,
      } = dmg();
      expect(app.y).toBe(apps.y);
      expect(app.x).toBeLessThan(apps.x);
      expect(app.x).toBeGreaterThan(64);
      expect(apps.x).toBeLessThan(windowSize.width - 64);
      expect(app.y).toBeGreaterThan(64);
      expect(app.y).toBeLessThan(windowSize.height - 64);
    });

    it("matches the layout the background artwork was drawn for", () => {
      const script = readFileSync(join(root, "scripts/make_icons.py"), "utf8");
      const tuple = (name: string) => {
        const m = new RegExp(`^${name} = \\((\\d+), (\\d+)\\)`, "m").exec(
          script,
        );
        return m ? { a: Number(m[1]), b: Number(m[2]) } : undefined;
      };
      const {
        appPosition: app,
        applicationFolderPosition: apps,
        windowSize,
      } = dmg();
      expect(tuple("DMG_SIZE")).toEqual({
        a: windowSize.width,
        b: windowSize.height,
      });
      expect(tuple("DMG_APP")).toEqual({ a: app.x, b: app.y });
      expect(tuple("DMG_APPLICATIONS")).toEqual({ a: apps.x, b: apps.y });
    });
  });
});

describe("app icons", () => {
  it.each(config().bundle.icon)("configured icon %s exists", (icon) => {
    expect(existsSync(join(tauriDir, icon))).toBe(true);
  });

  it.each([
    ["icons/32x32.png", 32],
    ["icons/64x64.png", 64],
    ["icons/128x128.png", 128],
    ["icons/128x128@2x.png", 256],
    ["icons/icon.png", 512],
  ])("%s is %ipx square", (file, size) => {
    expect(pngFileSize(join(tauriDir, file))).toEqual({
      width: size,
      height: size,
    });
  });

  it("icon.icns holds PNGs from 16 to 1024 px with the right sizes", () => {
    const expected: Record<string, number> = {
      icp4: 16,
      icp5: 32,
      icp6: 64,
      ic07: 128,
      ic08: 256,
      ic09: 512,
      ic10: 1024,
      ic11: 32,
      ic12: 64,
      ic13: 256,
      ic14: 512,
    };
    const entries = icnsEntries(
      readFileSync(join(tauriDir, "icons/icon.icns")),
    );
    const actual = Object.fromEntries(
      entries.map((e) => [e.type, pngSize(e.data).width]),
    );
    const square = entries.every(
      (e) => pngSize(e.data).width === pngSize(e.data).height,
    );
    expect(actual).toEqual(expected);
    expect(square).toBe(true);
  });

  it("icon.ico holds 16 to 256 px PNGs", () => {
    const entries = icoEntries(readFileSync(join(tauriDir, "icons/icon.ico")));
    const declared = entries.map((e) => e.size);
    const actual = entries.map((e) => pngSize(e.data));
    expect(declared).toEqual(expect.arrayContaining([16, 32, 48, 256]));
    expect(actual).toEqual(
      declared.map((size) => ({ width: size, height: size })),
    );
  });

  it("are generated from the SVG source", () => {
    expect(existsSync(join(tauriDir, "icons/source/vision-mark.svg"))).toBe(
      true,
    );
    expect(readFileSync(join(root, "scripts/make_icons.py"), "utf8")).toContain(
      "source/vision-mark.svg",
    );
  });
});

describe("GitHub workflows", () => {
  it("use at least one action", () => {
    expect(usesCount()).toBeGreaterThan(0);
  });

  it("pin every third-party action to a full commit SHA with a version comment", () => {
    expect(unpinnedActions()).toEqual([]);
  });

  it("rust-toolchain.toml pins an exact version with rustfmt and clippy", () => {
    const toml = readFileSync(join(root, "rust-toolchain.toml"), "utf8");
    expect(pinnedChannel()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(toml).toMatch(/components\s*=\s*\[[^\]]*"rustfmt"[^\]]*"clippy"/);
  });

  it("install exactly the Rust toolchain pinned in rust-toolchain.toml", () => {
    const inputs = toolchainInputs();
    expect(inputs.length).toBeGreaterThan(0);
    expect(new Set(inputs)).toEqual(new Set([pinnedChannel()]));
  });

  it.each(["build.yml", "ci.yml"])(
    "%s uses only the automatic token, no repository secrets",
    (file) => {
      expect(workflow(file)).not.toMatch(/secrets\./);
    },
  );

  describe("build.yml", () => {
    const text = () => workflow("build.yml");

    it("runs on pull requests, pushes to main and v* tags", () => {
      const h = header(text());
      expect(h).toMatch(/^\s{2}pull_request:/m);
      expect(h).toMatch(/branches:\s*\[main\]/);
      expect(h).toMatch(/tags:\s*\["v\*"\]/);
    });

    it("defaults to read-only contents permission", () => {
      expect(header(text())).toMatch(
        /^permissions:\s*\n\s+contents:\s*read\s*$/m,
      );
    });

    it("grants contents: write to the release job", () => {
      expect(jobs(text()).release).toMatch(
        /permissions:\s*\n\s+contents:\s*write/,
      );
    });

    it("grants contents: write to no other job", () => {
      const writers = Object.entries(jobs(text()))
        .filter(([, body]) => /contents:\s*write/.test(body))
        .map(([id]) => id);
      expect(writers).toEqual(["release"]);
    });

    it("builds the four targets", () => {
      const build = jobs(text()).build ?? "";
      expect(build).toMatch(/target:\s*aarch64-apple-darwin/);
      expect(build).toMatch(/target:\s*x86_64-apple-darwin/);
      expect(build).toMatch(/os:\s*windows-latest/);
      expect(build).toMatch(/os:\s*ubuntu-22\.04/);
      expect(build).toContain("npx tauri build");
      expect(build).toMatch(/--target "\$TARGET"/);
    });

    it("runs make check", () => {
      expect(jobs(text()).check ?? "").toMatch(/run:\s*make check/);
    });

    it("uploads the installers as artifacts named by target", () => {
      const build = jobs(text()).build ?? "";
      expect(build).toContain("actions/upload-artifact@");
      expect(build).toContain("name: vision-${{ matrix.name }}");
      expect(build).toContain("if-no-files-found: error");
    });

    it.each([
      "dmg/*.dmg",
      "nsis/*-setup.exe",
      "msi/*.msi",
      "deb/*.deb",
      "appimage/*.AppImage",
    ])("collects %s", (pattern) => {
      expect(jobs(text()).build).toContain(pattern);
    });

    it("writes the DMG layout on CI and verifies the mounted DMG", () => {
      const build = jobs(text()).build ?? "";
      expect(build).toMatch(/TAURI_BUNDLER_DMG_IGNORE_CI:\s*"true"/);
      expect(build).toContain("hdiutil attach");
      expect(build).toContain("hdiutil detach");
      expect(build).toContain('test -d "$mnt/Vision.app"');
      expect(build).toContain('test -L "$mnt/Applications"');
      expect(build).toContain("codesign -dv");
      expect(build).toContain("Signature=adhoc");
      expect(build).toContain("scripts/check_dmg_layout.py");
      expect(existsSync(join(root, "scripts/check_dmg_layout.py"))).toBe(true);
    });

    it("drafts a release with checksums only for v* tags", () => {
      const release = jobs(text()).release ?? "";
      expect(release).toMatch(
        /if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/,
      );
      expect(release).toMatch(/needs:\s*\[check, build\]/);
      expect(release).toContain("SHA256SUMS");
      expect(release).toContain("sha256sum");
      expect(release).toContain("--draft");
    });
  });
});

describe("make build", () => {
  it("runs tauri build", () => {
    const makefile = readFileSync(join(root, "Makefile"), "utf8");
    expect(makefile).toMatch(/^build:.*##/m);
    expect(makefile).toMatch(/^\tnpx tauri build/m);
  });
});
