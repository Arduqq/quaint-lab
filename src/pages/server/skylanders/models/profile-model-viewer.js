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
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    renderer.setClearAlpha(0);
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
    // The skeleton overlay, joint spheres, and the dark scene background are
    // posing aids, not part of the exported art — hide/clear them for this
    // one render (transparent canvas, alpha:true renderer), then restore.
    if (_s.skeletonHelper) _s.skeletonHelper.visible = false;
    if (_s.jointGroup) _s.jointGroup.visible = false;
    const prevBackground = _s.scene.background;
    _s.scene.background = null;
    _s.renderer.render(_s.scene, _s.camera);
    const dataUrl = _s.renderer.domElement.toDataURL('image/png');
    if (_s.skeletonHelper) _s.skeletonHelper.visible = true;
    if (_s.jointGroup) _s.jointGroup.visible = true;
    _s.scene.background = prevBackground;
    return dataUrl;
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
