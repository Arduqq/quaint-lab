# Character Profile Redesign

**Date:** 2026-06-21
**Status:** Approved

## Summary

Today, selecting a character splits the archive screen into three CSS-grid
columns: a sidebar (game/category nav), a center pane (`#main` — name,
render, figures/ability-icon galleries, variants), and a right-side panel
(`#char-panel` — element/species/gender/role/owned/level/favorite/extra,
plus the embedded 3D model viewer). This is the same layout in both the
curation tool and the published static site — only individual edit buttons
are hidden via the existing `PUBLISH` flag. The result reads as an editor
form in both places.

This redesign consolidates the center pane and the side panel into one
full-width "profile" — led by a trading-card-style hero (render + name/
element/core-stats), followed by a secondary-details strip, then the
existing galleries/variants/3D-model sections restyled to match. One
template, one set of functions, in both curation and published builds —
`PUBLISH` keeps gating only the edit affordances inline, exactly as it does
today.

## Context

- **`renderCharProfile(lname, sky)`** (`scripts/reclassify-tumblr.mjs:2321-2366`)
  builds into `#main`: name/element badge header, render section,
  `profGallery()` ×2 (figures, ability icons), `profVariants()`.
- **`renderCharPanel()`** (`scripts/reclassify-tumblr.mjs:2808-2903`) builds
  into `#char-panel`: a `#prof-model-panel` mount point (filled by
  `renderProfileModelViewer()`, line 2966-3005), name/game subtitle, and a
  metadata block that's read-only `<div>`s under `PUBLISH` (line 2845-2861)
  or an editable form with a Save button under curation (line 2862-2879).
- **Layout mechanism:** `#layout` is a CSS grid, `var(--sb) 1fr` by default,
  `var(--sb) 1fr var(--cp)` when `.has-panel` is added
  (`scripts/reclassify-tumblr.mjs:1357-1358`). `renderCharPanel()` adds/
  removes `.has-panel` on `#layout` (line 2815, 2821) depending on whether a
  character is selected. `#char-panel` itself is `display:none` unless
  `.has-panel` is present (line 1410-1412).
- `#char-panel`/`.has-panel` are used nowhere else in the file (confirmed via
  full-file grep) — safe to remove as a concept entirely.
- **Pose-detail interaction:** `renderGrid()` (`scripts/reclassify-tumblr.mjs:2699-2716`)
  explicitly clears `.has-panel` when the full-page pose editor
  (`poseDetailChar` set) is open, because `renderCharPanel()` early-returns
  in that state and never touches the class itself. Once `.has-panel` stops
  existing as a concept, this line becomes dead code to delete.
- **3D model viewer** (`renderProfileModelViewer`, line 2966-3005): mounts
  the canvas, a variant switcher (if >1 model), and a single "Pose & send to
  card →" button that opens the full-page pose editor. No curation-only
  controls exist in this function today — it's already render-equivalent in
  both builds, so it needs no behavioral changes, only a new mount location.
- **Element colors:** `EL_COL` lookup (referenced line 2329) maps element
  name → hex color, used for the badge's border/text/background tint.
- **Helpers used throughout:** `profBtn(label, onClick, extraClass)` (button
  factory), `escAttr(value)` (HTML-attribute escaping), `ARCHIVE_BASE`
  (image path prefix), `PUBLISH` (boolean, gates edit affordances).
- CSS variables already defined in `:root` (line 1345-1346):
  `--bg`, `--bg2`, `--bg3`, `--bd`, `--txt`, `--muted`, `--gold`, `--acc`,
  `--sb`, `--cp` (the last one, `--cp`, becomes unused once `#char-panel` is
  removed).

## Decisions Made

| Question | Decision |
|---|---|
| Overall feel | Trading-card / poster, not a form |
| 3D model viewer | Keep embedded; no behavioral changes needed (already has no curation-only controls) |
| Card-face stats | Core only: element badge + species + role. Owned/level/favorite/extra move to a secondary strip |
| Hero layout | Side-by-side: render image left, name/badge/stats panel right (not full-bleed overlay, not a centered banner) |
| Sections below the hero | Stacked (current pattern), restyled to match the card's theme — not tabbed |
| Curation vs. published | Same layout in both; edit buttons/inputs embedded inline into the new structure, gated by the existing `PUBLISH` flag — no separate published-only template |
| Secondary metadata placement | Compact pill strip directly under the hero card, before the Figures gallery |
| Page layout | Consolidate `#main` + `#char-panel` into one full-width profile pane; remove the 3-column `.has-panel` grid mechanism for the character view |

## Design

### 1. Layout consolidation

Remove `#char-panel` (the `<aside>` element, line 1912) and the
`.has-panel` grid-column mechanism (line 1358, 1412) entirely. `#layout`
keeps its default two-column grid (`var(--sb) 1fr`) at all times — the
sidebar and one full-width main pane, never a third column.

`renderCharPanel()` is removed. Its responsibilities (metadata block, 3D
model viewer mount, Save flow) move into `renderCharProfile()`, which
becomes the single function that builds the whole profile into `#main`.
`saveCharPanel()` (line 2905+, posts the edited metadata form) is unchanged
internally — it's still called from a Save button, just one now living
inside the consolidated pane instead of `#char-panel`.

`renderGrid()`'s pose-detail branch (line 2706-2712) drops the
`document.getElementById('layout').classList.remove('has-panel')` line —
nothing sets `.has-panel` anymore, so there's nothing to clear.

### 2. Trading-card hero

Replaces the current header + render section (line 2324-2361). A two-column
flex/grid block:

- **Left:** the render image (or the existing "No render assigned" empty
  state), same `<img>`/empty-state markup as today, restyled to fill its
  half of the card.
- **Right:** name (`<h2>`), element badge (same `EL_COL`-driven styling as
  today, same markup), then species and role as a small two-item stat row
  (label + value each, e.g. "Species" / "Mabu Golem"). Omit a stat row
  entirely if the underlying field is falsy (matches existing pattern of
  omitting the element badge when `sky.element` is unset).
- Curation-only render actions (Change/Assign render, Auto-fill, Remove —
  currently line 2353-2360) move into this right-hand panel, below the
  stats, still gated by `if (!PUBLISH)`, calling the same existing
  `openImagePicker`/`autoFillCharField`/`saveCharField` functions
  unchanged.

### 3. Secondary details strip

A new compact row directly below the card, before the Figures gallery.
Shows, each as a small pill/label-value pair, only when the underlying
value is present (no empty pills):

- Owned (✓/✗, matching today's `sky.owned ? '✓ Owned' : '✗ Not owned'`
  text from line 2851 — always shown, since "not owned" is itself
  meaningful, unlike the others)
- Favorite (★, shown only if `sky.favorite` is truthy — line 2852)
- Level (shown only if `sky.level != null` — line 2853)
- Each entry in `sky.extra` (line 2858-2860 read-only / 2891-2897 editable)

Under curation, this strip also hosts the existing editable controls for
these fields (the `cp-owned`/`cp-favorite`/`cp-level` checkboxes/inputs,
the `cp-extra` rows with add/remove, and the `cp-save`/`cp-status`
Save button) — same fields, same `saveCharPanel()` call, restyled to fit
the pill-strip visual language instead of the current vertical form. The
gender field (currently a plain text input/read-only div, line 2848/2867)
also lives here, alongside owned/level/favorite, since it didn't make the
card face.

### 4. Stacked sections below

`profGallery()` (figures, ability icons) and `profVariants()` keep their
exact existing logic and curation-only affordances (Add/Auto-fill/Remove
buttons, Add-variant form) — only their CSS (`.prof-section-hd`,
`.prof-gallery`, `.prof-variant`, etc.) gets restyled to match the card's
dark+gold visual language (consistent header treatment, consistent
spacing), not restructured. `renderProfileModelViewer()`'s output mounts
into a section in this same stack instead of inside the old
`#prof-model-panel`/`#char-panel` — no changes to the function itself.

### 5. CSS

`.cp-*` classes (currently scoped to `#char-panel`'s form) and `.prof-*`
classes get unified into one consistent visual language sharing the same
dark+gold palette already defined in `:root`. `--cp` (the old panel-width
variable) is removed since nothing references the third grid column
anymore.

## Error Handling / Edge Cases

- **No render assigned:** existing "No render assigned" empty state, now
  rendered inside the card's left slot instead of a standalone section.
- **No element:** badge area omitted from the card's right panel (existing
  behavior, unchanged).
- **No species/role:** that stat row omitted from the card face (new
  behavior — today these fields are always shown as form fields with
  placeholder "—"; the card face only shows what's present, since a
  trading card with empty stat lines reads as broken).
- **No figures/abilityIcons/variants:** existing "None assigned yet." empty
  states (line 2247-2249), unchanged, just restyled.
- **No 3D model:** existing "No 3D model available for this character."
  empty state (line 2971), unchanged.
- **Character not in roster** (`!sky`, line 2830-2837 in the old
  `renderCharPanel`): existing "Not in roster" message, carried over as-is
  into the consolidated function.
- **Curation-only affordances:** every single one (render Change/Auto-
  fill/Remove, gallery Add/Auto-fill/Remove, variant Remove/Add, metadata
  Save/+Add property) keeps its exact existing `if (!PUBLISH)` gate — no
  new gating logic introduced, no behavior changes to what's editable
  where.

## Testing

No test framework in this project (consistent with all prior plans).
Verification is manual, via the curation server, in both builds:

1. Load a fully-populated character (render, multiple figures, ability
   icons, variants, a 3D model) in curation mode — confirm the new card
   layout, the secondary strip, restyled sections, and that every existing
   edit action (auto-fill, add/remove image, add/remove variant, edit
   metadata + save) still works exactly as before.
2. Load the same character in the `--publish` build — confirm zero edit
   affordances render anywhere (no buttons, no inputs, no Save), and that
   read-only metadata (species/role on the card, owned/level/favorite/extra
   in the strip) still displays correctly.
3. Load a sparse character (no render, no figures, no variants, no model,
   no element) in both builds — confirm every empty state still renders
   without errors and without empty/broken-looking stat rows on the card
   face.
4. Confirm the 3-column `#char-panel` layout is gone — `#layout` never
   grows a third column, `.has-panel` is never added, selecting a
   character doesn't squeeze the available width.
5. Confirm the full-page pose editor (`openPoseDetail`) still opens and
   renders the 3D model correctly from its new mount location, and that
   leaving it returns to a correctly-laid-out consolidated profile pane.
