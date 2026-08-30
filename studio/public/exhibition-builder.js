'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const exState = {
  meta: null,       // { slug, title, canvasWidth, canvasHeight, background }
  elements: [],
  selectedId: null,
  parseError: null, // set when the .canvas.json sidecar failed to parse — saving would destroy it
};

const EX_EDIT_SCALE = 0.5; // editor renders the stage at half size to fit typical screens

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
  stage.style.width      = m.canvasWidth + 'px';
  stage.style.height     = m.canvasHeight + 'px';
  stage.style.background = m.background;
  stage.style.transform  = `scale(${EX_EDIT_SCALE})`;
  stage.style.transformOrigin = 'top left';
  stage.innerHTML = '';

  for (const el of exState.elements) {
    stage.appendChild(buildElementDOM(el));
  }
}

function buildElementDOM(el) {
  const wrap = document.createElement('div');
  wrap.className = `ex-el ex-el-${el.type}`;
  wrap.dataset.id = el.id;
  wrap.style.left     = (el.x - el.width / 2) + 'px';
  // Text elements have no persisted height (it's automatic, from content), so for them
  // `y` is an APPROXIMATE anchor near the top of the box — not a true visual centre the
  // way it is for images. The fixed 20px offset only reads as centred for short,
  // single-line captions at typical font sizes; multi-line or large text sits lower than
  // its `y` suggests. Rotation pivots around this same approximate point, so it can look
  // slightly off-centre in those cases. True centring would need runtime height
  // measurement (out of scope). `y` is persisted in every .canvas.json, so changing this
  // convention would reposition existing exhibitions.
  // Keep in sync with the text `top` calculation in src/_includes/exhibition-canvas.njk.
  wrap.style.top      = (el.type === 'text' ? el.y - 20 : el.y - el.height / 2) + 'px';
  wrap.style.width    = el.width + 'px';
  if (el.type === 'image') wrap.style.height = el.height + 'px';
  wrap.style.transform = `rotate(${el.rotation}deg)`;
  wrap.style.zIndex    = el.zIndex;
  wrap.style.opacity   = el.opacity;

  if (el.type === 'image') {
    const img = document.createElement('img');
    img.src = `/images/artwork/${el.src}`;
    img.onerror = () => img.classList.add('ex-broken');
    wrap.appendChild(img);
  } else if (el.type === 'text') {
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
    ${el.type === 'image' ? `<div class="field-row"><label>Height</label><input type="number" data-prop="height" value="${el.height}"></div>` : ''}
    <div class="field-row"><label>Rotation</label><input type="number" data-prop="rotation" value="${el.rotation}"></div>
    <div class="field-row"><label>Opacity</label><input type="number" step="0.1" min="0" max="1" data-prop="opacity" value="${el.opacity}"></div>
  `;

  const textFields = el.type === 'text' ? `
    <div class="field-row"><label>Text</label><textarea data-prop="content" rows="3" style="width:100%">${esc(el.content)}</textarea></div>
    <div class="field-row"><label>Font size</label><input type="number" data-prop="fontSize" value="${el.fontSize}"></div>
    <div class="field-row"><label>Color</label><input type="color" data-prop="color" value="${el.color}"></div>
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
    input.addEventListener('input', () => {
      const prop = input.dataset.prop;
      const raw  = input.value;
      const isNumeric = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fontSize'].includes(prop);
      el[prop] = isNumeric ? Number(raw) : raw;
      renderExhibitionCanvas();
    });
  });
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
    width: 240, rotation: 0, zIndex: nextZIndex(), opacity: 1,
    fontSize: 20, color: '#eeeeee', align: 'left',
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
    const dxScreen = (moveEvent.clientX - startPointerX) / EX_EDIT_SCALE;
    const dyScreen = (moveEvent.clientY - startPointerY) / EX_EDIT_SCALE;
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
  // Text elements have no persisted height (it's automatic, based on content), so
  // vertical resize doesn't apply to them — force heightSign to 0 for text regardless
  // of which handle was grabbed, so only width changes and Y never shifts.
  const heightSign  = el.type === 'image' ? handleConfig.heightSign : 0;
  const startX = el.x, startY = el.y, startWidth = el.width, startHeight = el.height || 40;
  const startPointerX = downEvent.clientX, startPointerY = downEvent.clientY;

  function onMove(moveEvent) {
    const dxScreen = (moveEvent.clientX - startPointerX) / EX_EDIT_SCALE;
    const dyScreen = (moveEvent.clientY - startPointerY) / EX_EDIT_SCALE;
    const local = toLocalDelta(dxScreen, dyScreen, el.rotation);

    const newWidth  = Math.max(20, startWidth  + local.dx * handleConfig.widthSign);
    const newHeight = Math.max(20, startHeight + local.dy * heightSign);
    const widthDelta  = (newWidth  - startWidth)  * handleConfig.widthSign;
    const heightDelta = (newHeight - startHeight) * heightSign;

    const screenShift = toScreenDelta(widthDelta / 2, heightDelta / 2, el.rotation);

    el.width  = newWidth;
    if (el.type === 'image') el.height = newHeight;
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
  const centerScreenX = canvasRect.left + el.x * EX_EDIT_SCALE;
  const centerScreenY = canvasRect.top  + el.y * EX_EDIT_SCALE;

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
      description:  document.getElementById('exhibition-description').value,
      canvasWidth:  exState.meta.canvasWidth,
      canvasHeight: exState.meta.canvasHeight,
      background:   exState.meta.background,
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
