'use strict';

// ─── Schemas (one per content type) ─────────────────────────────────────────
// Each field: { key, label, type, required?, placeholder?, hint?, folder?, imageOnly? }

const SCHEMAS = {
  writing: {
    label: 'Writing',
    fields: [
      { key: 'posttitle',  label: 'Title',      type: 'text',     required: true },
      { key: 'date',       label: 'Date',        type: 'date',     required: true },
      { key: 'excerpt',    label: 'Excerpt',     type: 'textarea' },
      { key: 'vibe',       label: 'Vibe',        type: 'text', placeholder: 'e.g. lagged, melancholic' },
      { key: 'categories', label: 'Categories',  type: 'tags' },
      { key: 'draft',      label: 'Draft',       type: 'checkbox' },
    ],
    defaults: { layout: 'post.njk', tags: 'post' },
  },

  games: {
    label: 'Games',
    fields: [
      { key: 'posttitle', label: 'Title',       type: 'text',     required: true },
      { key: 'date',      label: 'Date',         type: 'date',     required: true },
      { key: 'excerpt',   label: 'Excerpt',      type: 'textarea' },
      { key: 'image',     label: 'Hero Image',   type: 'image',    folder: 'src/images/home', imageOnly: false },
      { key: 'draft',     label: 'Draft',        type: 'checkbox' },
    ],
    defaults: { layout: 'post.njk', categories: ['games'] },
    extraFM: (slug) => ({
      permalink:          `/games/${slug}/`,
      screenshots_folder: `images/posts/games/${slug}`,
    }),
  },

  artwork: {
    label: 'Artwork',
    fields: [
      { key: 'posttitle',  label: 'Title',           type: 'text',   required: true },
      { key: '_series',    label: 'Series / Subdir',  type: 'series', isMetaField: true },
      { key: 'categories', label: 'Categories',       type: 'tags' },
      { key: 'tags',       label: 'Exhibition Tags',  type: 'tags', hint: 'add "artwork" + "exhibition-xxx" tags' },
      { key: 'comment',    label: 'Notes',            type: 'textarea' },
      { key: 'image',      label: 'Image',            type: 'image',  folder: 'src/images/artwork', imageOnly: true },
      { key: 'draft',      label: 'Draft',            type: 'checkbox' },
    ],
    defaults: { title: 'Artwork', layout: 'artwork.njk' },
  },

  pets: {
    label: 'Pets',
    fields: [
      { key: 'posttitle',   label: 'Pet Name',    type: 'text',     required: true },
      { key: 'comment',     label: 'Description', type: 'textarea' },
      { key: 'home',        label: 'Home Site',   type: 'text',     placeholder: 'e.g. Moderneopets' },
      { key: 'personality', label: 'Personality', type: 'text' },
      { key: 'spirit',      label: 'Spirit',      type: 'text' },
      { key: 'image',       label: 'Image',       type: 'image',    folder: 'src/images/artwork', imageOnly: true },
      { key: 'draft',       label: 'Draft',       type: 'checkbox' },
    ],
    defaults: { title: 'Pet', layout: 'artwork.njk', tags: 'pets' },
  },
};

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  type:          'writing',
  posts:         [],
  editing:       null,
  artworkSeries: [],
};

const atelierState = {
  folders:      [],
  activeFolder: null,
  folderPosts:  [],
  fromAtelier:  false,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $     = id => document.getElementById(id);
const listView     = $('list-view');
const atelierView  = $('atelier-view');
const editView     = $('edit-view');
const postsGrid    = $('posts-grid');
const typeHeading  = $('type-heading');
const editHeading  = $('edit-heading');
const contentEd    = $('content-editor');
const editForm     = $('edit-form');
const buildOverlay = $('build-overlay');
const buildOutput  = $('build-output');
const toast        = $('toast');

// ─── Utilities ────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function slugify(s) {
  return s.toLowerCase().replace(/[^\w\s-]/g,'').replace(/[\s_]+/g,'-').replace(/^-+|-+$/g,'');
}

function today() {
  return new Date().toISOString().split('T')[0];
}

let toastTimer;
function showToast(msg, type = 'ok') {
  toast.textContent = msg;
  toast.className   = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2400);
}

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  return res.json().catch(() => ({}));
}

// ─── Post list ────────────────────────────────────────────────────────────────

async function loadPosts() {
  typeHeading.textContent = SCHEMAS[state.type].label;
  postsGrid.innerHTML     = '<p style="color:#555;font-size:.75rem">Loading…</p>';
  state.posts = await api('GET', `/api/posts?type=${state.type}`);
  renderPostList();
}

function renderPostList() {
  if (!Array.isArray(state.posts) || !state.posts.length) {
    postsGrid.innerHTML = '<p style="color:#555;font-size:.75rem">No posts yet. Click <b>+ New</b> to create one.</p>';
    return;
  }
  postsGrid.innerHTML = '';
  for (const post of state.posts) {
    const card = document.createElement('div');
    card.className = 'post-card';

    let imgHTML = '';
    if (post.image) {
      const src = post.image.startsWith('/') ? post.image : `/images/artwork/${post.image}`;
      imgHTML = `<img class="post-card-image" src="${esc(src)}" loading="lazy" onerror="this.remove()">`;
    }

    const dateStr = post.date
      ? new Date(post.date + 'T00:00:00').toLocaleDateString('en-GB', { year:'numeric', month:'short', day:'numeric' })
      : '—';

    const badge   = post.draft
      ? '<span class="badge-draft">DRAFT</span>'
      : '<span class="badge-pub">✓</span>';

    const series  = post.series ? `<span class="post-card-series">${esc(post.series)}/</span>` : '';

    card.innerHTML = `
      ${imgHTML}
      <div class="post-card-title">${series}${esc(post.title)}</div>
      <div class="post-card-meta">${badge}<span>${esc(dateStr)}</span></div>
      ${post.excerpt ? `<div class="post-card-excerpt">${esc(post.excerpt)}</div>` : ''}
    `;
    card.addEventListener('click', () => openEdit(post.file));
    postsGrid.appendChild(card);
  }
}

// ─── Edit view ────────────────────────────────────────────────────────────────

async function openNew() {
  if (state.type === 'artwork') {
    state.artworkSeries = await api('GET', '/api/series?type=artwork') || [];
  }
  const schema = SCHEMAS[state.type];
  state.editing = {
    isNew:   true,
    file:    null,
    type:    state.type,
    data:    { ...schema.defaults, date: today() },
    content: '',
    series:  null,
  };
  revealEdit('New ' + schema.label + ' Post');
}

async function openEdit(file) {
  if (state.type === 'artwork') {
    state.artworkSeries = await api('GET', '/api/series?type=artwork') || [];
  }
  const { data, body } = await api('GET', `/api/post?file=${encodeURIComponent(file)}`);

  // Derive series from file path: src/posts/artwork/karat/foo.md → 'karat'
  let series = null;
  if (state.type === 'artwork') {
    const parts = file.split('/');
    if (parts.length >= 5) series = parts[parts.length - 2];
  }

  state.editing = { isNew: false, file, type: state.type, data: data || {}, content: body || '', series };
  revealEdit(data && (data.posttitle || data.title) ? (data.posttitle || data.title) : file);
}

function revealEdit(heading) {
  editHeading.textContent = heading;
  listView.classList.add('hidden');
  editView.classList.remove('hidden');

  $('btn-delete').classList.toggle('hidden', state.editing.isNew);
  buildForm();
  contentEd.value = state.editing.content;
  editForm.scrollTop = 0;
}

function backToList() {
  editView.classList.add('hidden');
  state.editing = null;
  if (atelierState.fromAtelier) {
    atelierState.fromAtelier = false;
    atelierView.classList.remove('hidden');
    if (atelierState.activeFolder) selectAtelierFolder(atelierState.activeFolder);
  } else {
    listView.classList.remove('hidden');
    loadPosts();
  }
}

// ─── Form builder ─────────────────────────────────────────────────────────────

function buildForm() {
  const { type, data, series, isNew } = state.editing;
  const schema = SCHEMAS[type];
  editForm.innerHTML = '';

  // ── Slug field ──
  const existingSlug = isNew ? '' : (state.editing.file || '').split('/').pop().replace('.md','');
  const slugEl = document.createElement('div');
  slugEl.className = 'field';
  const slugLocked = !isNew && type !== 'artwork';
  slugEl.innerHTML = `
    <label>Slug (filename)</label>
    <input type="text" id="field-slug" value="${esc(existingSlug)}"
           placeholder="auto-generated from title"
           ${slugLocked ? 'readonly style="opacity:.45"' : ''}>
    <div class="slug-note" id="slug-note">→ ${filePath(type, existingSlug, series)}</div>
  `;
  editForm.appendChild(slugEl);

  // ── Dynamic fields ──
  for (const field of schema.fields) {
    editForm.appendChild(buildField(field, data, series, type));
  }

  // ── Wire up slug auto-generation on title input ──
  const titleInput  = editForm.querySelector('[data-key="posttitle"]');
  const slugInput   = $('field-slug');
  const slugNote    = $('slug-note');
  const seriesInput = editForm.querySelector('[data-key="_series"]');

  const refreshSlugNote = () => {
    const s = (seriesInput && seriesInput.value !== '__new__') ? (seriesInput.value || null) : null;
    slugNote.textContent = '→ ' + filePath(type, slugInput.value || '…', s);
  };

  if ((isNew || type === 'artwork') && titleInput) {
    titleInput.addEventListener('input', () => {
      if (!slugInput._manual) slugInput.value = slugify(titleInput.value);
      refreshSlugNote();
    });
  }
  slugInput.addEventListener('input', () => { slugInput._manual = true; refreshSlugNote(); });
  if (seriesInput) seriesInput.addEventListener('change', refreshSlugNote);
}

function filePath(type, slug, series) {
  if (!slug) slug = '[slug]';
  if (type === 'artwork' && series) return `src/posts/artwork/${series}/${slug}.md`;
  return `src/posts/${type}/${slug}.md`;
}

function buildField(field, data, series, type) {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';

  if (field.type === 'checkbox') {
    wrapper.classList.add('checkbox-row');
  }

  // Label
  if (field.type !== 'checkbox') {
    const lbl = document.createElement('label');
    lbl.textContent = field.label;
    if (field.hint) {
      const hint = document.createElement('span');
      hint.className = 'field-hint';
      hint.textContent = ' (' + field.hint + ')';
      lbl.appendChild(hint);
    }
    wrapper.appendChild(lbl);
  }

  const val = field.isMetaField ? (series || '') : (data[field.key] !== undefined ? data[field.key] : '');

  switch (field.type) {
    case 'text': {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.dataset.key = field.key;
      inp.value = String(val || '');
      if (field.placeholder) inp.placeholder = field.placeholder;
      wrapper.appendChild(inp);
      break;
    }

    case 'date': {
      const inp = document.createElement('input');
      inp.type = 'date';
      inp.dataset.key = field.key;
      inp.value = val ? String(val).split('T')[0] : '';
      wrapper.appendChild(inp);
      break;
    }

    case 'textarea': {
      const ta = document.createElement('textarea');
      ta.dataset.key = field.key;
      ta.value = String(val || '');
      ta.rows = 3;
      wrapper.appendChild(ta);
      break;
    }

    case 'checkbox': {
      const inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.dataset.key = field.key;
      inp.checked = !!val;
      wrapper.appendChild(inp);
      const lbl = document.createElement('label');
      lbl.textContent = field.label;
      wrapper.appendChild(lbl);
      break;
    }

    case 'tags': {
      const existingTags = Array.isArray(val) ? val : (val ? String(val).split(/[,\s]+/).filter(Boolean) : []);
      wrapper.appendChild(buildTagsInput(field.key, existingTags));
      break;
    }

    case 'series': {
      const sel = document.createElement('select');
      sel.dataset.key = '_series';
      sel.innerHTML   = '<option value="">— No series —</option>';
      for (const s of state.artworkSeries) {
        const opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        if (s === series) opt.selected = true;
        sel.appendChild(opt);
      }
      const newOpt = document.createElement('option');
      newOpt.value = '__new__'; newOpt.textContent = '＋ New series…';
      sel.appendChild(newOpt);

      const newInp = document.createElement('input');
      newInp.type = 'text';
      newInp.dataset.key = '_series_new';
      newInp.placeholder = 'Series name';
      newInp.className   = 'hidden';
      newInp.style.marginTop = '0.3rem';

      sel.addEventListener('change', () => newInp.classList.toggle('hidden', sel.value !== '__new__'));
      wrapper.appendChild(sel);
      wrapper.appendChild(newInp);
      break;
    }

    case 'image': {
      // Drop zone
      wrapper.appendChild(buildImageDrop(field));

      // Cartridge generator shortcut for games posts
      if (type === 'games') {
        const cartBtn = document.createElement('button');
        cartBtn.type      = 'button';
        cartBtn.className = 'btn-secondary';
        cartBtn.style.cssText = 'margin-top:.35rem;font-size:.7rem;width:100%;text-align:center';
        cartBtn.textContent = '⬛ Generate Cartridge';
        cartBtn.addEventListener('click', openCartridgeOverlay);
        wrapper.appendChild(cartBtn);
      }

      // Show current image
      if (val) {
        const cur = document.createElement('div');
        cur.className = 'image-current';
        cur.textContent = 'Current: ' + String(val);
        wrapper.appendChild(cur);

        const preview = document.createElement('img');
        preview.className = 'image-preview';
        preview.src = field.imageOnly ? `/images/artwork/${val}` : String(val);
        preview.onerror = () => preview.remove();
        wrapper.appendChild(preview);
      }

      // Hidden store
      const hidden = document.createElement('input');
      hidden.type  = 'hidden';
      hidden.id    = `imgval-${field.key}`;
      hidden.dataset.key = field.key;
      hidden.value = String(val || '');
      wrapper.appendChild(hidden);
      break;
    }
  }

  return wrapper;
}

function buildTagsInput(key, initial) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tags-wrapper';
  wrapper.dataset.key = key;
  const tags = [...initial];

  const inp = document.createElement('input');
  inp.type      = 'text';
  inp.className = 'tag-input';
  inp.placeholder = tags.length ? '' : 'type and press Enter';
  wrapper.appendChild(inp);
  wrapper._tags = tags;

  const render = () => {
    wrapper.querySelectorAll('.tag-chip').forEach(c => c.remove());
    for (const tag of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.innerHTML  = `${esc(tag)}<button type="button">×</button>`;
      chip.querySelector('button').addEventListener('click', (e) => {
        e.stopPropagation();
        tags.splice(tags.indexOf(tag), 1);
        render();
      });
      wrapper.insertBefore(chip, inp);
    }
    wrapper._tags = tags;
    inp.placeholder = tags.length ? '' : 'type and press Enter';
  };

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = inp.value.trim().replace(/,+$/, '');
      if (v && !tags.includes(v)) { tags.push(v); inp.value = ''; render(); }
    } else if (e.key === 'Backspace' && !inp.value && tags.length) {
      tags.pop(); render();
    }
  });

  wrapper.addEventListener('click', () => inp.focus());
  render();
  return wrapper;
}

function buildImageDrop(field) {
  const drop = document.createElement('div');
  drop.className = 'image-drop';
  drop.innerHTML = `<span>Drop image here or click to browse</span>
                    <input type="file" accept="image/*">`;

  const upload = async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = async e => {
      const b64 = e.target.result.split(',')[1];
      const result = await api('POST', '/api/image', { folder: field.folder, name: file.name, data: b64 });
      if (!result.path) { showToast('Upload failed', 'err'); return; }

      const hidden = $(`imgval-${field.key}`);
      if (hidden) hidden.value = field.imageOnly ? file.name : result.path;

      // Refresh preview
      const wrapper = drop.closest('.field');
      wrapper.querySelectorAll('.image-preview').forEach(i => i.remove());
      const img    = document.createElement('img');
      img.className = 'image-preview';
      img.src       = result.path;
      wrapper.appendChild(img);

      // Update current label
      let cur = wrapper.querySelector('.image-current');
      if (!cur) { cur = document.createElement('div'); cur.className = 'image-current'; wrapper.insertBefore(cur, img); }
      cur.textContent = 'Current: ' + (field.imageOnly ? file.name : result.path);

      showToast(`Uploaded: ${file.name}`);
    };
    reader.readAsDataURL(file);
  };

  drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag-over'); upload(e.dataTransfer.files[0]); });
  drop.querySelector('input').addEventListener('change', e => upload(e.target.files[0]));

  return drop;
}

// ─── Collect form data ────────────────────────────────────────────────────────

function collectForm() {
  const { type, data: original } = state.editing;
  const schema  = SCHEMAS[type];
  const result  = { ...schema.defaults, ...original };

  for (const field of schema.fields) {
    if (field.isMetaField) continue;
    switch (field.type) {
      case 'text':
      case 'date': {
        const inp = editForm.querySelector(`[data-key="${field.key}"]`);
        if (inp) { result[field.key] = inp.value || undefined; }
        break;
      }
      case 'textarea': {
        const ta = editForm.querySelector(`[data-key="${field.key}"]`);
        if (ta) result[field.key] = ta.value || undefined;
        break;
      }
      case 'checkbox': {
        const inp = editForm.querySelector(`[data-key="${field.key}"]`);
        result[field.key] = inp ? inp.checked : false;
        if (!result[field.key]) delete result[field.key];
        break;
      }
      case 'tags': {
        const tw = editForm.querySelector(`.tags-wrapper[data-key="${field.key}"]`);
        if (tw && tw._tags) {
          result[field.key] = tw._tags.length === 1 ? tw._tags[0] : (tw._tags.length > 1 ? tw._tags : undefined);
        }
        break;
      }
      case 'image': {
        const h = $(`imgval-${field.key}`);
        if (h && h.value) result[field.key] = h.value;
        break;
      }
    }
  }

  // Resolve series
  const seriesSel = editForm.querySelector('[data-key="_series"]');
  let series = state.editing.series;
  if (seriesSel) {
    if (seriesSel.value === '__new__') {
      const ni = editForm.querySelector('[data-key="_series_new"]');
      series = ni && ni.value ? slugify(ni.value) : null;
    } else {
      series = seriesSel.value || null;
    }
  }

  // Drop undefined / empty
  for (const k of Object.keys(result)) {
    if (result[k] === undefined || result[k] === null || result[k] === '') delete result[k];
  }

  return { data: result, series };
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function savePost() {
  const { isNew, file, type } = state.editing;
  const { data, series }      = collectForm();
  const content = contentEd.value;

  const slugInput = $('field-slug');
  const slug      = slugInput.value.trim() || slugify(data.posttitle || '');
  if (!slug) { showToast('Title / slug required', 'err'); return; }

  const schema = SCHEMAS[type];
  if (schema.extraFM) Object.assign(data, schema.extraFM(slug));

  let res;
  if (isNew) {
    res = await api('POST', '/api/post', { type, slug, series, data, content });
    if (res.file) {
      showToast('Created!');
      state.editing.isNew   = false;
      state.editing.file    = res.file;
      state.editing.series  = series;
      if (type !== 'artwork') { slugInput.readOnly = true; slugInput.style.opacity = '.45'; }
      $('btn-delete').classList.remove('hidden');
      editHeading.textContent = data.posttitle || slug;
    } else {
      showToast(res.error || 'Error creating post', 'err');
    }
  } else {
    const existingSlug = file.split('/').pop().replace('.md', '');
    const body = { file, data, content };
    if (type === 'artwork' && slug !== existingSlug) body.newSlug = slug;
    res = await api('PUT', '/api/post', body);
    if (res.ok) {
      showToast('Saved!');
      if (res.file) state.editing.file = res.file;
      editHeading.textContent = data.posttitle || file;
    } else {
      showToast(res.error || 'Error saving', 'err');
    }
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

async function deletePost() {
  const { file } = state.editing;
  if (!file || !confirm(`Delete ${file}?`)) return;
  await api('DELETE', `/api/post?file=${encodeURIComponent(file)}`);
  showToast('Deleted');
  backToList();
}

// ─── Build ────────────────────────────────────────────────────────────────────

async function triggerBuild() {
  buildOutput.textContent = 'Running npm run build…\n(thumbnails + eleventy)\n';
  buildOverlay.classList.remove('hidden');
  const r = await api('POST', '/api/build');
  buildOutput.textContent = r.output || '(no output)';
  buildOutput.scrollTop   = buildOutput.scrollHeight;
  if (r.ok) showToast('Build complete!');
  else      showToast('Build failed — check log', 'err');
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.type    = tab.dataset.type;
    state.editing = null;
    atelierState.fromAtelier = false;
    editView.classList.add('hidden');

    if (state.type === 'artwork') {
      listView.classList.add('hidden');
      atelierView.classList.remove('hidden');
      loadAtelier();
    } else {
      atelierView.classList.add('hidden');
      listView.classList.remove('hidden');
      loadPosts();
    }
  });
});

$('btn-new').addEventListener('click', openNew);
$('btn-back').addEventListener('click', backToList);
$('btn-save').addEventListener('click', savePost);
$('btn-delete').addEventListener('click', deletePost);
$('btn-build').addEventListener('click', triggerBuild);
$('btn-close-overlay').addEventListener('click', () => buildOverlay.classList.add('hidden'));

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && state.editing) {
    e.preventDefault();
    savePost();
  }
  if (e.key === 'Escape' && !buildOverlay.classList.contains('hidden')) {
    buildOverlay.classList.add('hidden');
  }
});

// ─── Cartridge Generator ─────────────────────────────────────────────────────

const cartridgeOverlay = $('cartridge-overlay');
const cartridgeCanvas  = $('cartridge-canvas');

const CART = {
  baseList:     Array.from({ length: 8 },  (_, i) => `base-${i + 1}.png`),
  coverList:    Array.from({ length: 16 }, (_, i) => `cover-${i + 1}.png`),
  selectedBase:  'base-1.png',
  selectedCover: 'cover-1.png',
  initialized:   false,
};

function openCartridgeOverlay() {
  cartridgeOverlay.classList.remove('hidden');
  if (!CART.initialized) cartInit();
  else cartDraw();
}

function cartInit() {
  CART.initialized = true;
  cartBuildOptions('cart-baseOptions',  CART.baseList,  'base',  'cart-base',  n => { CART.selectedBase  = n; cartDraw(); });
  cartBuildOptions('cart-coverOptions', CART.coverList, 'cover', 'cart-cover', n => { CART.selectedCover = n; cartDraw(); });
  ['cart-baseColor', 'cart-accentColor', 'cart-borderColor'].forEach(id => $(id).addEventListener('input', cartDraw));
  document.querySelectorAll('.cart-rand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = $(btn.dataset.cartRand);
      if (t) { t.value = '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0'); cartDraw(); }
    });
  });
  $('btn-cart-randomize').addEventListener('click', cartRandomize);
  $('btn-cart-save').addEventListener('click', cartSave);
  $('btn-close-cartridge').addEventListener('click', () => cartridgeOverlay.classList.add('hidden'));
  cartDraw();
}

function cartBuildOptions(containerId, items, folder, groupName, onSelect) {
  const container = $(containerId);
  items.forEach((filename, i) => {
    const input    = document.createElement('input');
    input.type     = 'radio';
    input.name     = groupName;
    input.id       = `${groupName}-${filename}`;
    input.value    = filename;
    if (i === 0) input.checked = true;
    const img      = document.createElement('img');
    img.src        = `/images/microgame/${folder}/${filename}`;
    img.alt        = filename;
    const label    = document.createElement('label');
    label.htmlFor  = input.id;
    label.appendChild(input);
    label.appendChild(img);
    input.addEventListener('change', () => onSelect(filename));
    container.appendChild(label);
  });
}

function cartLoadImage(src) {
  return new Promise(resolve => { const i = new Image(); i.onload = () => resolve(i); i.src = src; });
}

function cartHex(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function cartColorizeBase(img, hex) {
  const c = document.createElement('canvas'); c.width = 28; c.height = 26;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, 28, 26);
  const [r, g, b] = cartHex(hex);
  for (let i = 0; i < d.data.length; i += 4) {
    if (d.data[i+3] > 0 && !(d.data[i] === 0 && d.data[i+1] === 0 && d.data[i+2] === 0)) {
      d.data[i] = r; d.data[i+1] = g; d.data[i+2] = b;
    }
  }
  x.putImageData(d, 0, 0); return c;
}

function cartColorizeCover(img, accentHex, borderHex) {
  const c = document.createElement('canvas'); c.width = 28; c.height = 26;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, 28, 26);
  const [ar, ag, ab] = cartHex(accentHex);
  const [br, bg, bb] = cartHex(borderHex);
  for (let i = 0; i < d.data.length; i += 4) {
    const [r, g, b, a] = [d.data[i], d.data[i+1], d.data[i+2], d.data[i+3]];
    if (a === 0) continue;
    if (r === 255 && g === 255 && b === 255) { d.data[i]=br; d.data[i+1]=bg; d.data[i+2]=bb; }
    else if (r === 0 && g === 0 && b === 0)  { d.data[i+3] = 0; }
    else { d.data[i]=ar; d.data[i+1]=ag; d.data[i+2]=ab; }
  }
  x.putImageData(d, 0, 0); return c;
}

async function cartDraw() {
  const ctx = cartridgeCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 112, 104);
  const [baseImg, coverImg] = await Promise.all([
    cartLoadImage(`/images/microgame/base/${CART.selectedBase}`),
    cartLoadImage(`/images/microgame/cover/${CART.selectedCover}`),
  ]);
  ctx.drawImage(cartColorizeBase(baseImg, $('cart-baseColor').value), 0, 0, 28, 26, 0, 0, 112, 104);
  ctx.drawImage(cartColorizeCover(coverImg, $('cart-accentColor').value, $('cart-borderColor').value), 0, 0, 28, 26, 0, 0, 112, 104);
}

function cartRandomize() {
  const rndHex = () => '#' + Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
  CART.selectedBase  = CART.baseList[Math.floor(Math.random()  * CART.baseList.length)];
  CART.selectedCover = CART.coverList[Math.floor(Math.random() * CART.coverList.length)];
  $(`cart-base-${CART.selectedBase}`).checked  = true;
  $(`cart-cover-${CART.selectedCover}`).checked = true;
  $('cart-baseColor').value   = rndHex();
  $('cart-accentColor').value = rndHex();
  $('cart-borderColor').value = rndHex();
  cartDraw();
}

async function cartSave() {
  const slug = $('field-slug').value.trim() || 'cartridge';
  const name = `${slug}.png`;
  const b64  = cartridgeCanvas.toDataURL('image/png').split(',')[1];
  const result = await api('POST', '/api/image', { folder: 'src/images/home', name, data: b64 });
  if (!result.path) { showToast('Save failed', 'err'); return; }

  const hidden = $('imgval-image');
  if (hidden) hidden.value = result.path;

  const form = document.getElementById('edit-form');
  form.querySelectorAll('.image-preview').forEach(el => el.remove());
  const preview   = document.createElement('img');
  preview.className = 'image-preview';
  preview.src       = result.path + '?t=' + Date.now();
  const cur = form.querySelector('.image-current');
  if (cur) { cur.textContent = 'Current: ' + name; cur.after(preview); }
  else { form.appendChild(preview); }

  cartridgeOverlay.classList.add('hidden');
  showToast(`Saved: ${name}`);
}

// ─── Atelier (artwork category browser) ──────────────────────────────────────

async function loadAtelier() {
  $('folder-list').innerHTML = '<li style="color:#555;font-size:.7rem;padding:.3rem .5rem">Loading…</li>';
  atelierState.folders = await api('GET', '/api/atelier/folders') || [];
  renderFolderList();

  if (atelierState.folders.length > 0) {
    const name = (atelierState.activeFolder && atelierState.folders.find(f => f.name === atelierState.activeFolder))
      ? atelierState.activeFolder
      : atelierState.folders[0].name;
    await selectAtelierFolder(name);
  } else {
    $('atelier-folder-name').textContent = 'no folders yet';
    $('atelier-grid').innerHTML = '<p style="color:#555;font-size:.75rem;grid-column:1/-1">Drop an image to create your first entry.</p>';
  }
}

function renderFolderList() {
  const ul = $('folder-list');
  ul.innerHTML = '';
  for (const folder of atelierState.folders) {
    const li = document.createElement('li');
    li.className = 'folder-item' + (folder.name === atelierState.activeFolder ? ' active' : '');

    const nameSpan  = document.createElement('span');
    nameSpan.className   = 'folder-name';
    nameSpan.textContent = folder.name;
    const countSpan = document.createElement('span');
    countSpan.className   = 'folder-count';
    countSpan.textContent = folder.count;
    li.appendChild(nameSpan);
    li.appendChild(countSpan);

    li.addEventListener('click', () => selectAtelierFolder(folder.name));

    // Drag-onto-folder support
    li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('drag-over'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', e => {
      e.preventDefault();
      li.classList.remove('drag-over');
      atelierState.activeFolder = folder.name;
      renderFolderList();
      $('atelier-folder-name').textContent = folder.name;
      $('atelier-drop-label').textContent = `Drop images here to add to "${folder.name}"`;
      atelierQuickAdd(Array.from(e.dataTransfer.files));
    });

    ul.appendChild(li);
  }
}

async function selectAtelierFolder(name) {
  atelierState.activeFolder = name;
  renderFolderList();
  $('atelier-folder-name').textContent = name;
  $('atelier-drop-label').textContent  = `Drop images here to add to "${name}"`;
  $('atelier-grid').innerHTML = '<p style="color:#555;font-size:.7rem;grid-column:1/-1">Loading…</p>';

  atelierState.folderPosts = await api('GET', `/api/atelier/posts?folder=${encodeURIComponent(name)}`) || [];
  renderAtelierGrid();
}

function renderAtelierGrid() {
  const grid  = $('atelier-grid');
  const count = atelierState.folderPosts.length;
  $('atelier-folder-count').textContent = count ? `(${count})` : '';

  if (!count) {
    grid.innerHTML = '<p style="color:#555;font-size:.75rem;grid-column:1/-1">No artwork here yet. Drop images below to add some.</p>';
    return;
  }

  grid.innerHTML = '';
  for (const post of atelierState.folderPosts) {
    const thumb = document.createElement('div');
    thumb.className = 'atelier-thumb';

    if (post.image) {
      const img     = document.createElement('img');
      img.loading   = 'lazy';
      img.alt       = post.title;
      img.src       = `/images/artwork/thumbnails/${post.image}`;
      img.onerror   = () => { img.onerror = null; img.src = `/images/artwork/${post.image}`; };
      thumb.appendChild(img);
    } else {
      const empty = document.createElement('div');
      empty.className   = 'atelier-thumb-empty';
      empty.textContent = 'no image';
      thumb.appendChild(empty);
    }

    const info     = document.createElement('div');
    info.className = 'atelier-thumb-info';
    info.textContent = post.title || post.slug;
    thumb.appendChild(info);

    if (post.draft) {
      const badge       = document.createElement('button');
      badge.className   = 'atelier-thumb-draft';
      badge.textContent = 'DRAFT';
      badge.title       = 'Click to publish';
      badge.addEventListener('click', async e => {
        e.stopPropagation();
        const { data, body } = await api('GET', `/api/post?file=${encodeURIComponent(post.file)}`);
        delete data.draft;
        const r = await api('PUT', '/api/post', { file: post.file, data, content: body || '' });
        if (r.ok) {
          post.draft = false;
          badge.remove();
          showToast('Published!');
        } else {
          showToast(r.error || 'Failed', 'err');
        }
      });
      thumb.appendChild(badge);
    }

    thumb.addEventListener('click', () => {
      atelierState.fromAtelier = true;
      state.type = 'artwork';
      openEdit(post.file);
    });
    grid.appendChild(thumb);
  }
}

async function atelierQuickAdd(files) {
  let folder = atelierState.activeFolder;

  if (!folder) {
    const name = prompt('Enter a folder name for this image:');
    if (!name || !name.trim()) return;
    folder = name.trim();
    if (!atelierState.folders.find(f => f.name === folder)) {
      atelierState.folders.push({ name: folder, count: 0 });
    }
    atelierState.activeFolder = folder;
    renderFolderList();
    $('atelier-folder-name').textContent = folder;
    $('atelier-drop-label').textContent  = `Drop images here to add to "${folder}"`;
  }

  let added = 0;
  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;
    const b64 = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result.split(',')[1]);
      reader.readAsDataURL(file);
    });

    const result = await api('POST', '/api/atelier/quick', { folder, imageData: b64, fileName: file.name });
    if (result.file) {
      added++;
      atelierState.folderPosts.unshift({
        file:   result.file,
        slug:   result.slug,
        series: result.series,
        title:  result.title,
        image:  result.image,
        date:   result.date,
        draft:  true,
        data:   result.data,
      });
      const f = atelierState.folders.find(x => x.name === folder);
      if (f) f.count++;
    } else {
      showToast(`Failed: ${file.name}`, 'err');
    }
  }

  if (added > 0) {
    showToast(`Added ${added} image${added > 1 ? 's' : ''}`);
    renderAtelierGrid();
    renderFolderList();
  }
}

// Atelier event wiring
const atelierDrop      = $('atelier-drop');
const atelierFileInput = $('atelier-file-input');

atelierDrop.addEventListener('dragover',  e => { e.preventDefault(); atelierDrop.classList.add('drag-over'); });
atelierDrop.addEventListener('dragleave', () => atelierDrop.classList.remove('drag-over'));
atelierDrop.addEventListener('drop', e => {
  e.preventDefault();
  atelierDrop.classList.remove('drag-over');
  atelierQuickAdd(Array.from(e.dataTransfer.files));
});
atelierFileInput.addEventListener('change', e => {
  atelierQuickAdd(Array.from(e.target.files));
  e.target.value = '';
});

$('btn-new-folder').addEventListener('click', () => {
  const name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  const trimmed = name.trim();
  if (!atelierState.folders.find(f => f.name === trimmed)) {
    atelierState.folders.push({ name: trimmed, count: 0 });
  }
  renderFolderList();
  selectAtelierFolder(trimmed);
});

$('btn-atelier-cleanup').addEventListener('click', async () => {
  if (!confirm('Rename all artwork files + images to match their titles?')) return;
  const r = await api('POST', '/api/atelier/cleanup');
  if (!r.ok) { showToast('Cleanup failed', 'err'); return; }
  if (r.count === 0) {
    showToast('All names already clean');
  } else {
    showToast(`Renamed ${r.count} post${r.count > 1 ? 's' : ''}`);
    atelierState.folders = await api('GET', '/api/atelier/folders') || [];
    renderFolderList();
    if (atelierState.activeFolder) await selectAtelierFolder(atelierState.activeFolder);
  }
});

$('btn-atelier-new').addEventListener('click', () => {
  atelierState.fromAtelier = true;
  state.type = 'artwork';
  openNew();
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

loadPosts();
