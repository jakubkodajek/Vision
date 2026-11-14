/** A run of message text: prose or a fenced code block. */
export type TextSegment = { kind: "text"; text: string } | { kind: "code"; text: string; lang: string };

/**
 * Splits message text on ``` fences. Output is rendered as React text nodes only,
 * never as HTML, so model output cannot inject markup (PLAN §2.3). Full Markdown
 * with sanitisation arrives with F-020. Time O(n), space O(n) in the text length.
 */
export function splitFences(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const fence = /```([\w+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const start = match.index;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "code", lang: match[1] ?? "", text: (match[2] ?? "").replace(/\n$/, "") });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments
    .map((s) => (s.kind === "text" ? { ...s, text: s.text.replace(/^\n+|\n+$/g, "") } : s))
    .filter((s) => s.kind === "code" || s.text.length > 0);
}
