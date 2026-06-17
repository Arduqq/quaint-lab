# Blender-Style Bone Posing & Dedicated Pose/Send Detail View

**Date:** 2026-06-17
**Status:** Approved

## Summary

Replace the dropdown-and-sliders bone UI with click-to-select bone picking in a
dedicated full-page detail view, and move the NFC card handoff there too. The
small character-profile panel viewer is simplified to a quick visual browser
(render + variant switcher only). The skeleton overlay this introduces also
doubles as the tool for visually triaging which of the 295 character models
are actually rigged correctly before publishing.

## Context

- `src/pages/server/skylanders/models/profile-model-viewer.js` currently
  builds a bone-pose UI (`<select>` of `bone N (parent M)` + three X/Y/Z range
  sliders) inside `mount()`, used by the small profile-panel viewer
  (`renderProfileModelViewer` in `scripts/reclassify-tumblr.mjs`).
- `useAsCardArt(sky)` currently captures a frame directly from the small
  panel's canvas and sends it to the NFC card maker via sessionStorage.
- The existing Lost Islands dashboard viewer
  (`src/pages/server/skylanders/models/model-viewer.js`) has the identical
  dropdown+sliders pattern (`mv-bone-select`, `mv-bone-rot-x/y/z`) and is
  toggled via a `mvActive` boolean checked in `renderGrid()`, which
  shows/hides a static `#mv-root` container and calls
  `window.SkylanderModelViewer.show()/hide()`. This is the established
  pattern for full-page-takeover views in this single-page app and the new
  detail view follows it.
- Both `renderProfileModelViewer`/`useAsCardArt` and `profile-model-viewer.js`
  already live outside the curation-only `charProfileJS` block (moved there
  in a recent fix) because they have no server dependency and must survive
  the `--publish` strip. The new detail view has the same requirement.

## Decisions Made

| Question | Decision |
|---|---|
| Bone QA (re-evaluate rigging) | No separate investigation — the skeleton overlay built for posing doubles as the visual triage tool |
| Posing sophistication | Click-to-select bones in 3D (replacing the dropdown); rotation still via X/Y/Z sliders, now driven by the clicked bone |
| Detail view architecture | New full-page state in the existing single-page app (`poseDetailChar`), following the `mvActive`/`#mv-root` pattern — not a new URL/route, not a modal |
| Small profile panel | Simplified — drop bone UI entirely, keep canvas + variant switcher; button becomes "Pose & send to card →" and navigates to the detail view |
| NFC handoff | Moves from the profile panel to the detail view — "Send to NFC" there does the same `captureFrame()` → sessionStorage → `window.open()` flow |

## Part 1 — `profile-model-viewer.js`: posable mount option

`mount(containerEl, models, opts)` gains an `opts.posable` flag (default
`false`).

- `posable: false` (small profile panel): behaves as today, **minus** the
  bone UI — `buildBoneUi`, `populateBoneSelect`, `syncSlidersFromBone`,
  `onBoneRotChange` and the `<select>`/sliders markup are not built at all.
- `posable: true` (new detail view): builds the existing slider UI **plus**:
  - A `THREE.SkeletonHelper` added to the scene alongside the model, giving
    a visible line-skeleton overlay that updates automatically as bones move.
  - One small sphere mesh per bone (`THREE.Mesh` with a tiny
    `SphereGeometry`), repositioned every frame to each bone's world
    position via `bone.getWorldPosition()`. These are the click targets.
  - A `pointerdown`/`pointerup` listener on the canvas that measures cursor
    movement between the two events. If movement is below a small threshold
    (a real click, not a camera-orbit drag), a raycast against the joint
    spheres runs; the nearest hit selects that bone — updates the slider
    values (reusing `syncSlidersFromBone`) and highlights the selected
    sphere (color swap), de-highlighting the previous selection.
  - Orbit-drag is unaffected: `OrbitControls` keeps receiving all pointer
    events as it does today; the click/drag disambiguation lives alongside
    it, not instead of it.

`switchModel`, `resetPose`, `captureFrame`, and `destroy` behave the same in
both modes; `destroy()` additionally disposes the joint sphere geometries/
materials and removes the `SkeletonHelper` when `posable` was true.

## Part 2 — Profile panel simplification

In `renderProfileModelViewer(sky)` (`scripts/reclassify-tumblr.mjs`):

- Remove the "Reset pose" button and the implicit bone UI (now never built,
  since `mount()` is called without `posable`).
- Rename "↗ Use as card art" to "Pose & send to card →"; its click handler
  becomes `openPoseDetail(sky)` instead of `useAsCardArt(sky)`.
- Variant switcher buttons stay as-is — quick visual variant browsing is
  still useful on the panel.

## Part 3 — New detail view

**New state:** `let poseDetailChar = null;` (a Skylander name, or `null`).

**Entry point:** `openPoseDetail(sky)` sets `poseDetailChar = sky.name;
render();`.

**`renderGrid()` gating:** checked first, same position as the existing
`mvActive` check:

```js
if (poseDetailChar) {
  main.style.display = 'none';
  mvRoot.style.display = 'none';
  poseDetailRoot.style.display = 'flex';
  renderPoseDetail(poseDetailChar);
  return;
}
```

**`#pose-detail-root`** is a new static container in the HTML template
(siblings with `#mv-root`), hidden by default, containing:

- "← Back to {Character Name}" button — clears `poseDetailChar`, calls
  `render()` (which re-shows the normal grid + profile panel, restoring
  `sel.char` to what it already was — `sel.char` is untouched by entering
  the detail view).
- A large canvas-wrap div (bigger than the profile panel's, full remaining
  viewport height) — this is what gets passed to
  `window.ProfileModelViewer.mount(canvasWrap, models, { posable: true })`.
- The variant switcher (same pattern as the profile panel's).
- "Reset pose" button.
- "Send to NFC" button — same logic as today's `useAsCardArt`
  (`captureFrame()` → sessionStorage → `window.open('/server/skylanders/nfc-card/')`,
  with the existing popup-blocked fallback).

**`renderPoseDetail(charName)`** looks up the Skylander in `SKYLANDERS`,
populates the header/name, and calls `ProfileModelViewer.mount(...)` only
when the character changed since the last render — a new, separate guard
variable `lastPoseDetailChar` (distinct from `renderCharPanel`'s own
`lastPanelChar`), to avoid remounting on unrelated re-renders.

**Lifecycle:** opening the detail view calls `window.ProfileModelViewer?.destroy()`
first if the profile-panel instance was mounted (only one `ProfileModelViewer`
instance exists at a time, per its existing singleton design), then mounts
in `posable: true` mode. The "← Back" button destroys the detail instance,
clears `poseDetailChar` **and resets `lastPanelChar = null`** (so
`renderCharPanel`'s existing `if (sel.char === lastPanelChar) return;` guard
doesn't think nothing changed — without this, the profile panel would stay
on an empty canvas since its viewer was destroyed when the detail view
opened and the guard would otherwise skip remounting it), then calls
`render()`.

## Part 4 — Code placement & publish-build behavior

All of the above (`openPoseDetail`, `renderPoseDetail`, the
`poseDetailChar` state, the `#pose-detail-root` HTML, and its CSS) lives in
the main script and HTML — **not** inside `charProfileJS` — for the same
reason the profile viewer was moved out previously: no server dependency,
must survive `--publish`. New CSS rules follow the existing `.prof-mv-*`
naming convention with a `.pose-detail-*` prefix to avoid collisions.

## Files changed

| File | Change |
|---|---|
| `src/pages/server/skylanders/models/profile-model-viewer.js` | Add `opts.posable` to `mount()`: skeleton overlay, clickable joint spheres, click/drag disambiguation |
| `scripts/reclassify-tumblr.mjs` | Simplify `renderProfileModelViewer`; add `poseDetailChar` state, `openPoseDetail`, `renderPoseDetail`, `#pose-detail-root` HTML + CSS, `renderGrid()` gating |

## Verification

1. Rebuild (`node scripts/reclassify-tumblr.mjs ./skylanders-archive`),
   restart `archive-server.mjs` if needed.
2. Open a character with multiple variants (e.g. Trigger Happy) in the
   archive. Confirm the profile panel shows render + variants only — no
   bone sliders, no "Reset pose".
3. Click "Pose & send to card →" — confirm the detail view takes over the
   full page, shows a bigger viewport with the visible skeleton overlay.
4. Click directly on a joint sphere in the 3D view — confirm it highlights
   and the sliders below update to that bone's current rotation. Drag a
   slider — confirm the model deforms at that joint.
5. Orbit the camera (click-drag on empty space / on the mesh away from any
   joint) — confirm this still orbits and does **not** accidentally select a
   bone.
6. Click "Reset pose" — bind pose restored. Click "← Back" — returns to the
   profile panel with the same character still selected.
7. Re-pose, click "Send to NFC" — same sessionStorage/popup behavior as
   today, verified from the detail view instead of the profile panel.
8. Publish build (`--publish`): confirm the detail view, posing, and NFC
   handoff all still work on the published output (none of this is inside
   `charProfileJS`).
9. As a first real pass at item 1 (bone QA): open several characters'
   models in the detail view and note which skeletons look visibly wrong
   (joints far from the mesh, bunched at origin, or limbs that deform
   incorrectly under rotation) for follow-up triage.
