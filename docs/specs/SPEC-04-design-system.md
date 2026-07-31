# SPEC-04 — Design System

Governs: design tokens, typography, iconography, component styling, layout &
breakpoints, and motion. Requirement IDs: `DS-*`. Every value below is
extracted from `Bullet Journal v2.dc.html` — the prototype is the visual
source of truth; deviations must be recorded in §8.

## 1. Feel

Warm, dark, quiet. A single orange accent used sparingly (primary actions,
the AI presence, today's calendar dot). Hairline borders instead of shadows
for structure; shadows only on overlays. Small type set tight, generous line
height on reading text. No decoration that isn't information.

## 2. Color tokens

Dark theme only in v1 (the design defines no light theme).

```css
:root {
  /* canvas */
  --bg-page: #16130f; /* page behind the frame, html/body */
  --bg: #1e1a17; /* app surface, cards, inputs, header */
  --bg-hover: #241f1b; /* row hover, AI-row tint, sidebar bg, card footers */
  --bg-line: #2b2521; /* hairline row dividers, chips, tab-bar track, nav hover */
  --bg-raised: #3a322c; /* active tab / active nav item */

  /* strokes */
  --border: #352e28; /* standard 1px borders; also ::selection bg */
  --border-strong: #574d45; /* scrollbar thumb, strong badge border, bullets */
  --border-check: #5c5148; /* unchecked checkbox border */
  --border-control: #7b6d63; /* WCAG-corrected interactive-control border; §8 */

  /* text */
  --fg: #f5efea; /* primary text */
  --fg-body: #d6ccc4; /* secondary reading text, calendar days */
  --fg-mid: #b3a79e; /* tertiary, icon buttons, AI panel text */
  --fg-mute: #9c8f85; /* captions, counts, placeholders-adjacent */
  --fg-faint: #968a81; /* corrected normal-text contrast on raised surfaces */

  /* accent */
  --primary: #e4652e; /* primary buttons, links, AI accent, today dot */
  --primary-hover: #f0773d; /* button hover (links hover #F0873F) */
  --primary-fg: #1b1310; /* text on primary */
  --ai-bg: rgba(228, 101, 46, 0.15);
  --ai-fg: #f09a70; /* WCAG-corrected; §8 */
  --ai-border: rgba(228, 101, 46, 0.42); /* WCAG-corrected; §8 */

  /* status */
  --danger: #f3978b; /* WCAG-corrected; §8 */
  --danger-bg-hover: #3a211c;
  --danger-border: #704238; /* WCAG-corrected; §8 */
  --ok: #4ade80; /* connected status dot */

  /* overlay */
  --overlay: rgba(0, 0, 0, 0.7);
  --shadow-menu: 0 10px 30px -10px rgba(0, 0, 0, 0.55);
  --shadow-dialog: 0 24px 60px -20px rgba(0, 0, 0, 0.7);
  --shadow-toast: 0 12px 30px -12px rgba(0, 0, 0, 0.7);
}
```

- DS-1 `--primary` is reserved for: the single primary action per surface,
  links, the AI badge family, today's calendar dot, and the toast. It never
  colors decorative elements.
- DS-2 Structure comes from `--border`/`--bg-line` hairlines; box shadows
  appear only on the type menu, dialogs, and toast.

## 3. Typography

- DS-3 Families: **Geist** (400/500/600) for UI, **Geist Mono** (400/500)
  for times, activity timestamps, tool names, URLs, and the ⌘K hint.
  Self-hosted `woff2` (no Google Fonts request at runtime — PWA offline and
  privacy). Fallbacks: `ui-sans-serif, system-ui, sans-serif` /
  `ui-monospace, monospace`. `-webkit-font-smoothing: antialiased`.
- DS-4 Type scale (px) and roles:

  | Size | Weight  | Role                                                     |
  | ---- | ------- | -------------------------------------------------------- |
  | 16   | 600     | Collection title                                         |
  | 15   | 600     | App title, header title, dialog title                    |
  | 14   | 500     | Activity/migration card title                            |
  | 13.5 | 400–600 | Entry text, body, section headings (600), composer input |
  | 13   | 400–500 | Nav items, buttons, search results, popover items        |
  | 12.5 | 400–500 | Subtitles, captions, small buttons, field values, hints  |
  | 12   | 400–500 | Field labels, counts, card meta, small button labels     |
  | 11.5 | 400–500 | Tags, times (mono), weekday labels, tool names (mono)    |
  | 11   | 500     | Badges, chips                                            |
  | 10.5 | 600     | Count badges (tab/nav)                                   |

- DS-5 Letter-spacing `-0.01em` on 15–16px titles (`-0.005em` at 13.5px
  section headings). Line-height: 1.3 titles, 1.4–1.45 rows, 1.5–1.6
  reading text (summary, explainers). Long text uses `text-wrap: pretty`;
  truncating rows use single-line ellipsis.
- DS-6 iOS exception: any focusable text input computes to ≥16px on touch
  devices to prevent focus zoom (SPEC-05 §3) — visually compensated, this is
  the one sanctioned deviation from DS-4.

## 4. Iconography

- DS-7 Icons are inline SVG, `viewBox="0 0 24 24"`, `fill="none"`,
  `stroke="currentColor"`, `stroke-width="2"` (2.2–3.2 for small check/
  sparkle glyphs), round caps/joins. Rendered at 10–16px square. The set
  (paths in the prototype): check, calendar, note/file, idea (bulb),
  question, habit (cycle), mood (face), sparkle (AI), search, settings-star,
  chevron left/right/down, plus, x, arrow-right, undo, trash, folder,
  today-calendar, info-circle.
- DS-8 The sparkle glyph is the assistant's mark everywhere (badge, Review
  activity cards, summary card, nav Review icon, settings). Never use it for
  non-AI meaning.

## 5. Layout & breakpoints

- DS-9 Breakpoints: **narrow** < 680px · **mid** ≥ 680px · **wide** ≥ 1024px.
- DS-10 Frame: full-viewport height column, centered on `--bg-page`.
  - narrow: full-bleed.
  - mid: max-width 560px, 1px side borders.
  - wide: max-width 1160px; sidebar 236px (bg `--bg-hover`, right border) +
    main pane; in-pane content column max-width 720px, centered.
- DS-11 Vertical composition: header (flex-none) · scrollable main
  (`overflow-y: auto`, `overscroll-behavior: contain`, custom 8px scrollbar,
  thumb `--border-strong`) · composer (flex-none, top border). Dialogs and
  toast overlay the frame.
- DS-12 Navigation chrome: narrow/mid — 4-segment tab bar in the header
  (track `--bg-line`, radius 8, padding 3; active segment `--bg-raised`);
  wide — sidebar with 34px nav rows (radius 6, active `--bg-raised`,
  hover `--bg-line`), a bottom group (Search with ⌘K hint, Assistant
  access) above a top hairline.
- DS-13 Spacing rhythm: screen gutters 16px; card padding 12–14px; section
  headers `14px 16px 6px`; row padding `9px 16px` (comfortable) /
  `6px 16px` (compact); grid gaps 8px (action grids), 2px (calendar/nav).
- DS-14 Radii: 4 (checkbox, small chips/badges) · 6 (buttons, inputs, nav
  rows, calendar cells) · 8 (cards, tab track, type menu, field groups) ·
  10 (large cards: calendar, automatic-change, summary, index groups) · 12 (dialog)
  · 999 (pills, dots, count badges).

## 6. Components

Control heights: 28 (calendar chevrons) · 30 (small buttons, tab segments) ·
32 (header icon buttons, card footer buttons) · 34 (nav rows, action-grid
buttons) · 36 (composer input/submit/type button). Hit areas on touch ≥40px
via padding (SPEC-05).

- DS-15 **Buttons.** Primary: `--primary` bg, `--primary-fg` text, no
  border, hover `--primary-hover`. Secondary: `--bg` bg, 1px `--border`,
  hover `--bg-line`. Danger: secondary shape with `--danger` text; hover
  `--danger-bg-hover` + `--danger-border`. Icon buttons: 32px square,
  secondary shape, `--fg-mid` → `--fg` on hover. Weight 500, sizes 12–12.5.
- DS-16 **Inputs.** 36px, `--bg` bg, 1px `--border-control`, radius 6,
  13.5px; focus: border `--primary` + a 2px `--primary-hover` outline with
  2px offset; placeholder `--fg-faint`; selection bg `--border`.
- DS-17 **Entry row.** Grid `18px 1fr auto`, column-gap 11, top-aligned;
  hover `--bg-hover`; bottom hairline `--bg-line`; background transition
  `.1s ease`. Checkbox 16px, radius 4, border `--border-control` →
  done: bg/border `--primary`, checkmark `--primary-fg`. Meta badges: 18px
  tall, radius 4, 11px/500 — type badge (`--bg` + border), state badge
  (`--bg-line`), AI badge (18px square, `--ai-*` family). Time 11.5px mono
  `--fg-mute`.
- DS-18 **Cards** (leftovers, calendar, automatic change, summary, activity, index
  groups, field groups): 1px `--border`, radius 8–10, transparent bg;
  action footers `--bg-hover` with top hairline; internal rows split by
  `--bg-line` hairlines.
- DS-19 **Badges & pills.** Activity-kind chip (Review): 20px pill, border, sparkle +
  11px/500 label. Status pill (settings): 22px pill, `--bg-line` bg, 5px
  status dot (`--ok`). Count badge: ≥16px circle, 10.5px/600 — `--primary`
  on active/sidebar, `--border-strong` bg + `--fg-mid` text on inactive tab.
  Mode badges (tool list): 19px, radius 4 — `automatic` uses the `--ai-*`
  family; `read only` uses `--bg-line` + `--fg-mute`.
- DS-20 **Dialogs.** Overlay `--overlay`; panel max-width 400px, max-height
  86%, `--bg`, 1px `--border`, radius 12, `--shadow-dialog`; header = title
  - description + 26px close button. **Type menu**: anchored popover 208px,
    radius 8, `--shadow-menu`, 32px option rows with trailing check.
- DS-21 **Toast.** Bottom-anchored above the composer (inset 12px, bottom
  ≈96px), `--primary` bg, `--primary-fg` text, radius 8, check icon,
  12.5px/500, `--shadow-toast`.
- DS-22 **Calendar cell.** 38px visual, radius 6, 12.5px, inside a ≥40px
  button hit area; today: 600 weight,
  `--bg-line` bg + `--border` border, `--primary` dot; other days
  `--fg-body`, dot `--border-strong` (4px, bottom 4). Weekday labels 26px,
  11.5px/500 `--fg-mute`.
- DS-23 **Composer.** Top border on `--bg`; padding `10px 12px 12px`; chip
  row (20px chips, `--bg-line` bg, `--fg-mid`); 36px type button + input +
  36px primary submit; hint line 11.5px `--fg-mute`.

## 7. Motion

- DS-24 Durations/easings (the only animations in the product):

  | Element          | Animation                                                                    |
  | ---------------- | ---------------------------------------------------------------------------- |
  | Dialog overlay   | fade in 130ms ease-out                                                       |
  | Dialog panel     | fade + scale(.97) + translateY(6px) → none, 160ms `cubic-bezier(.16,1,.3,1)` |
  | Type menu        | same dialog curve at 120ms                                                   |
  | Toast            | keyframed fade/slide in-hold-out over 2.4s                                   |
  | Row/button hover | background 100ms ease                                                        |

- DS-25 No layout animations, no skeletons, no spinners for local data;
  respect `prefers-reduced-motion` by dropping scale/translate (fade only).

## 8. Deviation log

Deliberate deviations from the prototype (keep this list current):

| #   | Deviation                                                                                          | Reason                                                  |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Inputs ≥16px on touch (DS-6)                                                                       | iOS focus-zoom prevention                               |
| 2   | Fonts self-hosted, not Google Fonts CDN                                                            | offline PWA + privacy                                   |
| 3   | Prototype props (`density`, `showTypeBadges`, `highlightAiEntries`) become persisted user settings | props were a design-tool affordance                     |
| 4   | "File in ideas" → collection picker (LOG-20)                                                       | prototype hard-coded one collection                     |
| 5   | Settings "Connected" pill is computed, not static (LOG-41)                                         | truthful status                                         |
| 6   | `--fg-faint` raised to `#968A81`                                                                   | WCAG 2.2 AA normal-text contrast on `--bg`/`--bg-hover` |
| 7   | Review proposal cards/modes replaced by activity/revert cards and automatic modes                  | approved accountable-autonomy contract                  |
| 8   | Interactive borders use `--border-control: #7B6D63`; input focus uses a 2px offset outline         | WCAG 2.2 non-text contrast and visible keyboard focus   |
| 9   | AI/danger foreground and border tokens are raised to the exact values in §2                        | WCAG 2.2 AA text and non-text contrast                  |
