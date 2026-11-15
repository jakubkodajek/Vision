// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * WCAG 2.2 contrast check for the design tokens (SC 1.4.3, 4.5:1 for normal text).
 * Formula: https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 * jsdom cannot compute colour contrast, so the tokens are checked directly.
 */

const css = readFileSync(resolve(__dirname, "../../src/styles/tokens.css"), "utf8");
const ACCENTS = ["iris", "teal", "amber", "rose", "green"] as const;
const MIN_TEXT_CONTRAST = 4.5;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns the custom properties declared in the block that starts a line with `selector {`. */
function block(selector: string): Map<string, string> {
  const pattern = new RegExp(`^\\s*${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "m");
  const match = pattern.exec(css);
  if (!match?.[1]) throw new Error(`Block not found: ${selector}`);
  const vars = new Map<string, string>();
  for (const decl of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (decl[1] && decl[2]) vars.set(decl[1], decl[2].trim());
  }
  return vars;
}

function topLevelBlock(selector: string): Map<string, string> {
  const pattern = new RegExp(`^${escapeRegExp(selector)}\\s*\\{([^}]*)\\}`, "m");
  const match = pattern.exec(css);
  if (!match?.[1]) throw new Error(`Top-level block not found: ${selector}`);
  const vars = new Map<string, string>();
  for (const decl of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (decl[1] && decl[2]) vars.set(decl[1], decl[2].trim());
  }
  return vars;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`Not a 6-digit hex colour: ${hex}`);
  const value = m[1];
  const channel = (i: number): number => {
    const c = parseInt(value.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

type Theme = Map<string, string>;

function get(theme: Theme, name: string): string {
  const value = theme.get(name);
  if (!value) throw new Error(`Missing token ${name}`);
  return value;
}

const lightBase = block(":root");
const darkForced = new Map([...lightBase, ...block(':root[data-theme="dark"]')]);
const darkMedia = new Map([...lightBase, ...block(':root:not([data-theme="light"])')]);

function themeWithAccent(base: Theme, accent: Map<string, string>): Theme {
  return new Map([...base, ...accent]);
}

const surfaces = [
  "--color-bg",
  "--color-bg-sidebar",
  "--color-surface",
  "--color-surface-sunken",
  "--color-hover",
  "--color-active",
];

const pairs: [fg: string, bg: string][] = [
  ...surfaces.flatMap((bg): [string, string][] => [
    ["--color-text", bg],
    ["--color-text-muted", bg],
  ]),
  ...["danger", "success", "warning", "info"].flatMap((s): [string, string][] => [
    [`--color-${s}`, `--color-${s}-bg`],
    [`--color-${s}`, "--color-surface"],
    [`--color-${s}`, "--color-bg"],
  ]),
  ["--color-diff-add-text", "--color-diff-add-bg"],
  ["--color-diff-del-text", "--color-diff-del-bg"],
  ["--accent-fg", "--accent"],
  ["--accent-fg", "--accent-hover"],
  ["--accent-text", "--color-bg"],
  ["--accent-text", "--color-bg-sidebar"],
  ["--accent-text", "--color-surface"],
  ["--accent-text", "--color-hover"],
  ["--accent-text", "--accent-soft"],
  ["--color-text", "--accent-soft"],
];

describe("design token contrast (WCAG 2.2 AA, 4.5:1)", () => {
  it("dark theme blocks for OS preference and forced dark are identical", () => {
    expect(Object.fromEntries(darkMedia)).toEqual(Object.fromEntries(darkForced));
    for (const accent of ACCENTS) {
      expect(
        Object.fromEntries(block(`:root:not([data-theme="light"]) [data-accent="${accent}"]`)),
      ).toEqual(Object.fromEntries(block(`:root[data-theme="dark"] [data-accent="${accent}"]`)));
    }
  });

  for (const accent of ACCENTS) {
    const light = themeWithAccent(lightBase, topLevelBlock(`[data-accent="${accent}"]`));
    const dark = themeWithAccent(
      new Map([...darkForced, ...topLevelBlock(`[data-accent="${accent}"]`)]),
      block(`:root[data-theme="dark"] [data-accent="${accent}"]`),
    );
    for (const [name, theme] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      it.each(pairs)(`${name}/${accent}: %s on %s`, (fg, bg) => {
        const ratio = contrast(get(theme, fg), get(theme, bg));
        expect(ratio, `${fg} on ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          MIN_TEXT_CONTRAST,
        );
      });
    }
  }
});
