// @vitest-environment node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const script = join(root, "scripts/check_placeholders.sh");
// Built by concatenation so this file never matches the check itself.
const placeholder = "TODO" + "(bootstrap)";

const tmpDirs: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "vision-placeholders-"));
  tmpDirs.push(d);
  return d;
}
function run(arg?: string) {
  return spawnSync("bash", arg ? [script, arg] : [script], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scripts/check_placeholders.sh", () => {
  it("exists", () => {
    expect(existsSync(script)).toBe(true);
  });

  it("exits 0 on the repository (no bootstrap placeholders remain)", () => {
    const r = run();
    expect(r.stderr).not.toContain(placeholder);
    expect(r.status).toBe(0);
  });

  it("exits 1 when AGENTS.md contains the placeholder", () => {
    const d = tempRoot();
    writeFileSync(join(d, "AGENTS.md"), `- Stack: ${placeholder} fill me\n`);
    const r = run(d);
    expect(r.status).toBe(1);
  });

  it("exits 1 when a nested docs file contains the placeholder", () => {
    const d = tempRoot();
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs/architecture.md"), `${placeholder}\n`);
    expect(run(d).status).toBe(1);
  });

  it("exits 0 on a clean directory", () => {
    const d = tempRoot();
    writeFileSync(join(d, "AGENTS.md"), "# clean\n");
    expect(run(d).status).toBe(0);
  });

  it("ignores excluded directories such as .work and node_modules", () => {
    const d = tempRoot();
    for (const ex of [".work", "node_modules"]) {
      mkdirSync(join(d, ex));
      writeFileSync(join(d, ex, "note.md"), `${placeholder}\n`);
    }
    expect(run(d).status).toBe(0);
  });
});
