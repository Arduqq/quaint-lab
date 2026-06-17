import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { zipSync, strToU8 } from 'fflate';

const mvRoot   = document.getElementById('mv-root');
const viewport = document.getElementById('mv-viewport');

let initialized = false;
let visible = false;

let scene, camera, renderer, controls, gridGroup;
let currentModel = null;
let currentRawObject = null; // unrotated, for re-applying Z-up toggle
let currentCharacterBuild = null; // { group, skeleton, bones, meshes, boneDefs } for rigged (.json) models
let currentSkeleton = null;
let skeletonHelper = null;
let currentTexturePath = null;
let currentTexture = null;
let currentEntry = null; // manifest entry for the selected model
let textureLoader, objLoader;

let models = [];
let textures = [];
let modelItems = [];
let texItems = [];

// Curation-only icon/texture override controls — the --publish build of the
// archive sets window.SKYLANDER_PUBLISH = true and these stay hidden/inert.
const PUBLISH   = !!window.SKYLANDER_PUBLISH;
const MODEL_API = window.SKYLANDER_MODEL_API || null;
let overrideStatusEl = null;
let setIconBtn = null, clearIconBtn = null, setTextureBtn = null, clearTextureBtn = null;
let texHeaderEl = null, texHeaderDefaultText = '';
// When true, the texture grid is narrowed to the lost-islands/ui/ folder and
// the next texture click sets it as the current model's icon (see "Set as icon").
let iconPickMode = false;

// Exposed immediately (function declarations below are hoisted) so the main
// archive script can call show()/hide() even from a listener that runs
// during this module's own top-level evaluation (see deep-link dispatch below).
window.SkylanderModelViewer = { show, hide };

// ── Deep links: #model=LI-M-014 / #texture=LI-T-0231 ────────────────────────
let pendingDeepLink = null;
{
  const m = location.hash.match(/^#(model|texture)=(.+)$/);
  if (m) {
    pendingDeepLink = { type: m[1], id: m[2] };
    window.dispatchEvent(new CustomEvent('skylander-model-deeplink', { detail: pendingDeepLink }));
  }
}

function getTexture() {
  if (!currentTexturePath) return null;
  if (currentTexture && currentTexture.__path === currentTexturePath) return currentTexture;
  const tex = textureLoader.load(currentTexturePath);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.__path = currentTexturePath;
  currentTexture = tex;
  return tex;
}

function applyMaterial(root) {
  const shading = document.querySelector('input[name=mv-shading]:checked').value;
  const wireframe = document.getElementById('mv-wireframe').checked;
  // Core_Theme props (crops, decorations, debris, statues, structures) are
  // built from one or two flat planes whose diffuse texture carries an alpha
  // channel for cutout/blending - render them double-sided and transparent.
  const isTransparentPlane = currentEntry && currentEntry.dir.includes('Core_Theme');

  let baseMaterial;
  if (shading === 'normal') {
    baseMaterial = new THREE.MeshNormalMaterial();
  } else if (shading === 'texture') {
    baseMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.9 });
    const tex = getTexture();
    if (tex) {
      // The OBJ/JSON exporters write V already flipped (1 - v) to match a
      // bottom-left UV origin; three.js's default flipY=true would flip it
      // again on upload, so cancel that out here.
      tex.flipY = false;
      // UVs are atlas offsets and routinely fall outside [0,1) (e.g. U in
      // [-1.9, 0.08]); repeat-wrapping lets them wrap back into the sheet
      // instead of clamping to the edge texel.
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.needsUpdate = true;
      baseMaterial.map = tex;
    }
  } else {
    baseMaterial = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0, roughness: 0.9 });
  }

  if (isTransparentPlane) {
    baseMaterial.transparent = true;
    baseMaterial.side = THREE.DoubleSide;
  }

  root.traverse((child) => {
    if (child.isMesh) {
      const mat = baseMaterial.clone();
      if (mat.map) mat.map = baseMaterial.map; // clone() doesn't deep-copy textures, keep ref
      mat.wireframe = wireframe;
      child.material = mat;
    }
  });
}

function frameObject(root) {
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
  const fitDist = maxDim / (2 * Math.tan((Math.PI * camera.fov) / 360));

  controls.target.copy(center);
  const dir = new THREE.Vector3(1, 0.8, 1).normalize();
  camera.position.copy(center).add(dir.multiplyScalar(fitDist * 1.6));
  camera.near = maxDim / 1000;
  camera.far = maxDim * 1000;
  camera.updateProjectionMatrix();
  controls.update();

  // scale grid to roughly match model size
  const gridScale = Math.max(maxDim / 20, 0.01);
  gridGroup.scale.setScalar(gridScale);
  gridGroup.position.set(0, box.min.y, 0);
}

// Build a THREE.Group containing a Bone hierarchy (bind pose = local
// translations from igSkeletonBone) plus one SkinnedMesh per mesh, all
// bound to a shared THREE.Skeleton. Bone rotations default to identity
// (bind pose); the bone pose UI lets you rotate individual bones to
// visually validate the skin weights/indices.
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

  // bone.matrixWorld must reflect the bind-pose hierarchy (chained local
  // translations) before computing boneInverses, otherwise skinning will
  // double-apply the bone offsets.
  group.updateMatrixWorld(true);
  skeleton.calculateInverses();

  const meshes = [];
  for (const m of data.meshes) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(m.positions, 3));
    if (m.uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.uvs, 2));
    if (m.normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.normals, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(m.skinIndices, 4));
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

function populateBoneSelect(bones) {
  const sel = document.getElementById('mv-bone-select');
  sel.innerHTML = '';
  bones.forEach((b, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `bone ${i} (parent ${b.parent})`;
    sel.appendChild(opt);
  });
  updateSlidersFromBone();
}

function setSlider(id, rad) {
  const deg = Math.round(THREE.MathUtils.radToDeg(rad));
  document.getElementById(id).value = deg;
  document.getElementById(id + '-val').textContent = deg;
}

function updateSlidersFromBone() {
  if (!currentSkeleton) return;
  const idx = parseInt(document.getElementById('mv-bone-select').value, 10);
  const bone = currentSkeleton.bones[idx];
  setSlider('mv-bone-rot-x', bone.rotation.x);
  setSlider('mv-bone-rot-y', bone.rotation.y);
  setSlider('mv-bone-rot-z', bone.rotation.z);
}

function onBoneRotChange() {
  if (!currentSkeleton) return;
  const idx = parseInt(document.getElementById('mv-bone-select').value, 10);
  const bone = currentSkeleton.bones[idx];
  const x = THREE.MathUtils.degToRad(+document.getElementById('mv-bone-rot-x').value);
  const y = THREE.MathUtils.degToRad(+document.getElementById('mv-bone-rot-y').value);
  const z = THREE.MathUtils.degToRad(+document.getElementById('mv-bone-rot-z').value);
  bone.rotation.set(x, y, z);
  document.getElementById('mv-bone-rot-x-val').textContent = document.getElementById('mv-bone-rot-x').value;
  document.getElementById('mv-bone-rot-y-val').textContent = document.getElementById('mv-bone-rot-y').value;
  document.getElementById('mv-bone-rot-z-val').textContent = document.getElementById('mv-bone-rot-z').value;
}

function rebuildScene(refit) {
  if (currentModel) {
    scene.remove(currentModel);
    currentModel = null;
  }
  if (skeletonHelper) {
    scene.remove(skeletonHelper);
    skeletonHelper = null;
  }

  const wrapper = new THREE.Group();

  if (currentCharacterBuild) {
    // re-parent the cached group (preserves bone pose / skeleton state)
    wrapper.add(currentCharacterBuild.group);
    if (document.getElementById('mv-show-skeleton').checked) {
      skeletonHelper = new THREE.SkeletonHelper(currentCharacterBuild.group);
      wrapper.add(skeletonHelper);
    }
  } else if (currentRawObject) {
    wrapper.add(currentRawObject.clone(true));
  } else {
    return;
  }

  applyMaterial(wrapper);
  scene.add(wrapper);
  currentModel = wrapper;
  if (refit !== false) frameObject(wrapper);
}

function infoLine(entry) {
  const dirLabel = entry.dir.replace(/^extracted_models\//, '');
  return `<b>${entry.id} — ${dirLabel}/${entry.name}</b><br>`;
}

// ── Download bundle (.obj + .mtl + texture + rig json) ───────────────────
// Adds `mtllib`/`usemtl` references to a copy of the OBJ text so the bundled
// .mtl (and its texture) load automatically in Blender and similar tools.
function addMaterialRefs(objText, mtlFilename) {
  const withLib = `mtllib ${mtlFilename}\n` + objText;
  return withLib.replace(/^(o |g )(.*)$/gm, line => `${line}\nusemtl material0`);
}

function buildMtl(textureFilename) {
  return `newmtl material0\n`
    + `Ka 1.000 1.000 1.000\n`
    + `Kd 1.000 1.000 1.000\n`
    + `Ks 0.000 0.000 0.000\n`
    + `map_Kd ${textureFilename}\n`;
}

function buildReadme(entry, textureFilename, hasRig) {
  const lines = [`${entry.id} — ${entry.name}`, `Extracted from Skylanders: Lost Islands.`, ''];
  lines.push(`${entry.name}.obj — Wavefront OBJ mesh (vertices, UVs, normals, faces).`);
  if (textureFilename) {
    lines.push(`${entry.name}.mtl — material referencing ${textureFilename}; both load`);
    lines.push(`  together in Blender and most other 3D tools.`);
    lines.push('');
    lines.push(`Note: the UVs are atlas offsets and routinely fall outside the 0-1`);
    lines.push(`range (e.g. U from -1.9 to 0.08) — that's expected. Set the texture's`);
    lines.push(`wrap mode to "repeat" so the coordinates wrap back into the sheet`);
    lines.push(`instead of clamping to its edge.`);
  }
  if (hasRig) {
    lines.push('');
    lines.push(`${entry.name}_rig.json — skeleton + skin-weight data (not a standard`);
    lines.push(`format):`);
    lines.push(`  bones:  [{ parent: <index, -1 = root>, translation: [x,y,z] }, ...]`);
    lines.push(`          bind-pose local translations; chain through the parent`);
    lines.push(`          hierarchy for world-space bind positions.`);
    lines.push(`  meshes: [{ positions, normals, uvs, indices,`);
    lines.push(`             skinIndices, skinWeights }, ...]`);
    lines.push(`          flat arrays; skinIndices/skinWeights are 4 per vertex`);
    lines.push(`          (standard 4-bone linear-blend skinning).`);
  }
  return lines.join('\n') + '\n';
}

async function downloadModelBundle() {
  if (!currentEntry) return;
  const entry = currentEntry;
  const btn = document.getElementById('mv-download-btn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Bundling…';
  try {
    const files = {};
    const objText = await fetch(entry.obj).then(r => r.text());

    let textureFilename = null;
    if (entry.texture) {
      textureFilename = entry.texture.split('/').pop();
      const texBuf = await fetch(entry.texture).then(r => r.arrayBuffer());
      files[textureFilename] = new Uint8Array(texBuf);
      files[`${entry.name}.mtl`] = strToU8(buildMtl(textureFilename));
      files[`${entry.name}.obj`] = strToU8(addMaterialRefs(objText, `${entry.name}.mtl`));
    } else {
      files[`${entry.name}.obj`] = strToU8(objText);
    }

    if (entry.json) {
      const rigText = await fetch(entry.json).then(r => r.text());
      files[`${entry.name}_rig.json`] = strToU8(rigText);
    }

    files['README.txt'] = strToU8(buildReadme(entry, textureFilename, !!entry.json));

    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${entry.id}-${entry.name}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert('Download failed: ' + err);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function loadModel(path) {
  const info = document.getElementById('mv-info');
  info.innerHTML = infoLine(currentEntry) + `Loading ${path} ...`;

  if (path.endsWith('.json')) {
    currentRawObject = null;
    currentCharacterBuild = null;
    currentSkeleton = null;
    fetch(path).then(r => r.json()).then((data) => {
      currentCharacterBuild = buildCharacterObject(data);
      currentSkeleton = currentCharacterBuild.skeleton;
      document.getElementById('mv-skeleton-controls').style.display = 'block';
      populateBoneSelect(data.bones);
      rebuildScene(true);

      let verts = 0, tris = 0;
      for (const m of data.meshes) {
        verts += m.positions.length / 3;
        tris += m.indices.length / 3;
      }
      info.innerHTML = infoLine(currentEntry) +
        `meshes: ${data.meshes.length} &nbsp; verts: ${verts} &nbsp; tris: ${Math.round(tris)} &nbsp; bones: ${data.bones.length}`;
    }).catch((err) => {
      info.innerHTML = infoLine(currentEntry) + `Failed to load ${path}: ${err}`;
    });
    return;
  }

  currentCharacterBuild = null;
  currentSkeleton = null;
  document.getElementById('mv-skeleton-controls').style.display = 'none';

  objLoader.load(path, (obj) => {
    currentRawObject = obj;
    rebuildScene(true);

    // gather stats, computing normals for meshes that lack them
    let verts = 0, tris = 0, hasUV = false, hasNormal = false, meshCount = 0;
    obj.traverse((child) => {
      if (child.isMesh) {
        meshCount++;
        const geo = child.geometry;
        if (!geo.attributes.normal) geo.computeVertexNormals();
        verts += geo.attributes.position.count;
        if (geo.index) tris += geo.index.count / 3;
        else tris += geo.attributes.position.count / 3;
        if (geo.attributes.uv) hasUV = true;
        if (geo.attributes.normal) hasNormal = true;
      }
    });
    info.innerHTML = infoLine(currentEntry) +
      `meshes: ${meshCount} &nbsp; verts: ${verts} &nbsp; tris: ${Math.round(tris)}<br>` +
      `uv: ${hasUV} &nbsp; normals: ${hasNormal}`;
  }, undefined, (err) => {
    info.innerHTML = infoLine(currentEntry) + `Failed to load ${path}: ${err}`;
  });
}

// ── Model sidebar list ───────────────────────────────────────────────────
function renderModelList(filter) {
  const listEl = document.getElementById('mv-list');
  listEl.innerHTML = '';
  modelItems = [];
  const f = filter.toLowerCase();
  for (const entry of models) {
    const dirLabel = entry.dir.replace(/^extracted_models\//, '');
    const fullLabel = `${entry.id} ${dirLabel}/${entry.name}`;
    if (f && !fullLabel.toLowerCase().includes(f)) continue;

    const div = document.createElement('div');
    div.className = 'mv-item';
    if (currentEntry === entry) div.classList.add('active');

    const thumb = entry.icon || entry.texture;
    if (thumb) {
      const thumbEl = document.createElement('img');
      thumbEl.className = 'mv-item-thumb';
      thumbEl.src = thumb;
      thumbEl.loading = 'lazy';
      thumbEl.alt = '';
      div.appendChild(thumbEl);
    }

    const idEl = document.createElement('span');
    idEl.className = 'mv-id';
    idEl.textContent = entry.id;
    div.appendChild(idEl);

    const labelEl = document.createElement('span');
    labelEl.className = 'mv-item-label';
    labelEl.textContent = entry.name.replace(/_(Wii|Apple)$/, '');
    div.appendChild(labelEl);

    let titleLabel = fullLabel;
    if (entry.json && entry.obj) titleLabel += ' (rigged + mesh)';
    else if (entry.json) titleLabel += ' (rigged)';
    div.title = titleLabel;
    div.addEventListener('click', () => {
      for (const it of modelItems) it.classList.remove('active');
      div.classList.add('active');
      selectEntry(entry);
    });
    listEl.appendChild(div);
    modelItems.push(div);
  }
}

// Pick which representation (.json rigged vs .obj static mesh) to load for
// an entry, show/hide the toggle, auto-assign its matched texture (if any),
// and load it.
function selectEntry(entry) {
  currentEntry = entry;
  history.replaceState(null, '', '#model=' + entry.id);
  exitIconPickMode();

  const reprControls = document.getElementById('mv-repr-controls');
  if (entry.json && entry.obj) {
    reprControls.style.display = 'block';
    document.querySelector('input[name=mv-repr][value=json]').checked = true;
  } else {
    reprControls.style.display = 'none';
  }

  if (entry.texture) {
    currentTexturePath = entry.texture;
    document.querySelector('input[name=mv-shading][value=texture]').checked = true;
    highlightTexture(entry.texture);
  } else {
    currentTexturePath = null;
    document.querySelector('input[name=mv-shading][value=gray]').checked = true;
  }

  document.getElementById('mv-download-btn').disabled = false;

  updateOverrideBar();
  loadCurrentEntry();
}

function loadCurrentEntry() {
  if (!currentEntry) return;
  const reprChecked = document.querySelector('input[name=mv-repr]:checked');
  const repr = reprChecked ? reprChecked.value : null;
  let path;
  if (repr === 'obj' && currentEntry.obj) path = currentEntry.obj;
  else if (currentEntry.json) path = currentEntry.json;
  else path = currentEntry.obj;
  loadModel(path);
}

// ── Texture sidebar grid ─────────────────────────────────────────────────
function highlightTexture(path) {
  for (const it of texItems) it.classList.remove('active');
  const match = texItems.find(it => it.dataset.path === path);
  if (match) match.classList.add('active');
}

function renderTexGrid(filter) {
  const texGridEl = document.getElementById('mv-tex-grid');
  texGridEl.innerHTML = '';
  texItems = [];
  const f = filter.toLowerCase();
  let shown = 0;
  for (const tex of textures) {
    if (iconPickMode && !tex.path.includes('/lost-islands/ui/')) continue;
    const base = tex.path.split('/').pop();
    if (f && !(tex.id.toLowerCase() + ' ' + base.toLowerCase()).includes(f)) continue;
    shown++;
    if (shown > 400) break; // cap to keep things responsive
    const div = document.createElement('div');
    div.className = 'mv-tex-item';
    div.dataset.path = tex.path;
    if (tex.path === currentTexturePath) div.classList.add('active');
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = tex.path;
    const idEl = document.createElement('div');
    idEl.className = 'mv-tex-id';
    idEl.textContent = tex.id;
    const name = document.createElement('div');
    name.className = 'mv-tex-name';
    name.textContent = base;
    name.title = `${tex.id} — ${tex.path}`;
    div.appendChild(img);
    div.appendChild(idEl);
    div.appendChild(name);
    div.addEventListener('click', () => {
      if (iconPickMode) {
        saveOverride('icon', tex.path);
        exitIconPickMode();
        return;
      }
      currentTexturePath = tex.path;
      highlightTexture(tex.path);
      history.replaceState(null, '', '#texture=' + tex.id);
      // switch to textured mode automatically
      document.querySelector('input[name=mv-shading][value=texture]').checked = true;
      if (currentModel) rebuildScene(false);
      updateOverrideBar();
    });
    texGridEl.appendChild(div);
    texItems.push(div);
  }
}

// ── Curation-only icon/texture overrides ────────────────────────────────────
// Lets the user set the currently-selected model's `icon` (used as its
// thumbnail in the sidebar grid) and/or `texture` (its default "Textured
// (UV)" sheet) to whichever texture is currently selected in the texture
// grid, persisting the change to models.json via archive-server.mjs.
function buildOverrideBar() {
  if (PUBLISH || !MODEL_API) return;
  const texPanel = document.querySelector('.mv-tex-panel');
  const texGrid = document.getElementById('mv-tex-grid');
  if (!texPanel || !texGrid) return;

  const bar = document.createElement('div');
  bar.className = 'mv-override-bar';
  bar.innerHTML = `
    <button id="mv-set-icon" type="button" title="Use the selected texture as this model's thumbnail icon">Set as icon</button>
    <button id="mv-clear-icon" type="button">Clear icon</button>
    <button id="mv-set-texture" type="button" title="Use the selected texture as this model's default Textured (UV) sheet">Set as texture</button>
    <button id="mv-clear-texture" type="button">Clear texture</button>
    <div id="mv-override-status" class="mv-override-status"></div>`;
  texPanel.insertBefore(bar, texGrid);

  setIconBtn     = bar.querySelector('#mv-set-icon');
  clearIconBtn   = bar.querySelector('#mv-clear-icon');
  setTextureBtn  = bar.querySelector('#mv-set-texture');
  clearTextureBtn = bar.querySelector('#mv-clear-texture');
  overrideStatusEl = bar.querySelector('#mv-override-status');

  texHeaderEl = document.getElementById('mv-tex-header');
  texHeaderDefaultText = texHeaderEl ? texHeaderEl.textContent : '';

  setIconBtn.addEventListener('click', () => {
    if (iconPickMode) { exitIconPickMode(); return; }
    iconPickMode = true;
    setIconBtn.textContent = 'Cancel';
    if (texHeaderEl) texHeaderEl.textContent = 'Showing UI folder — click an icon to set it as this model’s icon.';
    renderTexGrid(document.getElementById('mv-tex-search').value);
    updateOverrideBar();
  });
  clearIconBtn.addEventListener('click', () => saveOverride('icon', null));
  setTextureBtn.addEventListener('click', () => saveOverride('texture', currentTexturePath));
  clearTextureBtn.addEventListener('click', () => saveOverride('texture', null));

  updateOverrideBar();
}

// Leaves "Set as icon" picker mode: restores the full texture grid and the
// default texture-panel hint text.
function exitIconPickMode() {
  if (!iconPickMode) return;
  iconPickMode = false;
  setIconBtn.textContent = 'Set as icon';
  if (texHeaderEl) texHeaderEl.textContent = texHeaderDefaultText;
  renderTexGrid(document.getElementById('mv-tex-search').value);
  if (currentTexturePath) highlightTexture(currentTexturePath);
  updateOverrideBar();
}

function updateOverrideBar() {
  if (!overrideStatusEl) return;
  const hasEntry = !!currentEntry;
  const hasTexture = !!currentTexturePath;
  setIconBtn.disabled    = !hasEntry;
  setTextureBtn.disabled = !hasEntry || !hasTexture || iconPickMode;
  clearIconBtn.disabled    = !hasEntry || !currentEntry.icon || iconPickMode;
  clearTextureBtn.disabled = !hasEntry || !currentEntry.texture || iconPickMode;
  if (iconPickMode) return; // status line shows the picker hint instead
  overrideStatusEl.textContent = hasEntry
    ? `Icon: ${currentEntry.icon ? currentEntry.icon.split('/').pop() : 'none'} · Texture: ${currentEntry.texture ? currentEntry.texture.split('/').pop() : 'none'}`
    : '';
}

function saveOverride(field, value) {
  if (!currentEntry || !MODEL_API) return;
  overrideStatusEl.textContent = 'Saving…';
  fetch(MODEL_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentEntry.id, field, value }),
  }).then(r => r.json()).then((res) => {
    if (res.ok) {
      if (value) currentEntry[field] = value;
      else delete currentEntry[field];
      renderModelList(document.getElementById('mv-search').value);
      updateOverrideBar();
    } else {
      overrideStatusEl.textContent = 'Save failed: ' + (res.error || 'unknown error');
    }
  }).catch((err) => {
    overrideStatusEl.textContent = 'Save failed: ' + err;
  });
}

function applyDeepLink() {
  if (!pendingDeepLink) return;
  const { type, id } = pendingDeepLink;
  pendingDeepLink = null;
  if (type === 'model') {
    const entry = models.find(m => m.id === id);
    if (entry) {
      renderModelList(document.getElementById('mv-search').value);
      selectEntry(entry);
    }
  } else if (type === 'texture') {
    const tex = textures.find(t => t.id === id);
    if (tex) {
      currentTexturePath = tex.path;
      document.querySelector('input[name=mv-shading][value=texture]').checked = true;
      renderTexGrid(document.getElementById('mv-tex-search').value);
      if (currentModel) rebuildScene(false);
      updateOverrideBar();
    }
  }
}

function onResize() {
  if (!initialized) return;
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  if (visible) renderer.render(scene, camera);
}

function init() {
  if (initialized) return;
  initialized = true;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x111120); // matches --bg3

  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
  camera.position.set(3, 3, 3);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  // Lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 7.5);
  scene.add(dirLight);
  const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
  dirLight2.position.set(-5, -3, -7.5);
  scene.add(dirLight2);

  // Grid + axes (accent-blue grid lines to match the archive's theme)
  gridGroup = new THREE.Group();
  const grid = new THREE.GridHelper(20, 20, 0x4f7aff, 0x22223a);
  gridGroup.add(grid);
  gridGroup.add(new THREE.AxesHelper(2));
  scene.add(gridGroup);

  textureLoader = new THREE.TextureLoader();
  objLoader = new OBJLoader();

  // Toggles
  document.getElementById('mv-wireframe').addEventListener('change', () => currentModel && applyMaterial(currentModel));
  for (const r of document.querySelectorAll('input[name=mv-shading]')) {
    r.addEventListener('change', () => currentModel && applyMaterial(currentModel));
  }
  document.getElementById('mv-show-grid').addEventListener('change', (e) => {
    gridGroup.visible = e.target.checked;
  });
  for (const r of document.querySelectorAll('input[name=mv-repr]')) {
    r.addEventListener('change', loadCurrentEntry);
  }

  // Skeleton / bone-pose controls (shown only for rigged .json character models)
  document.getElementById('mv-show-skeleton').addEventListener('change', () => rebuildScene(false));
  document.getElementById('mv-bone-select').addEventListener('change', updateSlidersFromBone);
  for (const id of ['mv-bone-rot-x', 'mv-bone-rot-y', 'mv-bone-rot-z']) {
    document.getElementById(id).addEventListener('input', onBoneRotChange);
  }
  document.getElementById('mv-reset-pose').addEventListener('click', () => {
    if (!currentSkeleton) return;
    const boneDefs = currentCharacterBuild.boneDefs;
    currentSkeleton.bones.forEach((bone, i) => {
      bone.rotation.set(0, 0, 0);
      bone.position.set(boneDefs[i].translation[0], boneDefs[i].translation[1], boneDefs[i].translation[2]);
      bone.scale.set(1, 1, 1);
    });
    currentCharacterBuild.group.updateMatrixWorld(true);
    updateSlidersFromBone();
  });

  document.getElementById('mv-download-btn').addEventListener('click', downloadModelBundle);

  const searchEl = document.getElementById('mv-search');
  const texSearchEl = document.getElementById('mv-tex-search');
  searchEl.addEventListener('input', () => renderModelList(searchEl.value));
  texSearchEl.addEventListener('input', () => renderTexGrid(texSearchEl.value));

  document.querySelector('.mv-back').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('skylander-model-viewer-close'));
  });

  buildOverrideBar();

  window.addEventListener('resize', onResize);

  Promise.all([
    fetch('/server/skylanders/models/models.json').then(r => r.json()),
    fetch('/server/skylanders/models/textures.json').then(r => r.json()),
  ]).then(([modelsData, texturesData]) => {
    models = modelsData;
    textures = texturesData;
    const vocab = window.ARCHIVE_VOCAB || {};
    searchEl.placeholder = `${vocab.searchModelsLabel || 'Filter models…'} (${models.length} total)`;
    texSearchEl.placeholder = `${vocab.searchTexturesLabel || 'Filter textures…'} (${textures.length} total)`;
    renderModelList('');
    renderTexGrid('');
    if (currentTexturePath) highlightTexture(currentTexturePath);
    applyDeepLink();
  });

  animate();
}

function show() {
  init();
  mvRoot.style.display = 'flex';
  visible = true;
  onResize();
  if (pendingDeepLink && models.length) applyDeepLink();
}

function hide() {
  mvRoot.style.display = 'none';
  visible = false;
}
