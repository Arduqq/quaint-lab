# Skylanders Hub Redesign

**Date:** 2026-06-22
**Status:** Approved

## Summary

The Skylanders hub (`src/pages/server/skylanders/index.njk`, `/server/skylanders/`)
is currently a full-viewport background photo with a 2×2 grid of glassy
gradient-accented cards plus an unfinished animated "Portal · Coming Soon"
placeholder. This redesign replaces it with a compact, fan-site-style page
modeled on darkSpyro.net: a small action-art banner with a logo wordmark and
randomized character art, a single-row nav bar, and a plain bordered list of
the same destination links with their existing descriptions — denser,
less "glassy dashboard," more "Skylanders fan page."

Several earlier directions (an isometric Lost-Islands-themed building diorama
with leader-line callouts, then a GeoCities-kitsch full rewrite) were explored
and explicitly rejected during brainstorming in favor of this one. Nothing
from those directions carries into this spec.

## Context

- Current file: `src/pages/server/skylanders/index.njk` (440 lines, self-contained
  `<style>` block + markup, no separate CSS file).
- Current structure being replaced in full: `#hub-bg` (fixed full-viewport photo
  + gradient overlay), `#hub-logo` (logo image + "Tools & Archive" eyebrow),
  `#hub-stage` → `#hub-cards` (2×2 grid of `.hub-card` elements with per-card
  accent colors) + `#hub-portal` (animated SVG ring, "Character / Portal ·
  Coming Soon / Page Doll" placeholder), `#hub-back` (footer link to `/server/`).
- The four existing destination cards and their copy carry forward unchanged:
  - Archive → `/server/skylanders/archive/` — "Browse the full Tumblr image
    archive — classify, tag, and annotate"
  - Collection → `/server/skylanders/collection/` — "View your full Skylanders
    collection across all six games"
  - Collection Maker ("Builder") → `/server/skylanders-builder/` — "Build and
    customize your collection data, mark owned figures"
  - NFC Cards → `/server/skylanders/nfc-card/` — "Design custom NFC card art
    for any Skylander character"
- The "Page Doll" portal feature is an existing, explicitly-unfinished
  placeholder (no destination yet). It carries forward as a fifth, visually
  disabled entry in the new link list rather than being dropped, since no
  decision was made to remove the feature — only to restyle the whole page.
- **Banner art source:** `skylanders-archive/ring-of-heroes/banners/banner-assets-used-for-the-gacha-segments-of-sky_748388608360235000_2.png`
  (archive image ID `RH-2488`), a widescreen Ring of Heroes promo collage
  already in the repo. Resolves on the built site at
  `/images/skylanders-archive/ring-of-heroes/banners/banner-assets-used-for-the-gacha-segments-of-sky_748388608360235000_2.png`
  (passthrough-copied per `.eleventy.js:9`).
- **Character art source:** `src/_data/skylanders.json`, a flat array of 6 game
  groups (`{ game, characters: [{ name, render, figures }] }`), 159 characters
  total. `render` is a path like
  `spyros-adventure/character-art/character-art-spyro.png`, served at
  `/images/skylanders-archive/<render>`.
- **Existing palette/fonts, reused as-is:** `--gold #ffcc00`, `--gold2 #ff9900`,
  body background `#09182e`, `'Bangers'` (display) + `'Nunito'` (body) from the
  Google Fonts `@import` already in the file.
- **Reference site:** darkSpyro.net was inspected via fetch for structure
  (text-wordmark logo with nav links integrated directly into one header
  strip, dense bordered content below, minimal decoration). Its actual
  CSS/font lives in external stylesheets that weren't retrievable, so this
  spec reuses the page's own existing fonts (Bangers/Nunito) rather than
  attempting to match darkSpyro's unknown font stack.

## Decisions Made

| Question | Decision |
|---|---|
| Overall aesthetic | darkSpyro-style restraint: dense, bordered, link-list-driven — not GeoCities kitsch, not a glassy dashboard |
| Page chrome | Drop the full-viewport background photo entirely; page background is the existing solid `#09182e` |
| Banner art | `RH-2488` (Ring of Heroes promo collage) as the banner backdrop |
| Banner character art | 3 renders from the full 159-character roster, clustered together (not spread across the banner) |
| Character randomization | Re-picked on every page load via a small inline client-side script, not fixed at build time |
| Header decoration | No hits counter, no marquee/blink, no visitor badges |
| Nav placement | Single row: the 4 destination links + a "← /server/" wayfinding link, directly under the banner |
| Link list style | One bordered box per destination, each showing the link plus its existing description text inline (no hover-to-reveal) |
| "Page Doll" placeholder | Carries forward as a fifth, visually disabled box in the same list (no link, dimmed) |
| Click behavior | Plain `<a>` links, navigate immediately |
| Link label for `/server/skylanders-builder/` | Shortened from today's "Collection Maker" to "Builder" — every mockup shown and approved during brainstorming used "Builder"; description text is unchanged |

## Design

### 1. Page shell

Remove `#hub-bg` (and its `::after` gradient), `#hub-logo`, `#hub-stage`,
`#hub-cards`/`.hub-card` (and its accent-color variants), `#hub-portal`
(and the SVG ring/keyframes), and `#hub-back`. `#hub-root` is kept as a
simple centering wrapper (flex column, centered horizontally, top padding)
around one new container, `#hub-panel`: a bordered box (`border: 1px solid
#3a4a66`), `max-width: 720px`, centered, containing the banner, nav, and
link list described below. No backdrop blur, no rounded corners on the
panel itself — flat, bordered, matching the reference site's plainness.

### 2. Banner (`#hub-banner`)

A `position: relative`, `height: 92px`, `overflow: hidden` strip:

- Background: the RH-2488 image as an `<img>` (not CSS `background-image`,
  so it participates in normal page load/alt-text semantics), `object-fit:
  cover`, `object-position: center 35%` (keeps the action collage's subject
  matter in frame at this short height).
- A bottom-weighted gradient scrim (`rgba(9,24,46,0)` top to `rgba(9,24,46,0.92)`
  bottom) for text legibility, matching the page's existing
  `rgba(6,10,24,…)`-family overlay tone.
- Three `<img class="hub-banner-char">` elements, empty `src` at first paint,
  populated by the randomization script (Section 3). Layout: clustered
  together near the right edge of the banner, slightly overlapping
  (negative `margin-right` between them), heights ~88-96px, bottom-aligned,
  `filter: drop-shadow(...)` for separation from the busy background.
- The wordmark "SKYLANDERS HUB" in `'Bangers'`, `color: var(--gold)`, sized
  to fit the compact banner height (~28px), positioned left-middle with a
  dark `text-shadow` for legibility over the art.

### 3. Character randomization script

A small inline `<script>` at the end of the page:

- Eleventy flattens `skylanders` (the existing `src/_data/skylanders.json`
  global data, already used elsewhere in the site) into a `{name, render}[]`
  array across all 6 games, serialized into the page via a new `json`
  Nunjucks filter (`eleventyConfig.addFilter("json", obj =>
  JSON.stringify(obj))`, added to `.eleventy.js` next to the file's existing
  `addFilter` calls) — there's no such filter today.
- On `DOMContentLoaded`, the script picks 3 distinct random entries from
  that array (simple `sort(() => Math.random() - 0.5).slice(0, 3)` — the
  array is only 159 entries, so the bias of that approach is irrelevant
  here), and sets each `.hub-banner-char`'s `src` to
  `/images/skylanders-archive/${render}` and `alt` to `name`.
- No fallback/loading state needed: the `<img>` elements simply render
  blank until the script runs, which is effectively immediate (inline
  script, no network wait — the array is already in the page).

### 4. Nav bar (`#hub-nav`)

A single flex row directly under the banner: `background: #0c1e38`,
`border-top: 2px solid var(--gold)`, `border-bottom: 1px solid #25324a`.
Contents, left to right: four links (`ARCHIVE`, `COLLECTION`, `BUILDER`,
`NFC CARDS` — caps via `text-transform`, not literal markup, so the
underlying link text stays the same human-readable labels used today),
each `color: #cfd8e8` with a `:hover` transition to `var(--gold)` plus
`text-decoration: underline`; then a `margin-left: auto` "← /server/" link
in a muted color, reusing today's `/server/` destination.

### 5. Link list (`#hub-links`)

Five stacked bordered boxes (`border: 1px solid #25324a`, `padding: 10px`,
small gap between them), each containing a bold underlined link (`color:
var(--gold)`) and the description text beneath it (`color: #a8b4cc`,
smaller size) — reusing the four existing destinations' description copy
verbatim and their current order, with one label change: "Collection Maker"
becomes "Builder" (matching the nav bar and every approved mockup; its
description text and href are unchanged). The fifth box
is the "Page Doll" placeholder: same box styling but dimmed (`opacity:
0.5`), no `<a>` (a plain `<span>` for the label), and "Coming Soon" in
place of a description — preserving today's unfinished-feature signal
without the old animated portal ring.

### 6. Responsive behavior

One breakpoint, `max-width: 600px`: `#hub-nav` switches to `flex-wrap:
wrap` (so the 4 links + back-link don't overflow), and `#hub-banner`'s
wordmark font-size and the character art heights scale down via `clamp()`
rather than a second hardcoded breakpoint value. The bordered-box link
list and panel width are already fluid (the panel's `max-width: 720px` plus
side padding handles narrow viewports without a separate mobile layout).

## Error Handling / Edge Cases

- **Randomization script failing/disabled (no JS):** the three banner
  character `<img>` elements stay empty (no broken-image icon, since `src`
  is never set to an invalid path) — the banner still reads fine with just
  the backdrop art and wordmark. No `<noscript>` fallback needed.
- **`skylanders.json` data shape changes:** the flattening logic reads
  `game.characters[].{name,render}`, the same fields every other consumer
  of this file already depends on — no new assumption introduced.
- **Disabled "Page Doll" box:** no click target at all (plain text, not an
  `<a>` with `href="#"` or a disabled-looking but clickable link), so there's
  no broken/no-op click to handle.

## Testing

No test framework in this project (consistent with prior work in this repo).
Manual verification via the Eleventy dev server + Playwright (webkit):

1. Load `/server/skylanders/` and confirm the banner renders RH-2488 with
   the wordmark legible over it, and that reloading the page changes which
   3 characters appear (confirms client-side randomization, not a
   build-time-fixed set).
2. Confirm all 4 active links and the nav bar's 4 links + back-link
   navigate to the correct existing destinations (no URL changes from
   today).
3. Confirm the "Page Doll" box renders dimmed with no clickable link.
4. Resize below 600px and confirm the nav row wraps without overflowing or
   clipping, and the banner's text/character sizing shrinks instead of
   breaking layout.
5. Confirm no console errors (e.g. 404s on the banner/character image
   paths) on load.
