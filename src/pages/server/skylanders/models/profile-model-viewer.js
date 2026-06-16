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
  _s.charBuild.skeleton.dispose();
  _s.charBuild = null;
}

async function loadIntoScene(entry) {
  clearScene();
  const res  = await fetch(entry.json);
  if (!res.ok) throw new Error('Failed to load model: ' + res.status + ' ' + entry.json);
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

    const boneAc = new AbortController();
    _s.boneAc = boneAc;

    // Bone UI appended to the parent .prof-mv-wrap so it sits outside the overflow:hidden canvas box
    const boneUiEl = buildBoneUi(containerEl.parentElement || containerEl);
    boneUiEl.style.display = 'none';
    _s.boneUiEl = boneUiEl;

    document.getElementById('pmv-bone-select')?.addEventListener('change', syncSlidersFromBone, { signal: boneAc.signal });
    ['x', 'y', 'z'].forEach(ax =>
      document.getElementById('pmv-bone-' + ax)?.addEventListener('input', onBoneRotChange, { signal: boneAc.signal })
    );

    function loop() {
      if (!_s) return;
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
