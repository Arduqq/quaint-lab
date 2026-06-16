# Character Profile 3D Model Viewer

**Date:** 2026-06-16
**Status:** Approved

## Summary

Embed a 3D model viewer on the character profile page in the Skylanders archive. All fuzzy-matched Lost Islands models for the character are shown as switchable variants. The user can orbit, adjust bone poses, and send the posed render directly to the NFC card maker.

## Context

- The archive character profile (`sel.char` view in `skylanders-archive/index.html`) already shows Render, Figures, Ability Icons, Variants sections and a metadata form in `#char-panel`.
- 295 rigged character models exist as `.obj` + `.json` pairs in `models.json` under `TFBModels/Characters/`.
- The existing `model-viewer.js` (Three.js, Lost Islands dashboard) is untouched — a purpose-built `profile-model-viewer.js` is written instead.
- The NFC card maker (`/server/skylanders/nfc-card/`) already has a "custom image" slot; it will gain sessionStorage-based pre-loading.

## Decisions Made

| Question | Decision |
|---|---|
| Layout | Two-column profile: left = sections + gallery, right = `#char-panel` with viewer stacked above metadata form |
| Model linking | Build-time fuzzy match; no field stored in `skylanders.json` |
| Multiple matches | All matches shown as variant switcher buttons inside the viewer |
| NFC handoff | `canvas.toDataURL()` → sessionStorage → `window.open` NFC card (fallback: download PNG) |
| Viewer approach | Purpose-built `profile-model-viewer.js`, same Three.js importmap |

## Part 1 — Data model

### `SKYLANDERS_LIST` enrichment (build-time, `reclassify-tumblr.mjs`)

At build time, load `src/pages/server/skylanders/models/models.json` and filter to entries whose `dir` contains `TFBModels/Characters`. For each character in `SKYLANDERS_LIST`, compute a `models` array by fuzzy-matching:

```js
const norm = s => s.toLowerCase().replace(/[\s_\-]/g, '').replace(/wii$/, '');
const charNorm = norm(c.name);
const matches = charModels.filter(m => {
  const mn = norm(m.name);
  return mn.includes(charNorm) || charNorm.includes(mn);
});
```

Each matched entry is stored as `{ id, name, obj, json, texture }` — the minimum needed by the viewer. Characters with zero matches get `models: []`.

No changes to `skylanders.json` or `manifest.json`.

## Part 2 — New file: `profile-model-viewer.js`

**Path:** `src/pages/server/skylanders/models/profile-model-viewer.js`

Self-contained ES module (~250 lines). Uses the same Three.js importmap as `model-viewer.js`. Exposes `window.ProfileModelViewer`.

### Public API

```js
window.ProfileModelViewer = {
  mount(containerEl, models),  // init canvas + controls inside containerEl; load models[0]
  switchModel(index),          // swap to models[index]
  resetPose(),                 // set all bone rotations to identity
  captureFrame(),              // returns PNG data URL of current frame
  destroy(),                   // dispose renderer, remove canvas, remove listeners
}
```

### Internals

- **Renderer:** `THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })` — `preserveDrawingBuffer` is required for `canvas.toDataURL()` after rendering.
- **Camera/controls:** `PerspectiveCamera(45°)` + `OrbitControls`, auto-framed to model bounding box on load (same `frameObject` logic as existing viewer).
- **Model loading:** JSON path → fetch → `buildCharacterObject(data)` (same bone hierarchy construction as existing viewer, ~50 lines). OBJ fallback for non-rigged models.
- **Material:** `MeshStandardMaterial` with texture from `entry.texture`; texture `flipY = false`, `wrapS/T = RepeatWrapping` (same as existing viewer).
- **Bone pose UI:** Injected `<div>` inside `containerEl` containing a `<select>` for bone index + three `<input type="range" min="-180" max="180">` sliders (X/Y/Z). Updates `bone.rotation` on input. Shown only for rigged JSON models; hidden for OBJ-only models.
- **Resize:** `ResizeObserver` on `containerEl` to keep canvas dimensions in sync.
- **Animation loop:** `requestAnimationFrame` render loop; pauses when `containerEl` is not visible (IntersectionObserver).

### Bone UI layout (injected HTML skeleton)

```
[ canvas (fills containerEl width, fixed aspect 1:1) ]
[ Bone: [select ▾]  X [----|----] Y [----|----] Z [----|----] ]
```

Minimal styling — inherits archive page CSS variables (`--bg3`, `--bd`, `--txt`, `--acc`).

## Part 3 — `reclassify-tumblr.mjs` changes

### 3a — `SKYLANDERS_LIST` enrichment

After the existing `SKYLANDERS_LIST` mapping, load `models.json` and attach fuzzy-matched models to each entry (see Part 1).

### 3c — HTML template

Add `<script type="module" src="/server/skylanders/models/profile-model-viewer.js"></script>` alongside the existing model-viewer script tag (both load on every page; `ProfileModelViewer.mount()` is only called when a character with models is selected).

Add `<div id="prof-model-panel"></div>` as the first child of `#char-panel` in the HTML template. The viewer mounts here; the existing metadata form follows below it.

### 3d — CSS additions

New rules (near existing `.prof-*` block):

```css
/* Profile model viewer panel */
.prof-mv-wrap { margin-bottom: 16px; }
.prof-mv-canvas-wrap { width: 100%; aspect-ratio: 1; background: var(--bg3);
  border-radius: 6px; overflow: hidden; border: 1px solid var(--bd); }
.prof-mv-variants { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.prof-mv-variant { background: rgba(255,255,255,.06); border: 1px solid var(--bd);
  color: var(--muted); font-size: .72rem; padding: 3px 8px; border-radius: 4px;
  cursor: pointer; }
.prof-mv-variant.on { border-color: var(--acc); color: var(--acc);
  background: rgba(79,122,255,.15); }
.prof-mv-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.prof-mv-actions button { background: rgba(255,255,255,.06); color: var(--txt);
  border: 1px solid var(--bd); font-size: .8rem; padding: 4px 10px;
  border-radius: 4px; cursor: pointer; }
.prof-mv-actions button:hover { border-color: rgba(255,204,0,.4); color: var(--gold); }
.prof-mv-card-btn { border-color: rgba(255,204,0,.4) !important; color: var(--gold) !important; }
.prof-mv-card-btn:hover { background: rgba(255,204,0,.1) !important; }
.prof-mv-bone-ui { margin-top: 8px; font-size: .75rem; color: var(--muted); }
.prof-mv-bone-ui select { background: var(--bg3); border: 1px solid var(--bd);
  color: var(--txt); border-radius: 3px; padding: 2px 4px; width: 100%;
  margin-bottom: 5px; }
.prof-mv-bone-ui .bone-row { display: flex; align-items: center; gap: 5px;
  margin-bottom: 3px; }
.prof-mv-bone-ui .bone-row label { width: 12px; color: var(--muted); font-size: .7rem; }
.prof-mv-bone-ui .bone-row input[type=range] { flex: 1; }
.prof-mv-bone-ui .bone-row span { width: 28px; text-align: right; font-size: .7rem; }
.prof-mv-empty { color: var(--muted); font-size: .85rem; padding: 12px 0; }
```

### 3e — `charProfileJS` extension

In the `charProfileJS` block (curation-only), after `renderCharProfile` is called, add `renderProfileModelViewer(lname, sky)`. This function:

1. Reads `sky.models` (array from `SKYLANDERS_LIST`).
2. If empty, renders `.prof-mv-empty` ("No 3D model available for this character.") in `#prof-model-panel` and returns.
3. Otherwise renders:
   - A `.prof-mv-canvas-wrap` div (the `ProfileModelViewer` mounts its canvas here).
   - `.prof-mv-variants` buttons — one per matched model, labelled by `m.name`, first one `.on`. Clicking calls `ProfileModelViewer.switchModel(i)` and updates `.on`.
   - `.prof-mv-actions` with "Reset pose" (→ `ProfileModelViewer.resetPose()`) and "↗ Use as card art" (→ `useAsCardArt(sky)`).
4. Calls `ProfileModelViewer.mount(canvasWrapEl, sky.models)`.
5. Calls `ProfileModelViewer.destroy()` at the top of `renderCharPanel()` before rebuilding — this runs whenever `sel.char` changes or the character is deselected, ensuring the WebGL context and animation loop are cleaned up before the new profile is mounted.

**`useAsCardArt(sky)` function:**

```js
async function useAsCardArt(sky) {
  const dataUrl = ProfileModelViewer.captureFrame();
  try {
    sessionStorage.setItem('nfc-card-custom-art', dataUrl);
    sessionStorage.setItem('nfc-card-char-name', sky.name);
    window.open('/server/skylanders/nfc-card/', '_blank');
  } catch (e) {
    // Fallback: download PNG
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = sky.name.toLowerCase().replace(/\s+/g, '-') + '-pose.png';
    a.click();
  }
}
```

## Part 4 — `nfc-card.njk` changes

On page load (after character list is built), check sessionStorage:

```js
const artData = sessionStorage.getItem('nfc-card-custom-art');
const charName = sessionStorage.getItem('nfc-card-char-name');
sessionStorage.removeItem('nfc-card-custom-art');
sessionStorage.removeItem('nfc-card-char-name');

if (artData && charName) {
  // Pre-select character
  const match = characters.find(c => c.name === charName);
  if (match) selectCharacter(match);
  // Load as custom image (reuse existing custom image path)
  const img = new Image();
  img.onload = () => {
    customImg = img;
    document.getElementById('custom-indicator').style.display = '';
    drawCard();
  };
  img.src = artData;
}
```

This reuses the existing `customImg` / `drawCard()` / `custom-indicator` infrastructure already in the NFC card maker — no new drawing code needed.

## Files changed

| File | Change |
|---|---|
| `src/pages/server/skylanders/models/profile-model-viewer.js` | **New** — purpose-built Three.js mini-viewer |
| `scripts/reclassify-tumblr.mjs` | Fuzzy-match enrichment, HTML template, CSS, `charProfileJS` extension |
| `src/pages/server/skylanders/nfc-card.njk` | sessionStorage pre-load on page init |

## Verification

1. Run `node scripts/reclassify-tumblr.mjs ./skylanders-archive` to rebuild `index.html`.
2. Restart `archive-server.mjs`.
3. Open archive → select Spyro:
   - Right panel shows 3D viewer with variant buttons (SpyroJr_Wii, DarkSpyro_Wii, etc.).
   - Orbit works; switching variant swaps model.
   - Bone sliders appear and deform the mesh.
   - "Reset pose" returns to bind pose.
4. Click "↗ Use as card art":
   - NFC card opens in new tab.
   - Spyro is pre-selected, custom image slot shows the posed render.
   - Fallback: if popup blocked, PNG downloads.
5. Select a character with no models (e.g. a Battlecast-only character) — panel shows "No 3D model available" gracefully.
6. Publish build (`--publish` flag): viewer panel absent (stripped with `charProfileJS`); NFC card sessionStorage load still present.
