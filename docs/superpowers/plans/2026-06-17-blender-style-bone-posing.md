# Blender-Style Bone Posing & Pose Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dropdown-and-sliders bone UI with click-to-select bone
picking in 3D, move posing + the NFC card handoff into a new full-page
per-character detail view, and simplify the small profile-panel viewer down
to a quick render + variant browser.

**Architecture:** `profile-model-viewer.js` gains an `opts.posable` flag on
`mount()` that adds a `THREE.SkeletonHelper` overlay, one clickable joint
sphere per bone, and click/drag disambiguation for bone selection — the
existing X/Y/Z sliders stay as the rotation input, now driven by the
selected joint instead of a `<select>`. `scripts/reclassify-tumblr.mjs` gets
a new `poseDetailChar` full-page state that follows the existing
`mvActive`/`#mv-root` toggle pattern, plus a simplified
`renderProfileModelViewer` whose action button now opens the detail view
instead of capturing card art directly.

**Tech Stack:** Three.js 0.160 (via existing CDN importmap), vanilla DOM/JS,
no build step, no test framework (verification is via Node parse/unit
checks plus manual browser smoke testing — see Global Constraints).

## Global Constraints

- All new code (state, functions, HTML, CSS) lives in the main always-shipped
  script/HTML in `scripts/reclassify-tumblr.mjs` — **never** inside the
  curation-only `charProfileJS` block, which is stripped on `--publish`
  builds. (Spec Part 4.)
- Inside `reclassify-tumblr.mjs`'s browser-facing JS template strings, use
  `+` string concatenation, not template-literal `${}` interpolation — this
  is the file's established convention so Node doesn't try to evaluate
  browser-side syntax at build time.
- Any backslash that must survive into the generated browser JS has to be
  doubled in the `.mjs` source (e.g. write `\\u2192` in the source to get a
  literal `→` in the output, which the browser then resolves to →).
- This project has no test framework (no jest/vitest/mocha — confirmed via
  `package.json` and `node_modules/.bin`). Verification uses: (a) a real,
  fully-executable Node unit test for the one piece of pure logic
  (`isClick`), (b) Node `--check`-style parse verification for the
  WebGL-dependent file (it can't run for real outside a browser since
  `three` isn't an installed npm package), and (c) manual browser
  smoke-testing instructions. Do not invent a test framework for this plan.
- Do not modify `src/pages/server/skylanders/models/model-viewer.js` (the
  separate Lost Islands dashboard viewer) — out of scope per spec.
- New CSS follows the existing `.prof-mv-*` naming convention; view-specific
  rules use a `.pose-detail-*` prefix to avoid collisions.

---

## Task 1: `profile-model-viewer.js` — posable mount option

**Files:**
- Create: `src/pages/server/skylanders/models/pose-utils.js`
- Modify: `src/pages/server/skylanders/models/profile-model-viewer.js` (full rewrite of its bone-UI/scene-management internals; public API surface unchanged)

**Interfaces:**
- Consumes: nothing from other tasks (this is the foundation task).
- Produces: `window.ProfileModelViewer.mount(containerEl, models, opts = {})`
  where `opts.posable` (boolean, default `false`) and `opts.boneUiHost`
  (Element, default `containerEl.parentElement || containerEl`) are new.
  `switchModel(index)`, `resetPose()`, `captureFrame()`, `destroy()` keep
  their existing signatures. Task 2 and Task 3 call `mount()` with these new
  options.

- [ ] **Step 1: Write the failing test for the click/drag disambiguation logic**

Create `/tmp/test-pose-utils.mjs`:

```js
import assert from 'node:assert';
import { isClick } from '/Users/cais_solomonik/Documents/repositories/quaint-lab/src/pages/server/skylanders/models/pose-utils.js';

assert.strictEqual(isClick(100, 100, 100, 100), true, 'no movement is a click');
assert.strictEqual(isClick(100, 100, 103, 102), true, 'small movement (~3.6px) is a click');
assert.strictEqual(isClick(100, 100, 110, 100), false, '10px horizontal movement is a drag');
assert.strictEqual(isClick(100, 100, 100, 200), false, '100px vertical movement is a drag');
assert.strictEqual(isClick(100, 100, 106, 100, 10), true, 'custom threshold of 10px allows 6px movement');
console.log('All isClick tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node /tmp/test-pose-utils.mjs`
Expected: FAIL with
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../pose-utils.js' imported from /tmp/test-pose-utils.mjs
```
(the file doesn't exist yet)

- [ ] **Step 3: Create `pose-utils.js`**

```js
// Pure and dependency-free (no `three` import) so it can be unit-tested
// directly in Node without mocking imports the rest of the viewer needs.
export function isClick(downX, downY, upX, upY, threshold = 6) {
  const dx = upX - downX;
  const dy = upY - downY;
  return Math.sqrt(dx * dx + dy * dy) <= threshold;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node /tmp/test-pose-utils.mjs`
Expected: PASS — prints `All isClick tests passed.`

Clean up: `rm /tmp/test-pose-utils.mjs` (throwaway, not committed).

- [ ] **Step 5: Commit**

```bash
git add src/pages/server/skylanders/models/pose-utils.js
git commit -m "feat: add isClick helper for bone-picking click/drag disambiguation"
```

- [ ] **Step 6: Rewrite `profile-model-viewer.js` with the posable mount option**

Replace the full file content with:

```js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { isClick } from './pose-utils.js';

// Single active viewer state — only one ProfileModelViewer instance exists
// at a time (the small profile panel and the pose detail view never mount
// simultaneously; opening one always destroys the other first).
let _s = null;

function buildCharacterObject(data) {
  const boneDefs = data.bones;
  const bones = boneDefs.map(() => new THREE.Bone());
  boneDefs.forEach((b, i) => {
    bones[i].position.set(b.translation[0], b.translation[1], b.translation[2]);
    bones[i].name = 'bone' + i;
  });
  const roots = [];
  boneDefs.forEach((b, i) => {
    if (b.parent >= 0 && bones[b.parent]) bones[b.parent].add(bones[i]);
    else roots.push(bones[i]);
  });
  const skeleton = new THREE.Skeleton(bones);
  const group = new THREE.Group();
  for (const root of roots) group.add(root);
  group.updateMatrixWorld(true);
  skeleton.calculateInverses();
  const meshes = [];
  for (const m of data.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',   new THREE.Float32BufferAttribute(m.positions, 3));
    if (m.uvs)     geo.setAttribute('uv',        new THREE.Float32BufferAttribute(m.uvs, 2));
    if (m.normals) geo.setAttribute('normal',    new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('skinIndex',  new THREE.Uint16BufferAttribute(m.skinIndices, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(m.skinWeights, 4));
    geo.setIndex(m.indices);
    if (!m.normals) geo.computeVertexNormals();
    const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    group.add(mesh);
    mesh.bind(skeleton, new THREE.Matrix4());
    meshes.push(mesh);
  }
  return { group, skeleton, bones, meshes, boneDefs };
}

function applyMaterial(root, texturePath, textureLoader) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.9 });
  if (texturePath) {
    const tex = textureLoader.load(texturePath);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    mat.map = tex;
  }
  root.traverse(child => {
    if (child.isMesh) { const m = mat.clone(); if (mat.map) m.map = mat.map; child.material = m; }
  });
  mat.dispose();
}

function frameObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);
  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const fitDist = maxDim / (2 * Math.tan((Math.PI * _s.camera.fov) / 360));
  _s.controls.target.copy(center);
  _s.camera.position.copy(center).add(
    new THREE.Vector3(1, 0.8, 1).normalize().multiplyScalar(fitDist * 1.6)
  );
  _s.camera.near = maxDim / 1000;
  _s.camera.far  = maxDim * 1000;
  _s.camera.updateProjectionMatrix();
  _s.controls.update();
}

// ── Posable-mode bone UI: sliders only — bone selection now comes from
// clicking a joint sphere in 3D, not a dropdown. ───────────────────────────
function buildBoneUi(hostEl) {
  const div = document.createElement('div');
  div.className = 'prof-mv-bone-ui';
  div.innerHTML =
    '<div id="pmv-bone-label">Click a joint to select it</div>' +
    ['X', 'Y', 'Z'].map(ax =>
      '<div class="bone-row">' +
        '<label>' + ax + '</label>' +
        '<input type="range" id="pmv-bone-' + ax.toLowerCase() + '" min="-180" max="180" value="0" step="1">' +
        '<span id="pmv-bone-' + ax.toLowerCase() + '-val">0</span>' +
      '</div>'
    ).join('');
  hostEl.appendChild(div);
  return div;
}

function syncSlidersFromBone() {
  if (!_s?.charBuild || _s.selectedBoneIdx == null) return;
  const bone = _s.charBuild.skeleton.bones[_s.selectedBoneIdx];
  if (!bone) return;
  ['x', 'y', 'z'].forEach(ax => {
    const deg = Math.round(THREE.MathUtils.radToDeg(bone.rotation[ax]));
    const inp = document.getElementById('pmv-bone-' + ax);
    const spn = document.getElementById('pmv-bone-' + ax + '-val');
    if (inp) inp.value = deg;
    if (spn) spn.textContent = deg;
  });
}

function onBoneRotChange() {
  if (!_s?.charBuild || _s.selectedBoneIdx == null) return;
  const bone = _s.charBuild.skeleton.bones[_s.selectedBoneIdx];
  if (!bone) return;
  ['x', 'y', 'z'].forEach(ax => {
    const inp = document.getElementById('pmv-bone-' + ax);
    const spn = document.getElementById('pmv-bone-' + ax + '-val');
    if (!inp) return;
    bone.rotation[ax] = THREE.MathUtils.degToRad(+inp.value);
    if (spn) spn.textContent = inp.value;
  });
}

// Selects bone `idx`: updates the label, syncs sliders to its current
// rotation, and highlights the matching joint sphere.
function selectBone(idx) {
  if (!_s) return;
  _s.selectedBoneIdx = idx;
  const label = document.getElementById('pmv-bone-label');
  if (label) label.textContent = 'Selected: bone ' + idx;
  syncSlidersFromBone();
  (_s.jointMeshes || []).forEach((mesh, i) => {
    mesh.material.color.set(i === idx ? 0x00ff88 : 0xffcc00);
  });
}

// ── Skeleton overlay + clickable joints (posable mode only) ────────────────
function buildJointMeshes(build) {
  const box = new THREE.Box3().setFromObject(build.group);
  const size = new THREE.Vector3();
  box.getSize(size);
  const radius = Math.max(size.x, size.y, size.z, 1e-6) * 0.025;
  const geo = new THREE.SphereGeometry(radius, 12, 8);
  return build.skeleton.bones.map(() => {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcc00, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 999;
    return mesh;
  });
}

function onPointerDown(e) {
  if (!_s) return;
  _s.pointerDown = { x: e.clientX, y: e.clientY };
}

function onPointerUp(e) {
  if (!_s || !_s.pointerDown) return;
  const down = _s.pointerDown;
  _s.pointerDown = null;
  if (!isClick(down.x, down.y, e.clientX, e.clientY)) return; // camera-orbit drag, not a selection click

  const rect = _s.renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, _s.camera);
  const hits = raycaster.intersectObjects(_s.jointMeshes || []);
  if (hits.length) {
    const idx = _s.jointMeshes.indexOf(hits[0].object);
    if (idx !== -1) selectBone(idx);
  }
}

function clearScene() {
  if (!_s?.charBuild) return;
  _s.scene.remove(_s.charBuild.group);
  _s.charBuild.meshes.forEach(m => {
    m.material.map?.dispose();
    m.geometry.dispose();
    m.material.dispose?.();
  });
  _s.charBuild.skeleton.dispose();
  _s.charBuild = null;

  if (_s.skeletonHelper) {
    _s.scene.remove(_s.skeletonHelper);
    _s.skeletonHelper.geometry.dispose();
    _s.skeletonHelper.material.dispose();
    _s.skeletonHelper = null;
  }
  if (_s.jointGroup) {
    _s.jointGroup.children.forEach(m => m.material.dispose());
    _s.jointGroup.children[0]?.geometry.dispose();
    _s.scene.remove(_s.jointGroup);
    _s.jointGroup = null;
    _s.jointMeshes = null;
  }
  _s.selectedBoneIdx = null;
}

async function loadIntoScene(entry) {
  const s = _s;
  clearScene();
  const res = await fetch(entry.json);
  if (!_s || _s !== s) return;
  if (!res.ok) throw new Error('Failed to load model: ' + res.status + ' ' + entry.json);
  const data = await res.json();
  if (!_s || _s !== s) return;
  const build = buildCharacterObject(data);
  applyMaterial(build.group, entry.texture, s.textureLoader);
  s.scene.add(build.group);
  s.charBuild = build;
  frameObject(build.group);

  if (s.posable) {
    const skeletonHelper = new THREE.SkeletonHelper(build.group);
    s.scene.add(skeletonHelper);
    s.skeletonHelper = skeletonHelper;

    const jointMeshes = buildJointMeshes(build);
    const jointGroup = new THREE.Group();
    jointMeshes.forEach(m => jointGroup.add(m));
    s.scene.add(jointGroup);
    s.jointGroup = jointGroup;
    s.jointMeshes = jointMeshes;

    selectBone(0);
  }
}

window.ProfileModelViewer = {
  // containerEl is the .prof-mv-canvas-wrap div the caller creates; the
  // canvas is appended directly to it. opts.posable (default false) enables
  // the skeleton overlay, clickable joint spheres, and the bone-rotation
  // slider UI — appended to opts.boneUiHost (defaults to containerEl's
  // parent) so callers can place it wherever fits their layout.
  async mount(containerEl, models, opts = {}) {
    const posable    = !!opts.posable;
    const boneUiHost = opts.boneUiHost || containerEl.parentElement || containerEl;
    const w      = containerEl.clientWidth || 280;
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x111116);

    const camera   = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(w, w);
    containerEl.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(1, 2, 2);
    scene.add(dir);

    const textureLoader = new THREE.TextureLoader();

    _s = { containerEl, models, currentIdx: 0, scene, camera, renderer, controls, posable,
           charBuild: null, textureLoader, boneUiEl: null, rafId: null, ro: null, io: null, visible: true,
           skeletonHelper: null, jointGroup: null, jointMeshes: null, selectedBoneIdx: null, pointerDown: null };

    const boneAc = new AbortController();
    _s.boneAc = boneAc;

    if (posable) {
      const boneUiEl = buildBoneUi(boneUiHost);
      _s.boneUiEl = boneUiEl;

      ['x', 'y', 'z'].forEach(ax =>
        document.getElementById('pmv-bone-' + ax)?.addEventListener('input', onBoneRotChange, { signal: boneAc.signal })
      );
      renderer.domElement.addEventListener('pointerdown', onPointerDown, { signal: boneAc.signal });
      renderer.domElement.addEventListener('pointerup', onPointerUp, { signal: boneAc.signal });
    }

    const tmpVec = new THREE.Vector3();
    function loop() {
      if (!_s) return;
      _s.rafId = requestAnimationFrame(loop);
      if (!_s.visible) return;
      controls.update();
      if (_s.jointMeshes && _s.charBuild) {
        _s.charBuild.skeleton.bones.forEach((bone, i) => {
          bone.getWorldPosition(tmpVec);
          _s.jointMeshes[i].position.copy(tmpVec);
        });
      }
      renderer.render(scene, camera);
    }
    loop();

    const ro = new ResizeObserver(() => {
      const sz = containerEl.clientWidth;
      renderer.setSize(sz, sz);
      camera.updateProjectionMatrix();
    });
    ro.observe(containerEl);
    _s.ro = ro;

    const io = new IntersectionObserver(entries => { _s.visible = entries[0].isIntersecting; });
    io.observe(containerEl);
    _s.io = io;

    if (models.length) await loadIntoScene(models[0]);
  },

  async switchModel(index) {
    if (!_s || index < 0 || index >= _s.models.length) return;
    _s.currentIdx = index;
    await loadIntoScene(_s.models[index]);
  },

  resetPose() {
    if (!_s?.charBuild) return;
    _s.charBuild.skeleton.bones.forEach(b => b.rotation.set(0, 0, 0));
    syncSlidersFromBone();
  },

  captureFrame() {
    if (!_s) return null;
    _s.renderer.render(_s.scene, _s.camera);
    return _s.renderer.domElement.toDataURL('image/png');
  },

  destroy() {
    if (!_s) return;
    cancelAnimationFrame(_s.rafId);
    _s.boneAc?.abort();
    _s.ro?.disconnect();
    _s.io?.disconnect();
    clearScene();
    _s.renderer.dispose();
    _s.renderer.domElement.remove();
    _s.boneUiEl?.remove();
    _s = null;
  },
};
```

- [ ] **Step 7: Parse-check the rewritten file**

`three` is a CDN-only import (not an installed npm package), so this file
can't actually execute under plain Node — but a parse failure (bad syntax)
and a resolution failure (missing package) produce distinguishably
different errors, which is enough to prove the rewrite has no syntax
mistakes.

Run:
```bash
node --input-type=module -e "$(cat src/pages/server/skylanders/models/profile-model-viewer.js)"
```
Expected: a *resolution* error, not a *syntax* error —
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'three' imported from ...
```
If instead you see `SyntaxError`, fix the file before continuing.

- [ ] **Step 8: Manual browser smoke test**

1. Run `node scripts/reclassify-tumblr.mjs ./skylanders-archive` to regenerate the curation HTML.
2. Start/confirm `node scripts/archive-server.mjs` is running, open the curation UI in a browser.
3. Open any character with a 3D model. The small profile-panel viewer should render exactly as before (no behavior change yet — `renderProfileModelViewer` still calls `mount()` without `opts`, so `posable` defaults `false` and nothing new shows).
4. Open the browser console and run:
   ```js
   window.ProfileModelViewer.destroy();
   const host = document.getElementById('prof-model-panel');
   const wrap = document.createElement('div'); wrap.className = 'prof-mv-canvas-wrap'; wrap.style.width = '400px'; wrap.style.height='400px';
   host.appendChild(wrap);
   window.ProfileModelViewer.mount(wrap, window.SKYLANDERS_LIST.find(s => s.models?.length).models, { posable: true, boneUiHost: host });
   ```
5. Confirm: white skeleton line-overlay appears on the model; small yellow spheres appear at each joint; clicking a sphere turns it green and updates the X/Y/Z sliders below to that bone's rotation; dragging a slider visibly bends the model at that joint; click-dragging on empty space still orbits the camera without selecting a bone.
6. Reload the page afterward to discard this manual test's DOM changes (nothing was persisted).

- [ ] **Step 9: Commit**

```bash
git add src/pages/server/skylanders/models/profile-model-viewer.js
git commit -m "feat: add posable mode to profile-model-viewer (skeleton overlay + clickable joints)"
```

---

## Task 2: New pose detail view (state, HTML, CSS, render functions)

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs`
  - CSS block, after `scripts/reclassify-tumblr.mjs:1547` (`.prof-mv-empty{...}`)
  - HTML, after `scripts/reclassify-tumblr.mjs:1841` (`#mv-root`'s closing `</div>`)
  - State, after `scripts/reclassify-tumblr.mjs:1912` (`let mvActive = false;`)
  - `renderGrid()`, `scripts/reclassify-tumblr.mjs:2627-2639`
  - `renderCharPanel()`, `scripts/reclassify-tumblr.mjs:2719-2722`
  - New functions, after `renderProfileModelViewer` / before `function render()` at `scripts/reclassify-tumblr.mjs:2921`

**Interfaces:**
- Consumes: `window.ProfileModelViewer.mount(containerEl, models, { posable, boneUiHost })`, `.resetPose()`, `.destroy()` (Task 1). `useAsCardArt(sky)`, `SKYLANDERS`, `escAttr`, `render()` (all pre-existing in this file).
- Produces: `let poseDetailChar`, `function openPoseDetail(sky)` — Task 3's button calls this instead of `useAsCardArt(sky)`.

- [ ] **Step 1: Add the new CSS block**

In `scripts/reclassify-tumblr.mjs`, find this line (around 1547):

```js
.prof-mv-empty{color:var(--muted);font-size:.85rem;padding:12px 0}
```

Add immediately after it (before the `/* Image picker modal */` comment):

```js
.prof-mv-empty{color:var(--muted);font-size:.85rem;padding:12px 0}
/* Pose detail view (full-page bone posing) ──────────────────────────────── */
#pose-detail-root{display:none;height:100%;min-height:0;flex-direction:column}
.pose-detail-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 14px;
  border-bottom:1px solid var(--bd);background:var(--bg2)}
.pose-detail-back{flex-shrink:0;padding:4px 10px;background:rgba(255,204,0,.07);
  border:1.5px solid rgba(255,204,0,.22);color:var(--muted);border-radius:4px;cursor:pointer;
  font-size:.72rem;font-family:inherit;transition:all .12s}
.pose-detail-back:hover{background:rgba(255,204,0,.17);border-color:rgba(255,204,0,.5);color:var(--gold)}
.pose-detail-body{flex:1;display:flex;min-height:0}
.pose-detail-canvas-host{flex:1;min-width:0;background:var(--bg3)}
.pose-detail-canvas-host .prof-mv-canvas-wrap{width:100%;height:100%;aspect-ratio:auto;border-radius:0;border:none}
.pose-detail-side{flex-shrink:0;width:260px;border-left:1px solid var(--bd);
  background:var(--bg2);padding:14px;overflow-y:auto;box-sizing:border-box}
.pose-detail-side .prof-mv-variants{margin-bottom:14px}
.pose-detail-side .prof-mv-actions{flex-direction:column}
.pose-detail-side .prof-mv-actions button{width:100%}
```

- [ ] **Step 2: Add the `#pose-detail-root` HTML container**

Find (around line 1841-1842):

```js
  </div>
  <aside id="char-panel"></aside>
</div>
```

Change to:

```js
  </div>
  <div id="pose-detail-root"></div>
  <aside id="char-panel"></aside>
</div>
```

- [ ] **Step 3: Add the new state variables**

Find (around line 1912):

```js
let mvActive = false;
```

Change to:

```js
let mvActive = false;
let poseDetailChar = null;     // Skylander name, or null — full-page bone-posing detail view
let lastPoseDetailChar = null; // tracks which character renderPoseDetail last built for (distinct from lastPanelChar)
```

- [ ] **Step 4: Gate `renderGrid()` on `poseDetailChar`**

Find (around line 2627-2639):

```js
function renderGrid() {
  const main = document.getElementById('main');
  const mvRoot = document.getElementById('mv-root');

  if (mvActive) {
```

Change to:

```js
function renderGrid() {
  const main = document.getElementById('main');
  const mvRoot = document.getElementById('mv-root');
  const poseDetailRoot = document.getElementById('pose-detail-root');

  if (poseDetailChar) {
    // #layout is a CSS grid (`var(--sb) 1fr` / `var(--sb) 1fr var(--cp)` via
    // .has-panel) — display:none fully removes an item from grid flow, but
    // renderCharPanel() (called right after this inside render()) early-
    // returns while poseDetailChar is set and never touches has-panel
    // itself, so it has to be cleared here or the stale #char-panel column
    // would keep reserving width next to the detail view.
    document.getElementById('layout').classList.remove('has-panel');
    main.style.display = 'none';
    mvRoot.style.display = 'none';
    poseDetailRoot.style.display = 'flex';
    renderPoseDetail(poseDetailChar);
    return;
  }
  poseDetailRoot.style.display = 'none';

  if (mvActive) {
```

- [ ] **Step 5: Guard `renderCharPanel()` while the detail view is open**

Find (around line 2719-2722):

```js
function renderCharPanel() {
  const panel  = document.getElementById('char-panel');
  const layout = document.getElementById('layout');

  if (!sel.char) {
```

Change to:

```js
function renderCharPanel() {
  const panel  = document.getElementById('char-panel');
  const layout = document.getElementById('layout');

  if (poseDetailChar) return; // detail view owns ProfileModelViewer's single instance while open

  if (!sel.char) {
```

(Without this guard, `render()` would also rebuild the small panel's
viewer while the detail view is open, and since `ProfileModelViewer` is a
singleton, the second `mount()` call would silently steal `_s` out from
under whichever viewer mounted first.)

- [ ] **Step 6: Add `openPoseDetail`, `closePoseDetail`, `renderPoseDetail`**

Find (around line 2919-2921):

```js
  panel.appendChild(wrap);
  window.ProfileModelViewer?.mount(canvasWrap, models);
}

function render() { renderSidebar(); renderGrid(); renderCharPanel(); if (tagModeOn) refreshTagOverlays(); }
```

Change to:

```js
  panel.appendChild(wrap);
  window.ProfileModelViewer?.mount(canvasWrap, models);
}

function openPoseDetail(sky) {
  poseDetailChar = sky.name;
  render();
}

function closePoseDetail() {
  window.ProfileModelViewer?.destroy();
  poseDetailChar = null;
  lastPoseDetailChar = null;
  lastPanelChar = null; // forces renderCharPanel to remount the small viewer it destroyed
  render();
}

function renderPoseDetail(charName) {
  const root = document.getElementById('pose-detail-root');
  if (charName === lastPoseDetailChar) return;
  window.ProfileModelViewer?.destroy();
  lastPoseDetailChar = charName;

  const sky = SKYLANDERS.find(s => s.name === charName);
  const models = sky?.models || [];

  root.innerHTML = '<div class="pose-detail-toolbar">'
    + '<button class="pose-detail-back" type="button">\\u2039 Back to ' + escAttr(charName) + '</button>'
    + '</div>'
    + '<div class="pose-detail-body">'
      + '<div class="pose-detail-canvas-host"></div>'
      + '<div class="pose-detail-side"></div>'
    + '</div>';

  root.querySelector('.pose-detail-back').addEventListener('click', closePoseDetail);

  const canvasHost = root.querySelector('.pose-detail-canvas-host');
  const sideEl     = root.querySelector('.pose-detail-side');

  if (!models.length) {
    canvasHost.innerHTML = '<div class="prof-mv-empty">No 3D model available for this character.</div>';
    return;
  }

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'prof-mv-canvas-wrap';
  canvasHost.appendChild(canvasWrap);

  if (models.length > 1) {
    const variantsEl = document.createElement('div'); variantsEl.className = 'prof-mv-variants';
    models.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'prof-mv-variant' + (i === 0 ? ' on' : '');
      btn.textContent = m.name;
      btn.addEventListener('click', () => {
        variantsEl.querySelectorAll('.prof-mv-variant').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        window.ProfileModelViewer?.switchModel(i);
      });
      variantsEl.appendChild(btn);
    });
    sideEl.appendChild(variantsEl);
  }

  const actions = document.createElement('div'); actions.className = 'prof-mv-actions';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset pose';
  resetBtn.addEventListener('click', () => window.ProfileModelViewer?.resetPose());
  actions.appendChild(resetBtn);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'prof-mv-card-btn';
  sendBtn.textContent = '\\u2197 Send to NFC';
  sendBtn.addEventListener('click', () => useAsCardArt(sky));
  actions.appendChild(sendBtn);
  sideEl.appendChild(actions);

  window.ProfileModelViewer?.mount(canvasWrap, models, { posable: true, boneUiHost: sideEl });
}

function render() { renderSidebar(); renderGrid(); renderCharPanel(); if (tagModeOn) refreshTagOverlays(); }
```

- [ ] **Step 7: Manual browser smoke test (detail view, triggered directly)**

`openPoseDetail` has no caller yet (that's Task 3) — trigger the new view
directly via devtools console to verify it independently:

1. Run `node scripts/reclassify-tumblr.mjs ./skylanders-archive`, restart `archive-server.mjs` if it adds/removes files (or just run `npm run publish-archive` which does both automatically).
2. Open the curation UI, select any character with a model in the sidebar (so `SKYLANDERS` / `sel.char` are populated).
3. Open the browser console and run:
   ```js
   poseDetailChar = sel.char.charAt(0).toUpperCase() + sel.char.slice(1);
   render();
   ```
   (Chrome/Firefox devtools consoles evaluate against the page's top-level
   script scope, so module-less top-level `let` bindings like
   `poseDetailChar` are visible and assignable here — the same scope
   `sel`/`mvActive` already live in.)
4. Confirm: the whole page switches to a full-page view — a toolbar with a "‹ Back to {Name}" button (no `#char-panel` column visible alongside it — the grid should be back to 2 columns), a large canvas on the left with the visible white skeleton overlay and yellow joint spheres, and a side panel on the right with variant buttons (if more than one model), "Reset pose", and "Send to NFC".
5. Click a joint sphere — it turns green, the sliders update. Drag a slider — the model bends at that joint. Click-drag on empty canvas space — camera orbits, no bone gets selected.
6. Click "‹ Back to {Name}" — page returns to the normal grid/profile panel view (3-column grid restored). In the console, confirm `lastPanelChar` is `null` and `poseDetailChar` is `null`.
7. Re-select the same character from the sidebar — confirm the small profile panel's viewer remounts correctly (canvas is not blank).

- [ ] **Step 8: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: add full-page pose detail view (poseDetailChar state, renderPoseDetail)"
```

---

## Task 3: Simplify the profile panel and wire it to the detail view

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:2875-2919` (`renderProfileModelViewer`)

**Interfaces:**
- Consumes: `window.ProfileModelViewer.mount(containerEl, models)` (Task 1, called *without* `opts` — defaults to non-posable), `openPoseDetail(sky)` (Task 2).
- Produces: nothing new — this is the final user-facing wiring.

- [ ] **Step 1: Replace `renderProfileModelViewer`**

Find (around line 2875-2919):

```js
function renderProfileModelViewer(sky) {
  const panel = document.getElementById('prof-model-panel');
  if (!panel) return;
  const models = sky?.models || [];
  if (!models.length) {
    panel.innerHTML = '<div class="prof-mv-empty">No 3D model available for this character.</div>';
    return;
  }
  const wrap = document.createElement('div'); wrap.className = 'prof-mv-wrap';

  const canvasWrap = document.createElement('div'); canvasWrap.className = 'prof-mv-canvas-wrap';
  wrap.appendChild(canvasWrap);

  if (models.length > 1) {
    const variantsEl = document.createElement('div'); variantsEl.className = 'prof-mv-variants';
    models.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'prof-mv-variant' + (i === 0 ? ' on' : '');
      btn.textContent = m.name;
      btn.addEventListener('click', () => {
        variantsEl.querySelectorAll('.prof-mv-variant').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        window.ProfileModelViewer?.switchModel(i);
      });
      variantsEl.appendChild(btn);
    });
    wrap.appendChild(variantsEl);
  }

  const actions = document.createElement('div'); actions.className = 'prof-mv-actions';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset pose';
  resetBtn.addEventListener('click', () => window.ProfileModelViewer?.resetPose());
  actions.appendChild(resetBtn);

  const cardBtn = document.createElement('button');
  cardBtn.className = 'prof-mv-card-btn';
  cardBtn.textContent = '\\u2197 Use as card art';
  cardBtn.addEventListener('click', () => useAsCardArt(sky));
  actions.appendChild(cardBtn);
  wrap.appendChild(actions);

  panel.appendChild(wrap);
  window.ProfileModelViewer?.mount(canvasWrap, models);
}
```

Replace with:

```js
function renderProfileModelViewer(sky) {
  const panel = document.getElementById('prof-model-panel');
  if (!panel) return;
  const models = sky?.models || [];
  if (!models.length) {
    panel.innerHTML = '<div class="prof-mv-empty">No 3D model available for this character.</div>';
    return;
  }
  const wrap = document.createElement('div'); wrap.className = 'prof-mv-wrap';

  const canvasWrap = document.createElement('div'); canvasWrap.className = 'prof-mv-canvas-wrap';
  wrap.appendChild(canvasWrap);

  if (models.length > 1) {
    const variantsEl = document.createElement('div'); variantsEl.className = 'prof-mv-variants';
    models.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'prof-mv-variant' + (i === 0 ? ' on' : '');
      btn.textContent = m.name;
      btn.addEventListener('click', () => {
        variantsEl.querySelectorAll('.prof-mv-variant').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        window.ProfileModelViewer?.switchModel(i);
      });
      variantsEl.appendChild(btn);
    });
    wrap.appendChild(variantsEl);
  }

  const actions = document.createElement('div'); actions.className = 'prof-mv-actions';
  const poseBtn = document.createElement('button');
  poseBtn.className = 'prof-mv-card-btn';
  poseBtn.textContent = 'Pose & send to card \\u2192';
  poseBtn.addEventListener('click', () => openPoseDetail(sky));
  actions.appendChild(poseBtn);
  wrap.appendChild(actions);

  panel.appendChild(wrap);
  window.ProfileModelViewer?.mount(canvasWrap, models);
}
```

- [ ] **Step 2: Manual browser smoke test (full end-to-end flow)**

1. Run `npm run publish-archive` (rebuilds and restarts the dev server only if needed).
2. Open the curation UI, select a character with multiple model variants (e.g. Trigger Happy). Confirm the profile panel shows only: the canvas, variant buttons, and a single "Pose & send to card →" button — no "Reset pose" button, no sliders, no skeleton overlay.
3. Click "Pose & send to card →" — confirm the full-page detail view opens for the same character, with a bigger viewport, visible skeleton overlay, and joint spheres.
4. Click a joint sphere — confirm it highlights and the sliders update to that bone's rotation. Drag a slider — confirm the model deforms at that joint.
5. Orbit the camera (drag on empty space, or on the mesh away from any joint) — confirm it orbits and does **not** select a bone.
6. Click "Reset pose" — bind pose restored. Click "‹ Back to {Name}" — returns to the profile panel with the same character still selected and its small viewer correctly remounted (not blank).
7. Re-pose, click "Send to NFC" — confirm `sessionStorage` gets `nfc-card-custom-art` / `nfc-card-char-name` set (DevTools → Application → Session Storage) and a new tab opens to `/server/skylanders/nfc-card/` showing the posed render.
8. Run `node scripts/reclassify-tumblr.mjs ./skylanders-archive --publish`. Open the published `src/pages/server/skylanders/archive/index.html` (or run `npm start` and visit `/server/skylanders/archive/`) and repeat steps 2-7 — confirm everything still works, since none of this lives inside the curation-only `charProfileJS` block.

- [ ] **Step 3: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: simplify profile panel viewer and wire it into the pose detail view"
```

---

## Final Verification (manual, after all tasks)

This matches the spec's own verification item 9 — it's the actual point of
building the skeleton-overlay tool, not a coded deliverable:

- [ ] Open several different characters' models in the new detail view (a
  mix of mainline and spin-off games) and note which skeletons look
  visibly wrong — joints far from the mesh surface, all joints bunched at
  the origin, or limbs that deform incorrectly when a nearby bone is
  rotated. This is the first real bone-rigging triage pass; file follow-up
  fixes separately, it's out of scope for this plan to fix individual
  models' rigging data.
