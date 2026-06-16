# Character Profile 3D Model Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed a purpose-built Three.js viewer in the character profile right panel, showing all fuzzy-matched Lost Islands models as switchable variants with bone pose controls, and a "Use as card art" button that snapshots the canvas into the NFC card maker via sessionStorage.

**Architecture:** Four independent tasks — (1) build-time model matching added to `SKYLANDERS_LIST`; (2) new self-contained `profile-model-viewer.js` ES module; (3) wire the viewer into the archive profile page (CSS, HTML, `renderCharPanel`, `charProfileJS`); (4) sessionStorage pre-load in the NFC card maker. Tasks 2 and 3 depend on task 1 completing first; task 4 is independent of 1–3.

**Tech Stack:** Node.js (build script), Three.js 0.160 (same importmap as existing `model-viewer.js`), vanilla JS, CSS custom properties already defined in the archive page.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `scripts/reclassify-tumblr.mjs` | Modify | Add model matching to `SKYLANDERS_LIST`; add CSS, script tag, `#prof-model-panel`, `renderCharPanel` changes, `charProfileJS` extension |
| `src/pages/server/skylanders/models/profile-model-viewer.js` | **Create** | Self-contained Three.js mini-viewer — `mount`, `switchModel`, `resetPose`, `captureFrame`, `destroy` |
| `src/pages/server/skylanders/nfc-card.njk` | Modify | Read sessionStorage on init, pre-select character, load snapshot as custom art |

---

## Task 1 — Build-time model matching

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:36-56` (after `SKYLANDERS_LIST` definition)

This runs in Node.js at build time. Load `models.json`, filter to character models, and fuzzy-match each character. The result is embedded in the client-side `SKYLANDERS` constant.

- [ ] **Step 1: Add model loading and matching after the `SKYLANDERS_LIST` block**

Find the line `  : [];` that ends the `SKYLANDERS_LIST` definition (currently line 56). Insert the following block immediately after it:

```js
// Load Lost Islands character models for fuzzy-matching into profile viewer
const _modelsJsonPath = join(__dir, '../src/pages/server/skylanders/models/models.json');
const _charModels = existsSync(_modelsJsonPath)
  ? JSON.parse(readFileSync(_modelsJsonPath, 'utf8'))
      .filter(m => m.dir && m.dir.includes('TFBModels/Characters'))
  : [];
{
  const normName = s => s.toLowerCase().replace(/[\s_\-]/g, '').replace(/wii$/, '');
  for (const c of SKYLANDERS_LIST) {
    const cn = normName(c.name);
    c.models = _charModels
      .filter(m => { const mn = normName(m.name); return mn.includes(cn) || cn.includes(mn); })
      .map(({ id, name, obj, json, texture }) => ({ id, name, obj, json, texture }));
  }
}
```

- [ ] **Step 2: Verify the enrichment at the command line**

```bash
node --input-type=module <<'EOF'
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dir = dirname(fileURLToPath(import.meta.url));

const sky = JSON.parse(readFileSync('src/_data/skylanders.json','utf8'));
const SKYLANDERS_LIST = sky.flatMap(g => g.characters.map(c => ({ name: c.name })));

const _modelsJsonPath = 'src/pages/server/skylanders/models/models.json';
const _charModels = JSON.parse(readFileSync(_modelsJsonPath,'utf8'))
  .filter(m => m.dir && m.dir.includes('TFBModels/Characters'));

const normName = s => s.toLowerCase().replace(/[\s_\-]/g,'').replace(/wii$/,'');
for (const c of SKYLANDERS_LIST) {
  const cn = normName(c.name);
  c.models = _charModels.filter(m => { const mn = normName(m.name); return mn.includes(cn) || cn.includes(mn); });
}

const withModels = SKYLANDERS_LIST.filter(c => c.models.length > 0);
console.log('Characters with models:', withModels.length, '/', SKYLANDERS_LIST.length);
const spyro = SKYLANDERS_LIST.find(c => c.name === 'Trigger Happy');
console.log('Trigger Happy models:', spyro?.models.map(m => m.name));
EOF
```

Expected output: `Characters with models: 90+` and Trigger Happy showing `['TriggerHappy_Wii', 'SpringtimeTriggerHappy', 'LegendaryTriggerHappy_Wii', 'SidekickTriggerHappy']` (or similar).

- [ ] **Step 3: Rebuild and confirm `SKYLANDERS` array in built HTML has `models` field**

```bash
node scripts/reclassify-tumblr.mjs ./skylanders-archive
grep -c '"models":\[\]' skylanders-archive/index.html || echo "not found"
grep -o '"models":\[{' skylanders-archive/index.html | head -3
```

Expected: second line shows several matches (characters with at least one model).

- [ ] **Step 4: Commit**

```bash
git add scripts/reclassify-tumblr.mjs skylanders-archive/index.html
git commit -m "feat: enrich SKYLANDERS_LIST with fuzzy-matched Lost Islands models at build time"
```

---

## Task 2 — `profile-model-viewer.js`

**Files:**
- Create: `src/pages/server/skylanders/models/profile-model-viewer.js`

Self-contained Three.js module. Uses the importmap already in `index.html`. Exposes `window.ProfileModelViewer`. No DOM IDs shared with the existing `model-viewer.js` — all IDs are prefixed `pmv-`.

- [ ] **Step 1: Create the file**

```js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Single active viewer state — only one profile viewer exists at a time
let _s = null;

// ── Three.js helpers (same logic as model-viewer.js) ────────────────────
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

// ── Bone UI ──────────────────────────────────────────────────────────────
function buildBoneUi(containerEl) {
  const div = document.createElement('div');
  div.className = 'prof-mv-bone-ui';
  div.innerHTML =
    '<select id="pmv-bone-select"></select>' +
    ['X', 'Y', 'Z'].map(ax =>
      '<div class="bone-row">' +
        '<label>' + ax + '</label>' +
        '<input type="range" id="pmv-bone-' + ax.toLowerCase() + '" min="-180" max="180" value="0" step="1">' +
        '<span id="pmv-bone-' + ax.toLowerCase() + '-val">0</span>' +
      '</div>'
    ).join('');
  containerEl.appendChild(div);
  return div;
}

function populateBoneSelect(boneDefs) {
  const sel = document.getElementById('pmv-bone-select');
  if (!sel) return;
  sel.innerHTML = '';
  boneDefs.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = 'bone ' + i + ' (parent ' + b.parent + ')';
    sel.appendChild(opt);
  });
  syncSlidersFromBone();
}

function syncSlidersFromBone() {
  if (!_s?.charBuild) return;
  const idx  = parseInt(document.getElementById('pmv-bone-select')?.value ?? '0', 10);
  const bone = _s.charBuild.skeleton.bones[idx];
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
  if (!_s?.charBuild) return;
  const idx  = parseInt(document.getElementById('pmv-bone-select')?.value ?? '0', 10);
  const bone = _s.charBuild.skeleton.bones[idx];
  if (!bone) return;
  ['x', 'y', 'z'].forEach(ax => {
    const inp = document.getElementById('pmv-bone-' + ax);
    const spn = document.getElementById('pmv-bone-' + ax + '-val');
    if (!inp) return;
    bone.rotation[ax] = THREE.MathUtils.degToRad(+inp.value);
    if (spn) spn.textContent = inp.value;
  });
}

// ── Scene helpers ─────────────────────────────────────────────────────────
function clearScene() {
  if (!_s?.charBuild) return;
  _s.scene.remove(_s.charBuild.group);
  _s.charBuild.meshes.forEach(m => { m.geometry.dispose(); m.material.dispose?.(); });
  _s.charBuild = null;
}

async function loadIntoScene(entry) {
  clearScene();
  const res  = await fetch(entry.json);
  const data = await res.json();
  const build = buildCharacterObject(data);
  applyMaterial(build.group, entry.texture, _s.textureLoader);
  _s.scene.add(build.group);
  _s.charBuild = build;
  frameObject(build.group);
  if (_s.boneUiEl) {
    _s.boneUiEl.style.display = '';
    populateBoneSelect(build.boneDefs);
  }
}

// ── Public API ────────────────────────────────────────────────────────────
window.ProfileModelViewer = {

  // containerEl is the .prof-mv-canvas-wrap div created by renderProfileModelViewer.
  // The canvas is appended directly to it; bone UI is appended to its parent (.prof-mv-wrap).
  async mount(containerEl, models) {
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

    _s = { containerEl, models, currentIdx: 0, scene, camera, renderer, controls,
           charBuild: null, textureLoader, boneUiEl: null, rafId: null, ro: null, io: null, visible: true };

    // Bone UI appended to the parent .prof-mv-wrap so it sits outside the overflow:hidden canvas box
    const boneUiEl = buildBoneUi(containerEl.parentElement || containerEl);
    boneUiEl.style.display = 'none';
    _s.boneUiEl = boneUiEl;

    document.getElementById('pmv-bone-select')?.addEventListener('change', syncSlidersFromBone);
    ['x', 'y', 'z'].forEach(ax =>
      document.getElementById('pmv-bone-' + ax)?.addEventListener('input', onBoneRotChange)
    );

    function loop() {
      _s.rafId = requestAnimationFrame(loop);
      if (!_s.visible) return;
      controls.update();
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

- [ ] **Step 2: Verify the file exists and is valid JS**

```bash
node --input-type=module <<'EOF'
// Mock browser globals so the module can be parsed without a real browser
globalThis.window = { ProfileModelViewer: null };
globalThis.document = { getElementById: () => null, createElement: () => ({ style:{}, appendChild:()=>{} }) };
globalThis.ResizeObserver = class { observe(){} disconnect(){} };
globalThis.IntersectionObserver = class { observe(){} disconnect(){} };
globalThis.requestAnimationFrame = () => {};
// Just check it parses — imports will fail (no unpkg in node) but that's expected
import('/Users/cais_solomonik/Documents/repositories/quaint-lab/src/pages/server/skylanders/models/profile-model-viewer.js')
  .then(() => console.log('PARSE OK'))
  .catch(e => {
    if (e.message.includes('three') || e.message.includes('fetch')) console.log('PARSE OK (expected import error)');
    else { console.error('PARSE ERROR:', e.message); process.exit(1); }
  });
EOF
```

Expected: `PARSE OK` or `PARSE OK (expected import error)`.

- [ ] **Step 3: Commit**

```bash
git add src/pages/server/skylanders/models/profile-model-viewer.js
git commit -m "feat: add profile-model-viewer.js — self-contained Three.js mini-viewer for character profiles"
```

---

## Task 3 — Wire viewer into the archive profile

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs` (CSS block ~line 1455, script tag ~line 1818, `renderCharPanel` ~line 2677, `charProfileJS` ~line 1125)

Four sub-steps. Do them in order — each is independently verifiable.

### 3a — CSS

- [ ] **Step 1: Add CSS rules after the existing `.prof-*` block**

Find the line `.prof-add-variant button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}` (last line of the `.prof-add-variant` block, around line 1506). Insert the following after the next line (`/* Picker modal */` or the next comment block):

Find the existing comment `/* Picker modal */` and the `.prof-picker-item` block (around line 1519). Insert the new CSS block **before** that comment:

```css
/* Profile model viewer */
.prof-mv-wrap{margin-bottom:16px}
.prof-mv-canvas-wrap{width:100%;aspect-ratio:1/1;background:var(--bg3);
  border-radius:6px;overflow:hidden;border:1px solid var(--bd)}
.prof-mv-variants{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.prof-mv-variant{background:rgba(255,255,255,.06);border:1px solid var(--bd);
  color:var(--muted);font-size:.72rem;padding:3px 8px;border-radius:4px;cursor:pointer}
.prof-mv-variant.on{border-color:var(--acc);color:var(--acc);background:rgba(79,122,255,.15)}
.prof-mv-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.prof-mv-actions button{background:rgba(255,255,255,.06);color:var(--txt);
  border:1px solid var(--bd);font-size:.8rem;padding:4px 10px;border-radius:4px;cursor:pointer}
.prof-mv-actions button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.prof-mv-card-btn{border-color:rgba(255,204,0,.4)!important;color:var(--gold)!important}
.prof-mv-card-btn:hover{background:rgba(255,204,0,.1)!important}
.prof-mv-bone-ui{margin-top:8px;font-size:.75rem;color:var(--muted)}
.prof-mv-bone-ui select{background:var(--bg3);border:1px solid var(--bd);
  color:var(--txt);border-radius:3px;padding:2px 4px;width:100%;margin-bottom:5px}
.prof-mv-bone-ui .bone-row{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.prof-mv-bone-ui .bone-row label{width:12px;color:var(--muted);font-size:.7rem}
.prof-mv-bone-ui .bone-row input[type=range]{flex:1}
.prof-mv-bone-ui .bone-row span{width:28px;text-align:right;font-size:.7rem}
.prof-mv-empty{color:var(--muted);font-size:.85rem;padding:12px 0}
```

### 3b — Script tag

- [ ] **Step 2: Add the profile viewer script tag after the existing model-viewer tag**

Find the line:
```
<script type="module" src="/server/skylanders/models/model-viewer.js"></script>
```
(around line 1818). Add immediately after it:
```
<script type="module" src="/server/skylanders/models/profile-model-viewer.js"></script>
```

### 3c — `renderCharPanel` changes

- [ ] **Step 3: Add destroy call and `#prof-model-panel` to `renderCharPanel`**

In `renderCharPanel()` (around line 2677), make three targeted edits:

**Edit A** — In the `!sel.char` early-return path, add destroy before clearing:
```js
// BEFORE:
  if (!sel.char) {
    layout.classList.remove('has-panel');
    panel.innerHTML = '';
    lastPanelChar = null;
    return;
  }
// AFTER:
  if (!sel.char) {
    layout.classList.remove('has-panel');
    window.ProfileModelViewer?.destroy();
    panel.innerHTML = '';
    lastPanelChar = null;
    return;
  }
```

**Edit B** — After the `lastPanelChar` guard, add destroy before rebuilding:
```js
// BEFORE:
  if (sel.char === lastPanelChar) return;
  lastPanelChar = sel.char;
// AFTER:
  if (sel.char === lastPanelChar) return;
  window.ProfileModelViewer?.destroy();
  lastPanelChar = sel.char;
```

**Edit C** — In the main `sky` branch, prepend the model panel div. Find:
```js
  panel.innerHTML = '<div class="cp-name">' + escAttr(sky.name) + '</div>'
    + '<div class="cp-sub">' + escAttr(sky.game) + '</div>'
```
Change to:
```js
  panel.innerHTML = '<div id="prof-model-panel"></div>'
    + '<div class="cp-name">' + escAttr(sky.name) + '</div>'
    + '<div class="cp-sub">' + escAttr(sky.game) + '</div>'
```

**Edit D** — At the very end of `renderCharPanel()`, before the closing `}`, add the call to populate the viewer:
```js
  if (typeof renderProfileModelViewer === 'function') renderProfileModelViewer(sky);
```

### 3d — `charProfileJS` extension

- [ ] **Step 4: Add `renderProfileModelViewer` and `useAsCardArt` to `charProfileJS`**

The `charProfileJS` constant starts with the backtick line around line 1125. Add the following two functions at the **end** of the `charProfileJS` string, just before the closing backtick:

```js
function useAsCardArt(sky) {
  const dataUrl = window.ProfileModelViewer?.captureFrame();
  if (!dataUrl) return;
  try {
    sessionStorage.setItem('nfc-card-custom-art', dataUrl);
    sessionStorage.setItem('nfc-card-char-name', sky.name);
    window.open('/server/skylanders/nfc-card/', '_blank');
  } catch (e) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = sky.name.toLowerCase().replace(/\\s+/g, '-') + '-pose.png';
    a.click();
  }
}

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

- [ ] **Step 5: Rebuild and smoke-test in the browser**

```bash
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Then (assuming `archive-server.mjs` is already running on port 7373):

1. Open `http://localhost:7373/` in your browser.
2. Click "By Character" in the sidebar, then click "Trigger Happy".
3. Verify the right panel shows a 3D viewport at the top, with variant buttons below it (`TriggerHappy_Wii`, `SpringtimeTriggerHappy`, etc.), and "Reset pose" + "↗ Use as card art" buttons.
4. Click a variant button — model should swap.
5. Drag the bone slider — mesh should deform.
6. Click "Reset pose" — mesh returns to bind pose.
7. Now click a character with no models (e.g. "Blackout" which is Battlecast-only) — panel should show "No 3D model available for this character."

- [ ] **Step 6: Commit**

```bash
git add scripts/reclassify-tumblr.mjs skylanders-archive/index.html
git commit -m "feat: embed 3D model viewer in character profile right panel with variant switcher and pose controls"
```

---

## Task 4 — NFC card sessionStorage pre-load

**Files:**
- Modify: `src/pages/server/skylanders/nfc-card.njk:1728-1740`

This is independent of Tasks 1–3. The NFC card already has `selectCharacter(char)`, `tryLoad(src)`, `charImg`, `charImgIsArt`, `usingCustomImg`, `drawCard()`, and the `custom-indicator` element — we just hook into them.

- [ ] **Step 1: Add sessionStorage reading after `drawCard()` in the page init IIFE**

Find this block in `nfc-card.njk` (around line 1728):
```js
    buildGrid();
    drawCard();
    // Pre-load background/detail pickers immediately (no character needed)
```

Add the sessionStorage block between `drawCard()` and the background picker comment:

```js
    buildGrid();
    drawCard();

    // Pre-load a posed 3D model snapshot from the archive character profile viewer
    {
      const artData  = sessionStorage.getItem('nfc-card-custom-art');
      const charName = sessionStorage.getItem('nfc-card-char-name');
      sessionStorage.removeItem('nfc-card-custom-art');
      sessionStorage.removeItem('nfc-card-char-name');
      if (artData && charName) {
        const match = CHARS.find(c => c.name === charName);
        if (match) await selectCharacter(match);
        const img = await tryLoad(artData);
        if (img) {
          charImg = img;
          charImgIsArt = true;
          usingCustomImg = true;
          document.getElementById('custom-indicator').style.display = 'block';
          document.getElementById('export-btn').disabled = false;
          drawCard();
        }
      }
    }

    // Pre-load background/detail pickers immediately (no character needed)
```

- [ ] **Step 2: Smoke-test the sessionStorage handoff manually**

Open the archive at `http://localhost:7373/` in a browser console and run:

```js
sessionStorage.setItem('nfc-card-custom-art', document.createElement('canvas').toDataURL());
sessionStorage.setItem('nfc-card-char-name', 'Trigger Happy');
window.open('/server/skylanders/nfc-card/', '_blank');
```

Expected: NFC card opens with Trigger Happy pre-selected and the canvas (a blank transparent image) loaded as custom art — the "Custom image active" indicator should be visible.

- [ ] **Step 3: End-to-end test from the archive**

1. In the archive, select Trigger Happy from "By Character".
2. In the right panel 3D viewer, drag the bone sliders to a non-default pose.
3. Click "↗ Use as card art".
4. Verify the NFC card opens in a new tab with Trigger Happy selected and the posed model render as the card art.
5. Check that `sessionStorage` is cleared (run `sessionStorage.getItem('nfc-card-custom-art')` in the NFC tab console — should return `null`).

- [ ] **Step 4: Commit**

```bash
git add src/pages/server/skylanders/nfc-card.njk
git commit -m "feat: pre-load posed 3D model snapshot from archive character profile into NFC card maker"
```

---

## Post-implementation verification

Run these checks after all four tasks are complete:

- [ ] Rebuild and confirm publish build still strips the viewer:
  ```bash
  node scripts/reclassify-tumblr.mjs ./skylanders-archive --publish
  grep -c "prof-mv-canvas-wrap" dist/skylanders-archive/index.html || echo "0 — correctly stripped"
  ```
  Expected: `0 — correctly stripped` (or the file doesn't exist if publish writes elsewhere).

- [ ] Select a character, navigate away (select a game category), return to the character — verify no WebGL context leak (browser console should show no "too many WebGL contexts" warnings).

- [ ] Verify the `model-viewer.js` on the Lost Islands dashboard is unaffected: open `http://localhost:7373/` → select Lost Islands → open the model viewer → confirm it still loads and browses models normally.
