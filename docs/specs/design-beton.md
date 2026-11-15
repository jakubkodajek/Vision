# Spec: Beton design system (brutalist / functionalist UI)

- **Feature id:** none (visual redesign of the existing UI; no behaviour change)
- **Status:** Done

## Problem
The owner judged the first UI generic ("AI slop"): warm off-white, large radii, soft shadows,
pastel status pills, a teal accent and an icon in front of every label. None of it says what
Vision is: a control panel for terminals, sign-ins and MCP processes. The owner asked for a
design based on brutalism and functionalism and picked direction A ("Beton") from mockups.

## Principles and sources
1. Show structure instead of hiding it ("seamfulness"): Viget, *Web Brutalism, Seamfulness,
   and Notion* (https://www.viget.com/articles/web-brutalism-seamfulness-and-notion/).
2. Decoration only when needed, underlined links, buttons that look like buttons, performance as
   a feature: Copeland, *Guidelines for Brutalist Web Design* (https://brutalist-web.design/).
3. Grid, flush-left text, objectivity: Swiss / International Typographic Style
   (https://en.wikipedia.org/wiki/Swiss_Style_(design)).
4. "Less, but better": Dieter Rams, ten principles (https://www.vitsoe.com/gb/about/good-design).
5. Truth to materials: the material of this app is text, processes and state, so commands are
   shown raw (`$ npx ...`) and the interface is set in a monospace face.

Not neo-brutalism (candy colours, offset drop shadows): that is its own trend.

## Rules
- **Lines, not shadows.** `--line` (2 px) ink borders for structure, `--line-thin` + `--color-rule`
  for row separators. Every `--shadow-*` token is `none`; every `--radius-*` token is `0`.
- **Type.** `--font-sans` and `--font-mono` are JetBrains Mono Variable. `--font-display` is
  Archivo Variable (width axis 62-125 %), used at 112-125 % width, weight 800-900, uppercase for
  page titles, the wordmark, dialog titles, figures and names (tools, servers, profiles).
  Labels, buttons, navigation and status tags are uppercase with `--letter-spacing-caps`.
- **Colour.** Concrete and ink: light `#d6d3cc` / `#e9e7e2` / `#0b0b0b`, dark `#111` / `#1a1a1a`
  / `#e6e3dc`. One signal colour, international orange (`--color-signal`), only for "this needs
  you": warning tags, the current navigation number, the palette prompt, the hover of primary
  buttons. `--color-signal-on-ink` is the variant drawn on inverted ink (darker in dark theme).
- **Inversion as emphasis.** Current navigation row, primary buttons, success tags, the selected
  palette option and segmented option, and MCP command lines invert to ink.
- **Status tags.** Solid ink = fine, signal = needs you, red = broken, dashed = off or unknown.
  The word always carries the state; status pictograms are hidden.
- **Icons.** Button, badge, overview and "planned" icons are hidden (decoration). Icon-only
  buttons, the collapsed rail, tree, inline warnings and isolation notes keep theirs.
- **Navigation.** A numbered index (`01 HOME`) via CSS counters; no markup change.
- **Overlays.** Dialog and palette backdrops are a hatched scrim (`--color-hatch`), not a blur.
- **Profile accent.** Kept as five palettes, used only for the profile avatar and swatches.
- **Focus.** `--focus-ring` is ink in both themes, so it keeps 3:1 on every surface regardless
  of the profile accent.

## Acceptance criteria
1. `tests/ui/contrast.test.ts` passes for both themes and all five accents, including the new
   pairs: inverse on ink, signal-fg on signal, danger-fg on danger, signal-on-ink on ink.
2. All existing UI tests pass unchanged (no markup or behaviour change besides `LogoMark`).
3. Screenshots in `docs/screenshots/real-app/` show the new design in light and dark.

## Technical notes
- New dependency `@fontsource-variable/archivo` 5.3.0 (OFL, bundled so `font-src 'self'` holds);
  `@fontsource-variable/inter` removed.
- MCP rows: `.server-main` and `.server-side` become `display: contents` at wide widths so the
  command line can span the row; DOM, reading and focus order are unchanged. Below 900 px the
  previous stacked layout returns.
- `LogoMark` is a placeholder (orange V on an ink square) until the owner picks a logo.
