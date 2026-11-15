import axe from "axe-core";

/** Runs axe-core and returns serious or critical violations as readable strings. */
export async function seriousViolations(node: Element): Promise<string[]> {
  const result = await axe.run(node, {
    // jsdom has no layout, so contrast is checked from tokens in contrast.test.ts.
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}
