'use strict';

// ─── State ───────────────────────────────────────────────────────────────────

const exState = {
  meta: null,       // { slug, title, canvasWidth, canvasHeight, background }
  elements: [],
  selectedId: null,
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

  document.getElementById('exhibitions-view').classList.add('hidden');
  document.getElementById('exhibition-editor-view').classList.remove('hidden');
  document.getElementById('exhibition-editor-title').textContent = ex.meta.title;
  document.getElementById('exhibition-bg-color').value = ex.meta.background;

  await loadExhibitionPalette();
  renderExhibitionCanvas();
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

  if (el.id === exState.selectedId) wrap.classList.add('ex-selected');
  return wrap;
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

document.getElementById('btn-new-exhibition').addEventListener('click', createExhibition);
document.getElementById('btn-exhibition-back').addEventListener('click', () => {
  document.getElementById('exhibition-editor-view').classList.add('hidden');
  document.getElementById('exhibitions-view').classList.remove('hidden');
  loadExhibitionsList();
});
