# NFC Card Art Pan & Zoom

**Date:** 2026-06-18
**Status:** Approved

## Summary

Let the user fine-tune where the character art sits on the NFC card —
drag to pan, scroll wheel to zoom — instead of only the automatic
centered-fit positioning `drawArtPanel` currently computes. Works the same
way across all three card layouts (Half Image, Quarter Image, Full Image),
resets to default whenever the active character image changes, and has a
manual reset button for convenience.

## Context

- `src/pages/server/skylanders/nfc-card.njk` renders the card on a single
  `<canvas id="card-canvas">` (internal resolution 638×1011, CSS-scaled to
  fit the preview panel) via `drawCard()`, which calls a shared
  `drawArtPanel(x, y, w, h, opts)` building block from each of the three
  layouts with a different rect.
- `drawArtPanel` currently auto-centers the character art (`srcImg`) inside
  its panel rect with no user control over position/scale: a "cover-fit"
  branch for painted illustrations (`srcIsArt`, fills the frame edge-to-edge
  via `Math.max` scale) and a "contain-fit + glow" branch for transparent
  cutouts (`Math.min` scale, padded, with a colored shadow glow).
- The panel is already clipped (`ctx.clip()` when `framed: true`), so
  anything drawn outside its bounds is cropped for free — no extra
  bounds-checking needed for free dragging/zooming.
- This builds on two just-fixed bugs in the same flow: the posed-model
  capture (`profile-model-viewer.js`'s `captureFrame()`) used to bake in a
  skeleton overlay and an opaque dark background; both are now fixed so the
  captured art is a clean transparent cutout, routed through the
  contain-fit + glow branch (`charImgIsArt = false` for this source).

## Decisions Made

| Question | Decision |
|---|---|
| Pan only, or pan + zoom | Pan + zoom |
| Scope across layouts | All three layouts (Half/Quarter/Full) behave the same |
| Persistence across image changes | Resets to centered/default zoom whenever the active character image changes |
| Interaction model | Click-and-drag to pan; mouse wheel to zoom (no slider) |
| Reset control | Small "↺ Reset position" button near the preview, in addition to the automatic reset on image change |

## Design

**New state** (in the existing `state` object): `artOffsetX` and
`artOffsetY` (canvas-space pixels, default `0`), `artZoom` (multiplier,
default `1`, clamped to `0.3`–`4`).

**Rendering:** Both of `drawArtPanel`'s image-drawing branches apply
`artZoom` to the existing fit-scale calculation and add
`artOffsetX`/`artOffsetY` to the final draw position, on top of the
existing centering math — the auto-fit/center logic stays as the baseline,
pan/zoom is purely additive on top of it. Each `drawCard()` call records
the last-drawn art panel's rect (`x, y, w, h`, in the canvas's internal
638×1011 coordinate space) into a module-level variable, since the three
layouts each give the art panel a different rect and the interaction layer
needs to know where it currently is.

**Interaction**, attached to `#card-canvas`:
- `pointerdown` inside the recorded art panel rect starts a drag (no-op if
  there's no active character image, or if the click is outside the panel
  rect — e.g. on the name plate or attack panel).
- `pointermove` while dragging converts the screen-pixel delta to
  canvas-space (accounting for the canvas's CSS scaling factor, the same
  ratio `scaleCanvas()` already computes) and adds it to `artOffsetX/Y`;
  redraws are throttled via `requestAnimationFrame`.
- `pointerup`/`pointercancel` ends the drag.
- `wheel` over the canvas (`preventDefault()`ed so the page doesn't scroll)
  multiplies `artZoom` by a small step factor per tick (e.g. `1.08` /
  `1/1.08`), clamped to `0.3`–`4`, anchored at the panel's center (not the
  cursor — simpler, and sufficient for nudging art into place rather than
  precise compositing).

**Reset:**
- A new "↺ Reset position" button near the preview sets all three values
  back to default and redraws.
- The same reset runs automatically at every point the active character
  image changes: character selection, archive-art gallery picks and
  prev/next paging, custom image upload, and both "clear" buttons
  (`arc-clear`, `clear-custom`) — seven call sites total, all assignments
  to `charImg`/`arcArtImg`/`arcArtUrl`.

## Files Changed

| File | Change |
|---|---|
| `src/pages/server/skylanders/nfc-card.njk` | New `artOffsetX`/`artOffsetY`/`artZoom` state; `drawArtPanel` applies them; new module-level "last art panel rect" tracking; pointer drag + wheel zoom handlers on `#card-canvas`; reset button + its 7 auto-reset call sites |

## Verification

1. Reload `/server/skylanders/nfc-card/`, pick a character.
2. Drag the art around within the preview — confirm it pans and stays
   cropped cleanly within the panel (no overflow outside the frame).
3. Scroll over the preview — confirm it zooms in/out, clamped at the
   extremes, and doesn't scroll the page.
4. Click "↺ Reset position" — confirm it snaps back to centered/default.
5. Switch to a different character (and separately, page through archive
   art for the same character) — confirm pan/zoom resets automatically
   each time.
6. Switch between Half/Quarter/Full layouts with art already panned —
   confirm the interaction still works correctly in each layout's panel
   rect.
7. Export PNG — confirm the panned/zoomed position is reflected in the
   exported file (it should be, since export reads directly from the same
   canvas `drawCard()` already painted).
