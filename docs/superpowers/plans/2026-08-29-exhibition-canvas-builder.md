# Exhibition Canvas Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a freeform canvas exhibition editor inside Studio — place artwork/text/background on a fixed-size stage, save it, and have it render publicly at the exact same visual fidelity (WYSIWYG).

**Architecture:** Two new per-exhibition files (`{slug}.md` metadata + `{slug}.canvas.json` element array) are read/written by four new REST endpoints on `studio/server.js`. One shared stylesheet (`src/css/exhibition-canvas.css`) defines how a placed element actually looks (position/size/rotation/opacity via inline styles it targets, typography via its rules) and is loaded by both the public Eleventy template and Studio's builder page (via a new `/css/*` static passthrough on the Studio server) — so there is exactly one source of truth for element appearance. The builder itself is hand-rolled vanilla JS (pointer events, CSS transforms), matching Studio's existing zero-dependency frontend.

**Tech Stack:** Plain Node.js `http` server (no framework), vanilla JS frontend, Eleventy v3 for the public site, no new npm dependencies, no test runner in this repo (manual verification, matching project convention).

**Spec:** `docs/superpowers/specs/2026-08-29-exhibition-canvas-builder-design.md`

## Global Constraints

- No new npm dependencies — hand-rolled vanilla JS only (Approach A from the spec), no vendored libraries.
- Public exhibition pages never reflow across screen sizes — the fixed-size stage scales as a single unit (`transform: scale(ratio)`), positions are never reinterpreted per-breakpoint.
- **Coordinate contract (binds every task below): `x`/`y` on an element represent its CENTER point**, not its top-left corner. Screen/DOM position is always derived as `left = x - width/2`, `top = y - height/2`. This is what makes rotation (which pivots around the CSS default transform-origin of 50% 50%, i.e. the element's own center) and rotation-aware resizing tractable — see Task 4.
- Exactly one stylesheet, `src/css/exhibition-canvas.css`, governs how a placed element looks (its box, its image, its text). Both the public template and the Studio builder page load this same file via `/css/exhibition-canvas.css`. Builder-only CSS (selection outlines, handles, panels) lives in a separate file and must never set properties that affect a *published* element's appearance (position/size/rotation/opacity/color/font already come from inline styles the shared file targets).
- No automated test suite exists in this repo (no test runner configured, no test files anywhere) — every task's verification is manual, run against a real browser and/or `curl`.

---

## Task 1: Backend — Exhibition CRUD API + CSS passthrough

**Files:**
- Modify: `studio/server.js` (add helpers after `scanPosts()`, add routes inside `handleAPI`, add a static passthrough alongside the existing `/images/*` one)

**Interfaces:**
- Consumes: existing `ROOT`, `fs`, `path`, `send()`, `parseFM()`, `dumpFM()`, `parseBody()`, `safeAbs()` (all already defined in `server.js`).
- Produces (consumed by Task 3 and Task 5):
  - `GET /api/exhibitions` → `200` `[{ "slug": "karat", "title": "Karat Exhibition" }, ...]`
  - `GET /api/exhibition?slug=X` → `200` `{ "meta": { "slug": "X", "title": "...", "canvasWidth": 1600, "canvasHeight": 1000, "background": "#1a1a2e" }, "elements": [ /* array, see Task 4 for element shape */ ] }`, or `404` if the slug doesn't exist
  - `POST /api/exhibition` body `{ slug, title, canvasWidth, canvasHeight, background }` → `201` same shape as GET (with `"elements": []`), or `409` if the slug already exists
  - `PUT /api/exhibition` body `{ slug, meta: { title, canvasWidth, canvasHeight, background }, elements: [...] }` → `200 { "ok": true }`, or `404` if the slug doesn't exist
  - `/css/*` static passthrough serving files from `src/css/`, mirroring the existing `/images/*` passthrough

- [ ] **Step 1: Add exhibition file-path and read/write helpers**

Insert after `scanPosts()` (after line 151 in the pre-Task-1 file), before the `// ─── API handlers ───` comment:

```js
// ─── Exhibitions ───────────────────────────────────────────────────────────────

const EXHIBITIONS_DIR = path.join(ROOT, 'src/posts/exhibitions');

function exhibitionPaths(slug) {
  return {
    md:   path.join(EXHIBITIONS_DIR, `${slug}.md`),
    json: path.join(EXHIBITIONS_DIR, `${slug}.canvas.json`),
  };
}

function listExhibitions() {
  if (!fs.existsSync(EXHIBITIONS_DIR)) return [];
  return fs.readdirSync(EXHIBITIONS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const slug = f.replace(/\.md$/, '');
      const { data } = parseFM(fs.readFileSync(path.join(EXHIBITIONS_DIR, f), 'utf-8'));
      return { slug, title: data.posttitle || slug };
    });
}

function readExhibition(slug) {
  const { md, json } = exhibitionPaths(slug);
  if (!fs.existsSync(md)) return null;
  const { data } = parseFM(fs.readFileSync(md, 'utf-8'));
  let elements = [];
  try {
    elements = JSON.parse(fs.readFileSync(json, 'utf-8'));
  } catch {
    elements = [];
  }
  return {
    meta: {
      slug,
      title:       data.posttitle || slug,
      canvasWidth:  data.canvasWidth  || 1600,
      canvasHeight: data.canvasHeight || 1000,
      background:   data.background  || '#1a1a2e',
    },
    elements,
  };
}

function writeExhibition(slug, meta, elements) {
  const { md, json } = exhibitionPaths(slug);
  if (!fs.existsSync(EXHIBITIONS_DIR)) fs.mkdirSync(EXHIBITIONS_DIR, { recursive: true });
  const data = {
    title:       'Exhibition',
    posttitle:   meta.title,
    layout:      'exhibition-canvas.njk',
    permalink:   `atelier/${slug}/`,
    canvasWidth:  meta.canvasWidth,
    canvasHeight: meta.canvasHeight,
    background:   meta.background,
  };
  fs.writeFileSync(md, `${dumpFM(data)}\n`);
  fs.writeFileSync(json, JSON.stringify(elements, null, 2));
}
```

- [ ] **Step 2: Add the four exhibition routes**

Insert right after the `/api/atelier/quick` handler (after the block ending around line 397 in the pre-Task-1 file) and before the final `send(res, 404, { error: 'No such route' });`:

```js
  // GET /api/exhibitions
  if (method === 'GET' && pathname === '/api/exhibitions') {
    return send(res, 200, listExhibitions());
  }

  // GET /api/exhibition?slug=X
  if (method === 'GET' && pathname === '/api/exhibition') {
    if (!params.slug) return send(res, 400, { error: 'Missing slug' });
    const ex = readExhibition(params.slug);
    if (!ex) return send(res, 404, { error: 'Not found' });
    return send(res, 200, ex);
  }

  // POST /api/exhibition  { slug, title, canvasWidth, canvasHeight, background }
  if (method === 'POST' && pathname === '/api/exhibition') {
    const { slug, title, canvasWidth, canvasHeight, background } = await parseBody(req);
    if (!slug || !title) return send(res, 400, { error: 'Missing slug or title' });
    const { md } = exhibitionPaths(slug);
    if (fs.existsSync(md)) return send(res, 409, { error: 'Slug already exists' });
    writeExhibition(slug, {
      title,
      canvasWidth:  canvasWidth  || 1600,
      canvasHeight: canvasHeight || 1000,
      background:   background   || '#1a1a2e',
    }, []);
    return send(res, 201, readExhibition(slug));
  }

  // PUT /api/exhibition  { slug, meta, elements }
  if (method === 'PUT' && pathname === '/api/exhibition') {
    const { slug, meta, elements } = await parseBody(req);
    if (!slug) return send(res, 400, { error: 'Missing slug' });
    const { md } = exhibitionPaths(slug);
    if (!fs.existsSync(md)) return send(res, 404, { error: 'Not found' });
    writeExhibition(slug, meta, elements || []);
    return send(res, 200, { ok: true });
  }
```

- [ ] **Step 3: Add the `/css/*` static passthrough**

In the main `http.createServer` handler, right after the existing `/images/*` block (the one reading from `path.join(ROOT, 'src', u.pathname)`) and before the `// Static files from studio/public/` comment, add:

```js
  // Serve site CSS so Studio's builder can share the exact same stylesheet as the public site
  if (u.pathname.startsWith('/css/')) {
    const cssPath = path.join(ROOT, 'src', u.pathname);
    if (fs.existsSync(cssPath) && fs.lstatSync(cssPath).isFile()) {
      res.writeHead(200, { 'Content-Type': 'text/css' });
      return fs.createReadStream(cssPath).pipe(res);
    }
  }
```

- [ ] **Step 4: Verify manually**

`src/css/exhibition-canvas.css` doesn't exist yet (Task 2 creates it) — create an empty placeholder just for this verification, then delete it:

```bash
mkdir -p src/css && touch src/css/exhibition-canvas.css
node studio/server.js &
sleep 1
curl -s http://localhost:3001/css/exhibition-canvas.css -o /dev/null -w "%{http_code}\n"   # expect 200
curl -s -X POST http://localhost:3001/api/exhibition -H "Content-Type: application/json" \
  -d '{"slug":"test-ex","title":"Test Exhibition","canvasWidth":1600,"canvasHeight":1000,"background":"#111111"}' \
  | python3 -m json.tool
curl -s http://localhost:3001/api/exhibitions | python3 -m json.tool
curl -s "http://localhost:3001/api/exhibition?slug=test-ex" | python3 -m json.tool
curl -s -X PUT http://localhost:3001/api/exhibition -H "Content-Type: application/json" \
  -d '{"slug":"test-ex","meta":{"title":"Test Exhibition","canvasWidth":1600,"canvasHeight":1000,"background":"#222222"},"elements":[{"id":"el-1","type":"text","x":800,"y":500,"width":200,"rotation":0,"zIndex":1,"opacity":1,"content":"hi","fontSize":16,"color":"#fff","align":"left"}]}' \
  | python3 -m json.tool
curl -s "http://localhost:3001/api/exhibition?slug=test-ex" | python3 -m json.tool   # confirm the PUT round-tripped
kill %1
rm -rf src/posts/exhibitions/test-ex.md src/posts/exhibitions/test-ex.canvas.json src/css/exhibition-canvas.css
```

Expected: the CSS passthrough returns `200`; POST creates the exhibition and returns it with `elements: []`; the exhibitions list includes it; the PUT-then-GET round-trip shows the saved element back exactly as sent.

- [ ] **Step 5: Commit**

```bash
git add studio/server.js
git commit -m "feat: add exhibition CRUD API and CSS passthrough to Studio"
```

---

## Task 2: Public rendering — shared CSS + Eleventy canvas template

**Files:**
- Create: `src/css/exhibition-canvas.css`
- Create: `src/_includes/exhibition-canvas.njk`
- Modify: `.eleventy.js` (add a `canvasElements` filter and register the new stylesheet's passthrough copy)

**Interfaces:**
- Consumes: the `{slug}.md` frontmatter fields written by Task 1 (`canvasWidth`, `canvasHeight`, `background`, `posttitle`, `permalink`), and the `{slug}.canvas.json` element array (shape defined fully in Task 4, but this task only needs to read the common fields every element has: `id`, `type`, `x`, `y`, `width`, `height`, `rotation`, `zIndex`, `opacity`, plus `src` for images or `content`/`fontSize`/`color`/`align` for text).
- Produces (consumed by Task 3+, which loads the exact same CSS file for WYSIWYG): the `.ex-stage`, `.ex-el`, `.ex-el-image`, `.ex-el-text` CSS classes, and the coordinate-to-CSS mapping (`left = x - width/2`, `top = y - height/2`, per the Global Constraints coordinate contract).

- [ ] **Step 1: Write the shared stylesheet**

Create `src/css/exhibition-canvas.css`:

```css
/* ─── Exhibition canvas — shared between the public site and Studio's builder ── */

.ex-stage-wrap {
  width: 100%;
  overflow: hidden;
}

.ex-stage {
  position: relative;
  transform-origin: top left;
}

.ex-el {
  position: absolute;
}

.ex-el-image img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.ex-el-image img.ex-broken {
  background: #333;
  outline: 2px dashed #900;
}

.ex-el-text .ex-text-content {
  width: 100%;
  height: 100%;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  font-family: inherit;
}
```

- [ ] **Step 2: Write the Eleventy canvas template**

Create `src/_includes/exhibition-canvas.njk`:

```njk
---
posttitle: "{{ title }}"
layout: simple-base.njk
---
{% block nav %}
  <a href="/atelier/"><span>Back to Atelier</span></a>
{% endblock %}

<link rel="stylesheet" href="/css/exhibition-canvas.css">

{% set exElements = fileSlug | canvasElements %}

<div class="ex-stage-wrap" id="ex-stage-wrap-{{ fileSlug }}">
  <div class="ex-stage" id="ex-stage-{{ fileSlug }}"
       style="width:{{ canvasWidth }}px; height:{{ canvasHeight }}px; background:{{ background }};">
    {% for el in exElements %}
      {% if el.type == "image" %}
        <div class="ex-el ex-el-image"
             style="left:{{ el.x - (el.width / 2) }}px; top:{{ el.y - (el.height / 2) }}px;
                    width:{{ el.width }}px; height:{{ el.height }}px;
                    transform:rotate({{ el.rotation }}deg); z-index:{{ el.zIndex }}; opacity:{{ el.opacity }};">
          <img src="/images/artwork/{{ el.src }}" alt=""
               onerror="this.classList.add('ex-broken')">
        </div>
      {% elif el.type == "text" %}
        <div class="ex-el ex-el-text"
             style="left:{{ el.x - (el.width / 2) }}px; top:{{ el.y - 20 }}px;
                    width:{{ el.width }}px;
                    transform:rotate({{ el.rotation }}deg); z-index:{{ el.zIndex }}; opacity:{{ el.opacity }};">
          <div class="ex-text-content"
               style="font-size:{{ el.fontSize }}px; color:{{ el.color }}; text-align:{{ el.align }};">{{ el.content }}</div>
        </div>
      {% endif %}
    {% endfor %}
  </div>
</div>

<script>
(function () {
  var wrap  = document.getElementById('ex-stage-wrap-{{ fileSlug }}');
  var stage = document.getElementById('ex-stage-{{ fileSlug }}');
  var canvasWidth = {{ canvasWidth }};
  function fit() {
    var ratio = wrap.clientWidth / canvasWidth;
    stage.style.transform = 'scale(' + ratio + ')';
    wrap.style.height = ({{ canvasHeight }} * ratio) + 'px';
  }
  window.addEventListener('resize', fit);
  fit();
})();
</script>

<a href="/atelier/"><span>Back to Atelier</span></a>
```

Note on the text element's `top`: unlike images (whose height is known up front), a text box's height is automatic based on content, so there's nothing to divide by 2 — `el.y - 20` gives a reasonable fixed vertical offset so the text's vertical center roughly lands near `y` for typical short captions. This matches how Task 4's builder positions the same text element (see Task 4 Step 4).

- [ ] **Step 3: Add the `canvasElements` filter to `.eleventy.js`**

Find the `eleventyConfig.addFilter("slug", slugify);` line (around line 29) and add after it:

```js
  eleventyConfig.addFilter("canvasElements", function(slug) {
    const jsonPath = path.join(__dirname, "src/posts/exhibitions", `${slug}.canvas.json`);
    try {
      return JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } catch (e) {
      console.warn(`[exhibition-canvas] Could not read/parse ${jsonPath}: ${e.message}`);
      return [];
    }
  });
```

(`path` and `fs` are already required at the top of `.eleventy.js` — confirmed by the existing `blinkies` collection a few lines below, which already uses both.)

- [ ] **Step 4: Manually verify with a hand-built test exhibition**

```bash
mkdir -p src/posts/exhibitions
cat > src/posts/exhibitions/test-canvas.md << 'EOF'
---
title: Exhibition
posttitle: "Test Canvas"
layout: exhibition-canvas.njk
permalink: "atelier/test-canvas/"
canvasWidth: 1600
canvasHeight: 1000
background: "#1a1a2e"
---
EOF
cat > src/posts/exhibitions/test-canvas.canvas.json << 'EOF'
[
  { "id": "el-1", "type": "image", "src": "does-not-exist.png", "x": 400, "y": 300, "width": 300, "height": 400, "rotation": -8, "zIndex": 1, "opacity": 1 },
  { "id": "el-2", "type": "text", "content": "Hello exhibition", "x": 900, "y": 300, "width": 250, "rotation": 0, "zIndex": 2, "opacity": 1, "fontSize": 24, "color": "#eeeeee", "align": "left" }
]
EOF
npx @11ty/eleventy --serve --port 8083 &
sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8083/atelier/test-canvas/
curl -s http://localhost:8083/atelier/test-canvas/ | grep -o 'class="ex-el[^"]*"' | sort | uniq -c
lsof -ti:8083 | xargs -r kill
rm -rf src/posts/exhibitions/test-canvas.md src/posts/exhibitions/test-canvas.canvas.json
```

Expected: `200`, and the grep shows one `ex-el ex-el-image` and one `ex-el ex-el-text`. Then load `http://localhost:8083/atelier/test-canvas/` in an actual browser (rebuild/re-serve if you closed the background server) and confirm: the rotated placeholder box shows a broken-image outline (since `does-not-exist.png` is intentionally missing — this proves the broken-image fallback from the spec's Error Handling section), the text renders at 24px, and resizing the browser window rescales the whole stage proportionally without any element changing position relative to the others.

- [ ] **Step 5: Commit**

```bash
git add src/css/exhibition-canvas.css src/_includes/exhibition-canvas.njk .eleventy.js
git commit -m "feat: add public canvas exhibition template and shared stylesheet"
```

---

## Task 3: Builder shell — Exhibitions tab, list, create, read-only open

**Files:**
- Modify: `studio/public/index.html` (new tab, new `#exhibitions-view` and `#exhibition-editor-view` containers, new `<link>`/`<script>` tags)
- Create: `studio/public/exhibition-builder.css`
- Create: `studio/public/exhibition-builder.js`
- Modify: `studio/public/app.js` (wire the new tab into the existing tab-click handler)

**Interfaces:**
- Consumes: Task 1's `GET /api/exhibitions`, `GET /api/exhibition?slug=X`, `POST /api/exhibition`; Task 2's `/css/exhibition-canvas.css` (loaded directly by `index.html`, giving the builder canvas the exact same element-rendering rules as the public page); existing `api(method, url, body)` and `esc(s)` helpers from `app.js`.
- Produces (consumed by Task 4 and Task 5):
  - Module-level state object in `exhibition-builder.js`: `exState = { meta: null, elements: [], selectedId: null }`
  - `loadExhibitionsList()` — fetches and renders the list view
  - `openExhibitionEditor(slug)` — loads one exhibition into `exState` and renders the canvas
  - `renderExhibitionCanvas()` — full re-render of `exState.elements` into the DOM (Task 4 calls this after every mutation)
  - DOM ids: `#exhibitions-view`, `#exhibitions-list`, `#btn-new-exhibition`, `#exhibition-editor-view`, `#exhibition-palette`, `#exhibition-canvas-wrap`, `#exhibition-canvas`, `#exhibition-properties`, `#btn-exhibition-back`

- [ ] **Step 1: Add the Exhibitions tab and view containers to `index.html`**

Add a new tab button to the `.type-tabs` nav (after the existing tabs, before the closing `</nav>`):

```html
    <button class="tab" data-type="exhibitions">Exhibitions</button>
```

Add the stylesheet and script tags in `<head>` / before `</body>` — add this `<link>` right after the existing `<link rel="stylesheet" href="style.css">`:

```html
  <link rel="stylesheet" href="/css/exhibition-canvas.css">
  <link rel="stylesheet" href="exhibition-builder.css">
```

Add the two new view containers inside `<main id="main-view">`, after the existing `<!-- Home view -->` block and before `<!-- List view -->`:

```html
    <!-- Exhibitions: list view -->
    <div id="exhibitions-view" class="hidden">
      <div class="list-header">
        <h2>Exhibitions</h2>
        <button id="btn-new-exhibition" class="btn-primary">+ New</button>
      </div>
      <div id="exhibitions-list" class="posts-grid"></div>
    </div>

    <!-- Exhibitions: canvas editor -->
    <div id="exhibition-editor-view" class="hidden">
      <div class="exhibition-toolbar">
        <button id="btn-exhibition-back" class="btn-secondary">← Back</button>
        <span id="exhibition-editor-title" class="section-label"></span>
        <div style="flex:1"></div>
        <button id="btn-add-text" class="btn-secondary">+ Text</button>
        <label class="exhibition-bg-label">bg <input type="color" id="exhibition-bg-color" value="#1a1a2e"></label>
        <button id="btn-save-exhibition" class="btn-primary">Save</button>
      </div>
      <div class="exhibition-editor-layout">
        <div id="exhibition-palette" class="exhibition-palette"></div>
        <div id="exhibition-canvas-wrap" class="exhibition-canvas-wrap">
          <div id="exhibition-canvas" class="ex-stage"></div>
        </div>
        <div id="exhibition-properties" class="exhibition-properties">
          <p class="dashboard-unavailable">Select an element to edit its properties.</p>
        </div>
      </div>
    </div>

    <script src="exhibition-builder.js"></script>
```

(The `<script>` tag goes here, before the existing `<script src="app.js"></script>` at the very end of `<body>`, so `exhibition-builder.js`'s functions exist in global scope before `app.js` references them in its tab handler.)

- [ ] **Step 2: Write the builder's own CSS**

Create `studio/public/exhibition-builder.css`:

```css
/* ─── Exhibition builder — editor-only chrome, never affects published look ── */

.exhibition-toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.exhibition-bg-label {
  font-size: 0.7rem;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.exhibition-editor-layout {
  display: flex;
  height: calc(100% - 48px);
  overflow: hidden;
}

.exhibition-palette {
  width: 160px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 0.5rem;
  border-right: 1px solid var(--border);
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.4rem;
  align-content: start;
}

.exhibition-palette img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  cursor: grab;
  border: 1px solid var(--border);
}

.exhibition-canvas-wrap {
  flex: 1;
  overflow: auto;
  background: repeating-conic-gradient(var(--surface2) 0% 25%, var(--bg) 0% 50%) 50% / 24px 24px;
  padding: 2rem;
}

.exhibition-properties {
  width: 220px;
  flex-shrink: 0;
  overflow-y: auto;
  padding: 0.6rem;
  border-left: 1px solid var(--border);
  font-size: 0.75rem;
}

.exhibition-properties .field-row { margin-bottom: 0.5rem; }
.exhibition-properties label { display: block; color: var(--muted); margin-bottom: 0.15rem; }
.exhibition-properties input { width: 100%; }

.ex-el.ex-selected {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  cursor: move;
}
```

- [ ] **Step 3: Write `exhibition-builder.js` (list, create, load, read-only render)**

Create `studio/public/exhibition-builder.js`:

```js
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
```

`slugify`, `api`, `esc`, and `showToast` are already defined in `app.js`, which loads after this file — but since these are called from *event handlers* that only run after both scripts have executed and the user has interacted with the page, not from top-level code in this file, the load order (`exhibition-builder.js` before `app.js`) is safe: by the time any of these functions actually run, `app.js` has already finished defining them.

- [ ] **Step 4: Wire the new tab into `app.js`'s tab click handler**

Replace the tab click handler (the one already modified by the earlier dashboard plan, currently handling `home`/`artwork`/else):

```js
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.type    = tab.dataset.type;
    state.editing = null;
    atelierState.fromAtelier = false;
    cameFromHome  = false;
    editView.classList.add('hidden');
    document.getElementById('exhibitions-view').classList.add('hidden');
    document.getElementById('exhibition-editor-view').classList.add('hidden');

    if (state.type === 'home') {
      listView.classList.add('hidden');
      atelierView.classList.add('hidden');
      homeView.classList.remove('hidden');
      loadDashboard();
    } else if (state.type === 'exhibitions') {
      homeView.classList.add('hidden');
      listView.classList.add('hidden');
      atelierView.classList.add('hidden');
      document.getElementById('exhibitions-view').classList.remove('hidden');
      loadExhibitionsList();
    } else if (state.type === 'artwork') {
      homeView.classList.add('hidden');
      listView.classList.add('hidden');
      atelierView.classList.remove('hidden');
      loadAtelier();
    } else {
      homeView.classList.add('hidden');
      atelierView.classList.add('hidden');
      listView.classList.remove('hidden');
      loadPosts();
    }
  });
});
```

- [ ] **Step 5: Verify manually**

```bash
npm run studio
```
Open `http://localhost:3001`, click the **Exhibitions** tab, click **+ New**, name it "Test Exhibition". Confirm: it opens the editor view with an empty dark canvas at the right background color, the left palette shows thumbnails from your artwork library, and clicking **← Back** returns to a list that now includes "Test Exhibition". Then, using `curl`, `PUT` a couple of elements onto it directly (same command shape as Task 1 Step 4) and reopen it in the UI — confirm the image and text render in their correct positions, sizes, and rotation (read-only at this point; interactivity is Task 4). Delete the test exhibition's two files afterward.

- [ ] **Step 6: Commit**

```bash
git add studio/public/index.html studio/public/exhibition-builder.css studio/public/exhibition-builder.js studio/public/app.js
git commit -m "feat: add Exhibitions tab with list, create, and read-only canvas view"
```

---

## Task 4: Interactive manipulation — select, drag, resize, rotate, layering, add elements

**Files:**
- Modify: `studio/public/exhibition-builder.js` (all additions; append new functions, wire them into `buildElementDOM`)

**Interfaces:**
- Consumes: `exState`, `renderExhibitionCanvas()`, `buildElementDOM(el)`, `EX_EDIT_SCALE` (all from Task 3); existing `esc()` from `app.js`.
- Produces (consumed by Task 5): a fully mutable `exState.elements` array kept in sync with the DOM and the properties panel; `selectElement(id)`; `renderProperties()`.

**Element shape (the full contract, referenced by Task 1/2/5 too):**
```js
// image
{ id, type: 'image', src, x, y, width, height, rotation, zIndex, opacity }
// text
{ id, type: 'text', content, x, y, width, rotation, zIndex, opacity, fontSize, color, align }
```
`x`/`y` are the element's **center**, per the plan's Global Constraints.

- [ ] **Step 1: Add id generation, selection, and the properties panel**

Append to `studio/public/exhibition-builder.js`:

```js
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
```

- [ ] **Step 2: Add "Add Text" and palette drag-to-add**

Append:

```js
// ─── Adding elements ────────────────────────────────────────────────────────────

function addTextElement() {
  const el = {
    id: newElId(), type: 'text', content: 'New text', x: exState.meta.canvasWidth / 2, y: exState.meta.canvasHeight / 2,
    width: 240, rotation: 0, zIndex: exState.elements.length + 1, opacity: 1,
    fontSize: 20, color: '#eeeeee', align: 'left',
  };
  exState.elements.push(el);
  selectElement(el.id);
}

function addImageElement(file) {
  const el = {
    id: newElId(), type: 'image', src: file,
    x: exState.meta.canvasWidth / 2, y: exState.meta.canvasHeight / 2,
    width: 300, height: 300, rotation: 0, zIndex: exState.elements.length + 1, opacity: 1,
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
```

- [ ] **Step 3: Add drag-to-move**

Append:

```js
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
```

- [ ] **Step 4: Add resize handles (rotation-aware) and the rotate handle**

Append:

```js
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
```

- [ ] **Step 5: Wire drag + selection handles into `buildElementDOM`**

Modify `buildElementDOM` (from Task 3) — replace its final two lines (`if (el.id === exState.selectedId) wrap.classList.add('ex-selected'); return wrap;`) with:

```js
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('ex-handle') || e.target.classList.contains('ex-rotate-handle')) return;
    startElementDrag(el, e);
  });

  if (el.id === exState.selectedId) {
    wrap.classList.add('ex-selected');
    addSelectionHandles(wrap, el);
  }
  return wrap;
```

- [ ] **Step 6: Verify manually**

Run `npm run studio`, open the Exhibitions tab, open a test exhibition. Confirm:
1. Clicking a palette thumbnail adds it to the canvas, selected, with resize/rotate handles visible.
2. Dragging the element body moves it; the properties panel's X/Y update live.
3. Dragging each of the 8 resize handles resizes correctly *from the correct anchor point*, including when the element has a non-zero rotation (rotate it first, then resize — the opposite corner should stay visually fixed).
4. Dragging the rotate handle spins the element smoothly around its own center.
5. "+ Text" adds an editable text box; typing in the properties panel's Text field updates it live.
6. Front/Back buttons visibly reorder overlapping elements.
7. Delete removes the element and clears the properties panel.

- [ ] **Step 7: Commit**

```bash
git add studio/public/exhibition-builder.js
git commit -m "feat: add interactive drag/resize/rotate/layering to exhibition builder"
```

---

## Task 5: Save, error handling, and end-to-end verification

**Files:**
- Modify: `studio/public/exhibition-builder.js` (add save wiring)

**Interfaces:**
- Consumes: Task 1's `PUT /api/exhibition`; Task 4's fully-populated `exState`.
- Produces: nothing further downstream — this is the last task in Phase 1.

- [ ] **Step 1: Wire the Save button**

Append to `studio/public/exhibition-builder.js`:

```js
// ─── Save ─────────────────────────────────────────────────────────────────────

async function saveExhibition() {
  const r = await api('PUT', '/api/exhibition', {
    slug: exState.meta.slug,
    meta: {
      title:        exState.meta.title,
      canvasWidth:  exState.meta.canvasWidth,
      canvasHeight: exState.meta.canvasHeight,
      background:   exState.meta.background,
    },
    elements: exState.elements,
  });
  if (r.error) { showToast(r.error, 'err'); return; }
  showToast('Exhibition saved!');
}

document.getElementById('btn-save-exhibition').addEventListener('click', saveExhibition);
```

- [ ] **Step 2: Verify the full round trip**

```bash
npm run studio
```
In the browser: create a new exhibition, add two images and one text block, drag/resize/rotate them into a deliberately asymmetric arrangement, set a background color, click **Save**, confirm the toast. Click **← Back**, then reopen the same exhibition from the list — confirm every element reappears in exactly the position/size/rotation/opacity/layer you left it in.

- [ ] **Step 3: Verify broken-image handling end-to-end**

With the same exhibition still open, use Studio's Artwork tab (or `mv` on disk) to rename one of the images you placed. Reload the exhibition in the builder — confirm the broken-image outline (`.ex-broken`, from Task 2's CSS) appears instead of a crash. Then build the public site (`npx @11ty/eleventy`) and load the exhibition's public URL — confirm the same broken-image treatment appears there too, and the rest of the page still renders normally. Rename the image back afterward.

- [ ] **Step 4: Verify malformed-JSON resilience at build time**

```bash
echo "{ not valid json" > src/posts/exhibitions/<your-test-slug>.canvas.json
npx @11ty/eleventy 2>&1 | tail -20
```
Expected: a `[exhibition-canvas] Could not read/parse ...` warning in the build log (from Task 2's filter), the build completes successfully (exit code 0), and that one exhibition's page renders with an empty stage rather than failing the whole build. Restore or delete the test file afterward.

- [ ] **Step 5: Clean up any test exhibitions created during this plan's verification**

```bash
rm -rf src/posts/exhibitions/test-*.md src/posts/exhibitions/test-*.canvas.json
```

- [ ] **Step 6: Commit**

```bash
git add studio/public/exhibition-builder.js
git commit -m "feat: wire exhibition save and verify error-handling end to end"
```
