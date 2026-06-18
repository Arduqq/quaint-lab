# NFC Card Builder → Pose Editor Deep Link

**Date:** 2026-06-18
**Status:** Approved

## Summary

The NFC card builder (`/server/skylanders/nfc-card/`) currently has no way to get
a 3D model render onto a card except by separately opening the archive
curation UI, finding the character, and using its pose-detail view's
"Send to NFC" button. Add a link in the card builder, next to the existing
"Archive Art" picker, that jumps straight into that pose-detail view for the
currently-selected character — closing the loop without rebuilding any
rendering pipeline.

## Context

- `nfc-card.njk` is a plain 2D-canvas page (no Three.js). Its "Archive Art"
  picker and prev/next browse arrows both read flat `{url, game, anns,
  featured}` entries from a static `skylanders-index.json`, built once at
  `npm run publish-archive` time.
- 3D models are a separate system: `models.json` entries are fuzzy-matched
  onto `SKYLANDERS_LIST` characters inside `scripts/reclassify-tumblr.mjs`
  (`scripts/reclassify-tumblr.mjs:58-72`), and only ever rendered live via
  Three.js inside the archive's profile/pose-detail viewer
  (`profile-model-viewer.js`, wired up by `openPoseDetail`/`renderPoseDetail`
  in `reclassify-tumblr.mjs`).
- The reverse hand-off already exists: the pose-detail view's "↗ Send to NFC"
  button captures a posed render and sends it to the NFC card page via
  `sessionStorage` (`nfc-card-custom-art` / `nfc-card-char-name`), which the
  NFC card page picks up on load (`nfc-card.njk:1811-1834`).
- An evaluated-and-rejected alternative was baking model renders directly
  into the Archive Art skim-through gallery (pre-rendered PNGs in
  `skylanders-index.json`, or a live embedded 3D viewer slide). Decided
  against — adds a render pipeline or ships Three.js to a page that doesn't
  need it, for a feature a simple cross-link already solves.
- The archive page already has a deep-link convention for jumping straight
  into a specific view: `model-viewer.js:44-52` parses `#model=ID` /
  `#texture=ID` from `location.hash` and dispatches a
  `skylander-model-deeplink` CustomEvent that the main script's listener
  (`reclassify-tumblr.mjs:3108-3114`) acts on. This spec reuses that same
  hash-based pattern for `#pose=<name>`.
- Both pages source character names from the same `src/_data/skylanders.json`
  (`nfc-card.njk`'s `CHARS`, built at `nfc-card.njk:450-464`; the archive's
  `SKYLANDERS_LIST`, built at `reclassify-tumblr.mjs:36-56`), so exact-name
  lookups between the two pages are reliable — with one exception (variants,
  see Part 3).

## Decisions Made

| Question | Decision |
|---|---|
| Render approach | No new rendering — link out to the existing pose-detail editor instead of pulling model renders into the NFC card gallery |
| Link target | Deep-link straight into pose-detail mode for the currently-selected character (not just the archive's landing page) |
| Visibility | Always show the link once a character is selected, regardless of whether that character has a matched 3D model — the pose-detail view already shows "No 3D model available for this character" gracefully if there isn't one |
| Navigation | Opens in a new tab (`target="_blank"`), matching the existing reverse `window.open(...)` hand-off from pose-detail's "Send to NFC" button |
| Deep-link mechanism | URL hash (`#pose=<name>`), mirroring the existing `#model=`/`#texture=` convention in `model-viewer.js` |
| Variant characters | Resolve to the *base* character name before linking — the archive's model-matching and pose-detail view are keyed on base names only, variants are just nested tags there |

## Part 1 — `nfc-card.njk`: new link in the right panel

**File:** `src/pages/server/skylanders/nfc-card.njk`

Add a new `opt-section` immediately after the existing `#arc-art-section`
block (after `nfc-card.njk:442`, before the closing `</div>` of `.nfc-panel`
at line 443):

```html
<div class="opt-section" id="pose-link-section" style="display:none">
  <span class="opt-label">3D Model Art</span>
  <a id="pose-link" class="clear-btn" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener">
    ↗ Pose a 3D model for this character
  </a>
</div>
```

Reuses the existing `.clear-btn` styling (no new CSS needed) — it already
reads as a neutral secondary action button, which fits since this is an
"open elsewhere" affordance rather than the primary export action.

In `selectCharacter(char)` (`nfc-card.njk:1446-1466`), after the existing
state-reset lines, show the section and set the link's `href`:

```js
const poseLinkSection = document.getElementById('pose-link-section');
const poseLink = document.getElementById('pose-link');
poseLinkSection.style.display = '';
poseLink.href = '/server/skylanders/archive/#pose=' + encodeURIComponent(char.baseName || char.name);
```

(`poseLinkSection`/`poseLink` constants can be looked up once at module scope
alongside the other `document.getElementById` lookups near the top of the
script, rather than re-queried inside `selectCharacter` every call.)

## Part 2 — `nfc-card.njk`: track base name through variant flattening

**File:** `src/pages/server/skylanders/nfc-card.njk:450-464`

`CHARS` flattens each character's `variants` into top-level entries by
overwriting `name`/`image` on a spread of the base character object — which
means the base name is lost once a variant is selected (`char.name` becomes
the variant's own name, e.g. "Super Shot Stealth Elf", with no way back to
"Stealth Elf"). Add one field when building each variant entry:

```js
const variants = (c.variants || []).map(v => ({ ...base, name: v.name, image: v.image, baseName: base.name }));
```

Base-character entries (the `base` objects pushed via `[base, ...variants]`)
don't get a `baseName` field — they don't need one, since `char.baseName ||
char.name` in Part 1 already falls through to `char.name` for them.

## Part 3 — Archive page: `#pose=` hash deep link

**File:** `scripts/reclassify-tumblr.mjs` (main always-shipped script, not the
curation-only `charProfileJS` block — must work on the published `--publish`
site too, same constraint the original pose-detail-view plan followed)

Immediately before the script's final bootstrap call
(`scripts/reclassify-tumblr.mjs:3120`, `render();`), add:

```js
{
  const m = location.hash.match(/^#pose=(.+)$/);
  const sky = m && SKYLANDERS.find(s => s.name === decodeURIComponent(m[1]));
  if (sky) openPoseDetail(sky);
}
render();
```

`openPoseDetail(sky)` (`reclassify-tumblr.mjs`, added by the prior
bone-posing plan) already sets `poseDetailChar` and calls `render()` itself.
The unconditional `render()` immediately after that runs a second time in
the matched case — this mirrors the existing `#model=`/`#texture=` deep-link
flow, which has the same harmless double-render shape today
(`skylander-model-deeplink` listener calls `render()`, then the script's own
final `render()` runs again), so this isn't a new pattern, just a consistent
one.

If the hash doesn't match, or the name doesn't resolve to any `SKYLANDERS`
entry (shouldn't happen given the shared-data-source guarantee, but cheap to
guard anyway), `sky` is falsy and the page just renders normally with no
pose-detail view opened.

## Error Handling / Edge Cases

- **Character has no matched 3D model:** `renderPoseDetail` already renders
  "No 3D model available for this character." in this case (existing
  behavior, unchanged) — no new empty state needed.
- **Variant selected on the NFC card page:** resolved to its base name before
  linking (Part 2), so it always lands on a real `SKYLANDERS` entry.
- **Hash doesn't match `#pose=...` or name not found:** no-op, page loads
  normally (Part 3).

## Testing

No test framework in this project (consistent with prior model-viewer/pose
plans). Verification is manual:

1. `npm run publish-archive`, then open the NFC card builder and select a
   character with a matched 3D model (e.g. Trigger Happy) — confirm the new
   "↗ Pose a 3D model for this character" link appears, and clicking it opens
   the archive in a new tab directly in that character's pose-detail view
   (skeleton overlay visible, no manual navigation needed).
2. Select a variant (e.g. a SWAP Force or "Super Shot" variant) — confirm the
   link still resolves to the *base* character's pose-detail view, not a
   broken/empty lookup.
3. Select a character with no matched 3D model — confirm the link still
   appears (per the "always show" decision) and clicking it opens the
   archive showing "No 3D model available for this character."
4. Confirm the existing `#model=`/`#texture=` Lost Islands dashboard deep
   link still works unchanged (regression check on the shared hash-parsing
   final-bootstrap area of the script).
