'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const exState = {
  meta: null,       // { slug, title, canvasWidth, canvasHeight, background }
  elements: [],
  selectedId: null,
  parseError: null, // set when the .canvas.json sidecar failed to parse — saving would destroy it
};

// Scale the stage to whatever width the canvas panel actually has, recomputed on open
// and on resize — a fixed constant left dead checkered space on wide windows and
// shrank the stage needlessly on narrow ones. Matches the public page's own fit().
let exEditScale = 0.5;

function fitEditorCanvas() {
  if (!exState.meta) return;
  const wrap  = document.getElementById('exhibition-canvas-wrap');
  const style = getComputedStyle(wrap);
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  const availableWidth = wrap.clientWidth - paddingX;
  exEditScale = availableWidth / exState.meta.canvasWidth;
}
window.addEventListener('resize', () => {
  if (exState.meta) { fitEditorCanvas(); renderExhibitionCanvas(); }
});

// ─── List view ────────────────────────────────────────────────────────────────

async function loadExhibitionsList() {
  const grid = document.getElementById('exhibitions-list');
  grid.innerHTML = '<p style="color:#555;font-size:.75rem">Loading…</p>';
  const list = await api('GET', '/api/exhibitions');
  if (!Array.isArray(list) || !list.length) {
    grid.innerHTML = '<p style="color:#555;font-size:.75rem">No exhibitions yet. Click <b>+ New</b> to create one.</p>';
    return;
  }
  grid.innerHTML = '';
  for (const ex of list) {
    const card = document.createElement('div');
    card.className = 'post-card';
    card.innerHTML = `<div class="post-card-title">${esc(ex.title)}</div>`;
    card.addEventListener('click', () => openExhibitionEditor(ex.slug));
    grid.appendChild(card);
  }
}

async function createExhibition() {
  const title = prompt('Exhibition title:');
  if (!title || !title.trim()) return;
  const slug = slugify(title.trim());
  const r = await api('POST', '/api/exhibition', {
    slug, title: title.trim(), canvasWidth: 1600, canvasHeight: 1000, background: '#1a1a2e',
  });
  if (r.error) { showToast(r.error, 'err'); return; }
  openExhibitionEditor(slug);
}

// ─── Editor: load + read-only render ───────────────────────────────────────────

async function openExhibitionEditor(slug) {
  const ex = await api('GET', `/api/exhibition?slug=${encodeURIComponent(slug)}`);
  if (ex.error) { showToast(ex.error, 'err'); return; }
  exState.meta       = ex.meta;
  exState.elements   = ex.elements;
  exState.selectedId = null;
  exState.parseError = ex.parseError || null;

  document.getElementById('exhibitions-view').classList.add('hidden');
  document.getElementById('exhibition-editor-view').classList.remove('hidden');
  document.getElementById('exhibition-editor-title').textContent = ex.meta.title;
  document.getElementById('exhibition-bg-color').value = ex.meta.background;
  document.getElementById('exhibition-description').value = ex.meta.description || '';

  await loadExhibitionPalette();
  await loadBackgroundPicker();
  fitEditorCanvas();
  renderExhibitionCanvas();
  // Reset the properties panel — otherwise it keeps showing the previously open
  // exhibition's selected element, which is no longer on this canvas.
  renderProperties();
  renderParseErrorBanner();
}

// The sidecar exists but couldn't be parsed: the canvas looks empty but ISN'T, and a
// Save would overwrite the damaged-but-possibly-recoverable file with []. Make that
// impossible to miss and impossible to do in one unwitting click.
function renderParseErrorBanner() {
  const toolbar = document.querySelector('.exhibition-toolbar');
  let banner = document.getElementById('exhibition-parse-error');
  if (!exState.parseError) {
    if (banner) banner.remove();
    return;
  }
  if (!banner && toolbar) {
    banner = document.createElement('div');
    banner.id = 'exhibition-parse-error';
    banner.style.cssText = 'padding:.5rem .7rem; background:#5a1111; color:#ffd7d7; ' +
      'border:1px solid #a33; font-size:.72rem; line-height:1.5;';
    // Sibling after the toolbar, not inside it: the toolbar is a non-wrapping flex row.
    toolbar.insertAdjacentElement('afterend', banner);
  }
  if (banner) {
    banner.textContent =
      `⚠ Could not read ${exState.meta.slug}.canvas.json (${exState.parseError}). ` +
      'The canvas below is EMPTY because the file failed to load — it is not actually empty. ' +
      'Saving now will overwrite the file and permanently lose its contents. ' +
      'Fix the JSON by hand first, or reload after repairing it.';
  }
  showToast('Canvas data failed to load — do NOT save, you would overwrite it', 'err');
}

async function loadExhibitionPalette() {
  const palette = document.getElementById('exhibition-palette');
  const files = await api('GET', '/api/images?folder=src/images/artwork');
  palette.innerHTML = '';
  for (const file of (files || [])) {
    const img = document.createElement('img');
    img.src = `/images/artwork/${file}`;
    img.title = file;
    img.dataset.file = file;
    palette.appendChild(img);
  }
}

function renderExhibitionCanvas() {
  const stage = document.getElementById('exhibition-canvas');
  const m = exState.meta;
  stage.style.width  = m.canvasWidth + 'px';
  stage.style.height = m.canvasHeight + 'px';
  applyStageBackground(stage, m);
  stage.style.transform  = `scale(${exEditScale})`;
  stage.style.transformOrigin = 'top left';
  stage.innerHTML = '';

  for (const el of exState.elements) {
    stage.appendChild(buildElementDOM(el));
  }
  stage.appendChild(buildHeightHandle());
}

// A grab bar straddling the canvas's bottom edge — width stays fixed (set at creation,
// no UI to change it), but height is meant to grow as freely as the exhibition needs.
// z-index above everything, including selection handles, so it's always reachable even
// if content sits flush with the bottom edge.
function buildHeightHandle() {
  const handle = document.createElement('div');
  handle.className = 'ex-height-handle';
  handle.title = 'Drag to resize exhibition height';
  handle.style.cssText = 'position:absolute; left:0; right:0; bottom:0; height:16px; ' +
    'transform:translateY(50%); cursor:ns-resize; display:flex; align-items:center; ' +
    'justify-content:center; z-index:1001;';
  const grip = document.createElement('div');
  grip.style.cssText = 'width:60px; height:6px; border-radius:3px; background:var(--accent,#c8a55a); opacity:0.85;';
  handle.appendChild(grip);
  handle.addEventListener('pointerdown', startCanvasHeightResize);
  return handle;
}

function startCanvasHeightResize(downEvent) {
  downEvent.preventDefault();
  downEvent.stopPropagation();
  const startHeight = exState.meta.canvasHeight;
  const startPointerY = downEvent.clientY;

  function onMove(moveEvent) {
    const dyScreen = (moveEvent.clientY - startPointerY) / exEditScale;
    exState.meta.canvasHeight = Math.max(200, startHeight + dyScreen);
    renderExhibitionCanvas();
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// Mirrors the background logic in src/_includes/exhibition-canvas.njk exactly — keep
// both in sync. Background-color is always the base; an image on top either tiles at
// an explicit size or covers the whole stage edge-to-edge.
function applyStageBackground(stage, meta) {
  stage.style.backgroundColor = meta.background;
  if (meta.backgroundImage) {
    stage.style.backgroundImage = `url(/images/exhibition-backgrounds/${meta.backgroundImage})`;
    if (meta.backgroundTile) {
      stage.style.backgroundRepeat = 'repeat';
      stage.style.backgroundSize   = `${meta.backgroundTileSize}px ${meta.backgroundTileSize}px`;
    } else {
      stage.style.backgroundRepeat   = 'no-repeat';
      stage.style.backgroundSize     = 'cover';
      stage.style.backgroundPosition = 'center';
    }
  } else {
    stage.style.backgroundImage = 'none';
  }
}

function buildElementDOM(el) {
  const wrap = document.createElement('div');
  wrap.className = `ex-el ex-el-${el.type}`;
  wrap.dataset.id = el.id;
  wrap.style.left     = (el.x - el.width / 2) + 'px';
  wrap.style.top      = (el.y - el.height / 2) + 'px';
  wrap.style.width    = el.width + 'px';
  wrap.style.height   = el.height + 'px';
  wrap.style.transform = `rotate(${el.rotation}deg)`;
  wrap.style.zIndex    = el.zIndex;
  wrap.style.opacity   = el.opacity;

  if (el.type === 'image') {
    const img = document.createElement('img');
    img.src = `/images/artwork/${el.src}`;
    img.onerror = () => img.classList.add('ex-broken');
    wrap.appendChild(img);
  } else if (el.type === 'text') {
    wrap.style.background = el.backgroundColor || 'transparent';
    const div = document.createElement('div');
    div.className = 'ex-text-content';
    div.textContent  = el.content;
    div.style.fontSize  = el.fontSize + 'px';
    div.style.color     = el.color;
    div.style.textAlign = el.align;
    wrap.appendChild(div);
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('ex-handle') || e.target.classList.contains('ex-rotate-handle')) return;
    startElementDrag(el, e);
  });

  if (el.id === exState.selectedId) {
    wrap.classList.add('ex-selected');
    addSelectionHandles(wrap, el);
  }
  return wrap;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

document.getElementById('btn-new-exhibition').addEventListener('click', createExhibition);
document.getElementById('btn-exhibition-back').addEventListener('click', () => {
  document.getElementById('exhibition-editor-view').classList.add('hidden');
  document.getElementById('exhibitions-view').classList.remove('hidden');
  loadExhibitionsList();
});

// ─── Selection & properties ────────────────────────────────────────────────────

let exNextId = 1;
function newElId() { return `el-${Date.now()}-${exNextId++}`; }

function selectElement(id) {
  exState.selectedId = id;
  renderExhibitionCanvas();
  renderProperties();
}

function getSelectedElement() {
  return exState.elements.find(e => e.id === exState.selectedId) || null;
}

function renderProperties() {
  const panel = document.getElementById('exhibition-properties');
  const el = getSelectedElement();
  if (!el) {
    panel.innerHTML = '<p class="dashboard-unavailable">Select an element to edit its properties.</p>';
    return;
  }

  const common = `
    <div class="field-row"><label>X</label><input type="number" data-prop="x" value="${el.x}"></div>
    <div class="field-row"><label>Y</label><input type="number" data-prop="y" value="${el.y}"></div>
    <div class="field-row"><label>Width</label><input type="number" data-prop="width" value="${el.width}"></div>
    <div class="field-row"><label>Height</label><input type="number" data-prop="height" value="${el.height}"></div>
    <div class="field-row"><label>Rotation</label><input type="number" data-prop="rotation" value="${el.rotation}"></div>
    <div class="field-row"><label>Opacity</label><input type="number" step="0.1" min="0" max="1" data-prop="opacity" value="${el.opacity}"></div>
  `;

  const textFields = el.type === 'text' ? `
    <div class="field-row"><label>Text</label><textarea data-prop="content" rows="3" style="width:100%">${esc(el.content)}</textarea></div>
    <div class="field-row"><label>Font size</label><input type="number" data-prop="fontSize" value="${el.fontSize}"></div>
    <div class="field-row"><label>Color</label><input type="color" data-prop="color" value="${el.color}"></div>
    <div class="field-row"><label>Background</label><input type="color" data-prop="backgroundColor" value="${el.backgroundColor && el.backgroundColor !== 'transparent' ? el.backgroundColor : '#000000'}"></div>
    <div class="field-row"><label><input type="checkbox" data-prop="_bgTransparent" ${(!el.backgroundColor || el.backgroundColor === 'transparent') ? 'checked' : ''} style="width:auto; vertical-align:middle;"> Transparent background</label></div>
    <div class="field-row"><label>Align</label>
      <select data-prop="align">
        <option value="left" ${el.align === 'left' ? 'selected' : ''}>left</option>
        <option value="center" ${el.align === 'center' ? 'selected' : ''}>center</option>
        <option value="right" ${el.align === 'right' ? 'selected' : ''}>right</option>
      </select>
    </div>
  ` : '';

  panel.innerHTML = `
    ${common}
    ${textFields}
    <div class="field-row" style="display:flex; gap:0.4rem;">
      <button class="btn-secondary" id="btn-bring-front" style="flex:1">Front</button>
      <button class="btn-secondary" id="btn-send-back" style="flex:1">Back</button>
    </div>
    <div class="field-row"><button class="btn-danger" id="btn-delete-el" style="width:100%">Delete</button></div>
  `;

  panel.querySelectorAll('[data-prop]').forEach(input => {
    const prop = input.dataset.prop;
    if (prop === 'backgroundColor' || prop === '_bgTransparent') return; // wired separately below
    input.addEventListener('input', () => {
      const raw = input.value;
      const isNumeric = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fontSize'].includes(prop);
      el[prop] = isNumeric ? Number(raw) : raw;
      renderExhibitionCanvas();
    });
  });

  // Background color and its "transparent" checkbox interact: the checkbox always wins
  // when checked, regardless of whatever color the picker last held.
  const bgColorInput = panel.querySelector('[data-prop="backgroundColor"]');
  const bgTransparentCheckbox = panel.querySelector('[data-prop="_bgTransparent"]');
  if (bgColorInput && bgTransparentCheckbox) {
    const applyBackground = () => {
      el.backgroundColor = bgTransparentCheckbox.checked ? 'transparent' : bgColorInput.value;
      renderExhibitionCanvas();
    };
    bgColorInput.addEventListener('input', () => { bgTransparentCheckbox.checked = false; applyBackground(); });
    bgTransparentCheckbox.addEventListener('change', applyBackground);
  }

  panel.querySelector('#btn-bring-front').addEventListener('click', () => reorderElement(el, 'front'));
  panel.querySelector('#btn-send-back').addEventListener('click', () => reorderElement(el, 'back'));
  panel.querySelector('#btn-delete-el').addEventListener('click', () => {
    exState.elements = exState.elements.filter(e => e.id !== el.id);
    exState.selectedId = null;
    renderExhibitionCanvas();
    renderProperties();
  });
}

function reorderElement(el, dir) {
  const zs = exState.elements.map(e => e.zIndex);
  el.zIndex = dir === 'front' ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
  renderExhibitionCanvas();
}

// Next free z-index. Uses the live max rather than elements.length, which collides with
// an existing element as soon as anything has been deleted or explicitly reordered.
function nextZIndex() {
  const zs = exState.elements.map(e => e.zIndex).filter(z => Number.isFinite(z));
  return zs.length ? Math.max(...zs) + 1 : 1;
}

// ─── Adding elements ────────────────────────────────────────────────────────────

function addTextElement() {
  const el = {
    id: newElId(), type: 'text', content: 'New text', x: exState.meta.canvasWidth / 2, y: exState.meta.canvasHeight / 2,
    width: 240, height: 100, rotation: 0, zIndex: nextZIndex(), opacity: 1,
    fontSize: 20, color: '#eeeeee', align: 'left', backgroundColor: 'transparent',
  };
  exState.elements.push(el);
  selectElement(el.id);
}

function addImageElement(file) {
  const el = {
    id: newElId(), type: 'image', src: file,
    x: exState.meta.canvasWidth / 2, y: exState.meta.canvasHeight / 2,
    width: 300, height: 300, rotation: 0, zIndex: nextZIndex(), opacity: 1,
  };
  exState.elements.push(el);
  selectElement(el.id);
}

document.getElementById('btn-add-text').addEventListener('click', addTextElement);
document.getElementById('exhibition-bg-color').addEventListener('input', (e) => {
  exState.meta.background = e.target.value;
  renderExhibitionCanvas();
});

// ─── Background image picker ─────────────────────────────────────────────────

async function loadBackgroundPicker() {
  const picker = document.getElementById('exhibition-bg-picker');
  const files = await api('GET', '/api/images?folder=src/images/exhibition-backgrounds');
  picker.querySelectorAll('.exhibition-bg-thumb:not(.exhibition-bg-none)').forEach(el => el.remove());
  for (const file of (files || [])) {
    const img = document.createElement('img');
    img.className = 'exhibition-bg-thumb';
    img.src   = `/images/exhibition-backgrounds/${file}`;
    img.title = file;
    img.dataset.file = file;
    img.addEventListener('click', () => selectBackgroundImage(file));
    picker.appendChild(img);
  }
  document.getElementById('exhibition-bg-tile').checked = Boolean(exState.meta.backgroundTile);
  document.getElementById('exhibition-bg-tile-size').value = exState.meta.backgroundTileSize || 200;
  highlightSelectedBackground();
  updateTileControlsVisibility();
}

function highlightSelectedBackground() {
  const picker = document.getElementById('exhibition-bg-picker');
  picker.querySelectorAll('.exhibition-bg-thumb').forEach(el => el.classList.remove('exhibition-bg-selected'));
  const current = exState.meta.backgroundImage;
  const selector = current ? `[data-file="${CSS.escape(current)}"]` : '#exhibition-bg-none';
  const match = picker.querySelector(selector) || document.getElementById('exhibition-bg-none');
  if (!current) document.getElementById('exhibition-bg-none').classList.add('exhibition-bg-selected');
  else if (match) match.classList.add('exhibition-bg-selected');
}

function updateTileControlsVisibility() {
  document.getElementById('exhibition-bg-tile-controls').classList.toggle('hidden', !exState.meta.backgroundImage);
  document.getElementById('exhibition-bg-tile-size-label').classList.toggle('hidden', !document.getElementById('exhibition-bg-tile').checked);
}

function selectBackgroundImage(file) {
  exState.meta.backgroundImage = file;
  highlightSelectedBackground();
  updateTileControlsVisibility();
  renderExhibitionCanvas();
}

async function uploadBackgroundImage(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const b64 = await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
  const result = await api('POST', '/api/image', { folder: 'src/images/exhibition-backgrounds', name: file.name, data: b64 });
  if (result.name) {
    await loadBackgroundPicker();
    selectBackgroundImage(result.name);
  } else {
    showToast(result.error || 'Upload failed', 'err');
  }
}

document.getElementById('exhibition-bg-none').addEventListener('click', () => selectBackgroundImage(''));

const exBgDrop = document.getElementById('exhibition-bg-drop');
exBgDrop.addEventListener('dragover',  e => { e.preventDefault(); exBgDrop.classList.add('drag-over'); });
exBgDrop.addEventListener('dragleave', () => exBgDrop.classList.remove('drag-over'));
exBgDrop.addEventListener('drop', e => {
  e.preventDefault();
  exBgDrop.classList.remove('drag-over');
  uploadBackgroundImage(e.dataTransfer.files[0]);
});
document.getElementById('exhibition-bg-file-input').addEventListener('change', e => {
  uploadBackgroundImage(e.target.files[0]);
  e.target.value = '';
});

document.getElementById('exhibition-bg-tile').addEventListener('change', (e) => {
  exState.meta.backgroundTile = e.target.checked;
  updateTileControlsVisibility();
  renderExhibitionCanvas();
});
document.getElementById('exhibition-bg-tile-size').addEventListener('input', (e) => {
  exState.meta.backgroundTileSize = Number(e.target.value) || 200;
  renderExhibitionCanvas();
});
document.getElementById('exhibition-palette').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-file]');
  if (img) addImageElement(img.dataset.file);
});

// ─── Drag / resize / rotate math ────────────────────────────────────────────────

function toLocalDelta(dxScreen, dyScreen, rotationDeg) {
  const rad = -rotationDeg * Math.PI / 180;
  return {
    dx: dxScreen * Math.cos(rad) - dyScreen * Math.sin(rad),
    dy: dxScreen * Math.sin(rad) + dyScreen * Math.cos(rad),
  };
}

function toScreenDelta(dxLocal, dyLocal, rotationDeg) {
  const rad = rotationDeg * Math.PI / 180;
  return {
    dx: dxLocal * Math.cos(rad) - dyLocal * Math.sin(rad),
    dy: dxLocal * Math.sin(rad) + dyLocal * Math.cos(rad),
  };
}

function startElementDrag(el, downEvent) {
  downEvent.preventDefault();
  selectElement(el.id);
  const startX = el.x, startY = el.y;
  const startPointerX = downEvent.clientX, startPointerY = downEvent.clientY;

  function onMove(moveEvent) {
    const dxScreen = (moveEvent.clientX - startPointerX) / exEditScale;
    const dyScreen = (moveEvent.clientY - startPointerY) / exEditScale;
    el.x = startX + dxScreen;
    el.y = startY + dyScreen;
    renderExhibitionCanvas();
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    renderProperties();
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// ─── Resize / rotate handles ─────────────────────────────────────────────────────

const EX_RESIZE_HANDLES = [
  { dir: 'nw', widthSign: -1, heightSign: -1, cursor: 'nwse-resize' },
  { dir: 'n',  widthSign:  0, heightSign: -1, cursor: 'ns-resize'   },
  { dir: 'ne', widthSign:  1, heightSign: -1, cursor: 'nesw-resize' },
  { dir: 'e',  widthSign:  1, heightSign:  0, cursor: 'ew-resize'   },
  { dir: 'se', widthSign:  1, heightSign:  1, cursor: 'nwse-resize' },
  { dir: 's',  widthSign:  0, heightSign:  1, cursor: 'ns-resize'   },
  { dir: 'sw', widthSign: -1, heightSign:  1, cursor: 'nesw-resize' },
  { dir: 'w',  widthSign: -1, heightSign:  0, cursor: 'ew-resize'   },
];

function addSelectionHandles(wrap, el) {
  for (const h of EX_RESIZE_HANDLES) {
    const handle = document.createElement('div');
    handle.className = 'ex-handle';
    handle.dataset.dir = h.dir;
    handle.style.cssText = `position:absolute; width:8px; height:8px; background:var(--accent,#c8a55a); cursor:${h.cursor}; z-index:1000;`;
    const posMap = {
      nw: ['0%', '0%'],   n: ['50%', '0%'],   ne: ['100%', '0%'],
      w:  ['0%', '50%'],                       e: ['100%', '50%'],
      sw: ['0%', '100%'], s: ['50%', '100%'], se: ['100%', '100%'],
    };
    const [left, top] = posMap[h.dir];
    handle.style.left = left; handle.style.top = top;
    handle.style.transform = 'translate(-50%, -50%)';
    handle.addEventListener('pointerdown', (e) => startResize(el, h, e));
    wrap.appendChild(handle);
  }

  const rotateHandle = document.createElement('div');
  rotateHandle.className = 'ex-rotate-handle';
  rotateHandle.style.cssText = 'position:absolute; left:50%; top:-24px; width:8px; height:8px; border-radius:50%; background:var(--accent,#c8a55a); transform:translateX(-50%); cursor:grab; z-index:1000;';
  rotateHandle.addEventListener('pointerdown', (e) => startRotate(el, e));
  wrap.appendChild(rotateHandle);
}

function startResize(el, handleConfig, downEvent) {
  downEvent.preventDefault();
  downEvent.stopPropagation();
  const startX = el.x, startY = el.y, startWidth = el.width, startHeight = el.height;
  const startPointerX = downEvent.clientX, startPointerY = downEvent.clientY;

  function onMove(moveEvent) {
    const dxScreen = (moveEvent.clientX - startPointerX) / exEditScale;
    const dyScreen = (moveEvent.clientY - startPointerY) / exEditScale;
    const local = toLocalDelta(dxScreen, dyScreen, el.rotation);

    const newWidth  = Math.max(20, startWidth  + local.dx * handleConfig.widthSign);
    const newHeight = Math.max(20, startHeight + local.dy * handleConfig.heightSign);
    const widthDelta  = (newWidth  - startWidth)  * handleConfig.widthSign;
    const heightDelta = (newHeight - startHeight) * handleConfig.heightSign;

    const screenShift = toScreenDelta(widthDelta / 2, heightDelta / 2, el.rotation);

    el.width  = newWidth;
    el.height = newHeight;
    el.x = startX + screenShift.dx;
    el.y = startY + screenShift.dy;
    renderExhibitionCanvas();
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    renderProperties();
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function startRotate(el, downEvent) {
  downEvent.preventDefault();
  downEvent.stopPropagation();
  const canvasRect = document.getElementById('exhibition-canvas').getBoundingClientRect();
  const centerScreenX = canvasRect.left + el.x * exEditScale;
  const centerScreenY = canvasRect.top  + el.y * exEditScale;

  function angleAt(e) {
    return Math.atan2(e.clientY - centerScreenY, e.clientX - centerScreenX) * 180 / Math.PI;
  }
  const startAngle = angleAt(downEvent);
  const startRotation = el.rotation;

  function onMove(moveEvent) {
    el.rotation = startRotation + (angleAt(moveEvent) - startAngle);
    renderExhibitionCanvas();
  }
  function onUp() {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    renderProperties();
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function saveExhibition() {
  // Never let a corrupt-sidecar session be overwritten by one unwitting click.
  if (exState.parseError) {
    const ok = confirm(
      `${exState.meta.slug}.canvas.json could not be read (${exState.parseError}).\n\n` +
      'The editor is showing an EMPTY canvas because the file failed to load, not because ' +
      'it is empty. Saving now OVERWRITES that file and permanently destroys its contents.\n\n' +
      'Save anyway?'
    );
    if (!ok) return;
  }
  const r = await api('PUT', '/api/exhibition', {
    slug: exState.meta.slug,
    meta: {
      title:        exState.meta.title,
      description:  document.getElementById('exhibition-description').value.replace(/\s*\n+\s*/g, ' '),
      canvasWidth:  exState.meta.canvasWidth,
      canvasHeight: exState.meta.canvasHeight,
      background:   exState.meta.background,
      backgroundImage:    exState.meta.backgroundImage || '',
      backgroundTile:     Boolean(exState.meta.backgroundTile),
      backgroundTileSize: exState.meta.backgroundTileSize || 200,
    },
    elements: exState.elements,
  });
  if (r.error) { showToast(r.error, 'err'); return; }
  // The sidecar has just been rewritten as valid JSON, so the warning no longer applies.
  if (exState.parseError) {
    exState.parseError = null;
    renderParseErrorBanner();
  }
  showToast('Exhibition saved!');
}

document.getElementById('btn-save-exhibition').addEventListener('click', saveExhibition);
