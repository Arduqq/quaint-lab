# Skylanders Archive: Lightweight Default View + URL Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Skylanders archive's initial load from rendering every image across every game at once, and add hash-based routing so browser back/forward works across archive views.

**Architecture:** Both changes live entirely inside `scripts/reclassify-tumblr.mjs`'s client-side script template (the giant backtick-delimited `html` string the script generates — both the curation and published archive pages come from this one template, gated only by the existing `PUBLISH` flag for edit affordances). Task 1 adds a `viewAll` flag and a new lightweight landing branch in `renderGrid()`. Task 2 adds hash read/write around the existing single `render()` chokepoint.

**Tech Stack:** Plain vanilla JS (no framework, no build step for this file beyond Node string templating), Eleventy for the surrounding site.

## Global Constraints

- This entire feature is edited inside an **outer JS template literal** (the `html` variable in `reclassify-tumblr.mjs`). Any `${...}` you write inside the region you're editing gets evaluated by the *outer* Node script at generation time, not left as literal text for the browser — this is intentional and already used (e.g. `'<span class="cnt">${total}</span>'` at the existing "All Images" sidebar entry bakes in the build-time `total` count). Do **not** write a literal backtick or an unintended `${` inside your edits, and reuse `${total}` (not a new client-side variable) anywhere you need the total image count.
- Do not use template-literal/backtick syntax for your *own* string-building — use `+` concatenation, matching every existing handler in this file (e.g. `'#' + sel.game + '/' + sel.cat`).
- The existing `#model=`/`#texture=` deep link (`src/pages/server/skylanders/models/model-viewer.js:44-50,459,540`) and `#pose=` deep link (`scripts/reclassify-tumblr.mjs:3245`, inside this same template) must keep working completely unchanged. Your new hash logic must never read or write the hash while `mvActive` or `poseDetailChar` is truthy.
- "Do not ever remove anything" — the existing "All Images" full-dump behavior, the Backgrounds/Details annotation filters, the per-character index, and the per-game dashboard must all keep working exactly as today.
- Search text (`query`) is intentionally excluded from the hash scheme.
- No test framework exists in this project. Verification is manual/scripted via `curl`, `grep`, one-shot builds of `npx @11ty/eleventy`, `node -e` snippets for pure-logic checks, and `npx playwright screenshot --browser=webkit` for visual checks (this session's established convention — WebKit, not Chromium).

---

### Task 1: `viewAll` flag + lightweight landing view

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1984` (add `viewAll` declaration)
- Modify: `scripts/reclassify-tumblr.mjs:2032` (the "All Images" sidebar click handler)
- Modify: `scripts/reclassify-tumblr.mjs:2041-2046` (the Backgrounds/Details annotation-filter click handler)
- Modify: `scripts/reclassify-tumblr.mjs:2750` (insert two new functions, `renderLanding()` and `showAllImages()`, right after `renderDashboard()`'s closing brace, before `function renderGrid()`)
- Modify: `scripts/reclassify-tumblr.mjs` inside `renderGrid()` (insert a new early-return branch right after the existing dashboard branch, before `lbImgs = [];`)

**Interfaces:**
- Produces: a module-level `let viewAll = false;` flag, and a `showAllImages()` function (`sel = {game:null,cat:null,char:null}; annFilter=null; mvActive=false; viewAll=true; render();`) that Task 2's hash parser will also call when it sees `#all`.
- Consumes: nothing from later tasks.

- [ ] **Step 1: Add the `viewAll` flag**

Find this exact block (`scripts/reclassify-tumblr.mjs:1984-1987`):

```js
let sel     = {game: null, cat: null, char: null};
let lastPanelChar = null; // tracks which character the metadata strip/3D viewer were built for
let lastProfileChar = null; // tracks which character #char-profile-rebuild's containers exist for
let annFilter = null; // null | 'background' | 'detail' — cross-cutting annotation filter
```

Replace with:

```js
let sel     = {game: null, cat: null, char: null};
let viewAll = false; // true only when the user explicitly asked to see every image across every game
let lastPanelChar = null; // tracks which character the metadata strip/3D viewer were built for
let lastProfileChar = null; // tracks which character #char-profile-rebuild's containers exist for
let annFilter = null; // null | 'background' | 'detail' — cross-cutting annotation filter
```

- [ ] **Step 2: Update the "All Images" sidebar handler to use the new shared function**

Find this exact block (`scripts/reclassify-tumblr.mjs:2029-2032`):

```js
  const allEl = document.createElement('div');
  allEl.className = 'sb-all' + (sel.game === null && sel.cat === null && !sel.char && !annFilter ? ' on' : '');
  allEl.innerHTML = '<span>All Images</span><span class="cnt">${total}</span>';
  allEl.addEventListener('click', () => { sel = {game:null, cat:null, char:null}; annFilter = null; mvActive = false; render(); });
```

Replace with:

```js
  const allEl = document.createElement('div');
  allEl.className = 'sb-all' + (sel.game === null && sel.cat === null && !sel.char && !annFilter ? ' on' : '');
  allEl.innerHTML = '<span>All Images</span><span class="cnt">${total}</span>';
  allEl.addEventListener('click', showAllImages);
```

- [ ] **Step 3: Reset `viewAll` when toggling an annotation filter**

Find this exact block (`scripts/reclassify-tumblr.mjs:2041-2046`):

```js
    annEl.addEventListener('click', () => {
      annFilter = (annFilter === ann ? null : ann);
      sel = {game: null, cat: null, char: null};
      mvActive = false;
      render();
    });
```

Replace with:

```js
    annEl.addEventListener('click', () => {
      annFilter = (annFilter === ann ? null : ann);
      sel = {game: null, cat: null, char: null};
      mvActive = false;
      viewAll = false;
      render();
    });
```

(Every other place that sets `sel` gives it a non-null `game`, `cat`, or `char` — those branches never reach the landing/all-images dispatch at all, so `viewAll`'s value can't affect them. These two handlers are the only ones that can produce the fully-empty `sel` the landing dispatch checks for.)

- [ ] **Step 4: Add `renderLanding()` and `showAllImages()`**

Find the end of `renderDashboard()` and the start of `renderGrid()` — this exact block:

```js
  if (editing) {
    const formHost = document.createElement('div'); formHost.id = 'dash-add-form-host';
    main.appendChild(formHost);
  }
}

function renderGrid() {
```

Replace with:

```js
  if (editing) {
    const formHost = document.createElement('div'); formHost.id = 'dash-add-form-host';
    main.appendChild(formHost);
  }
}

function showAllImages() {
  sel = {game: null, cat: null, char: null};
  annFilter = null;
  mvActive = false;
  viewAll = true;
  render();
}

function renderLanding() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  const wrap = document.createElement('div'); wrap.id = 'landing';
  const msg = document.createElement('p');
  msg.textContent = 'Pick a game from the sidebar to start browsing.';
  const link = document.createElement('a');
  link.href = '#all';
  link.id = 'landing-all';
  link.textContent = 'Browse everything (${total} images)';
  link.addEventListener('click', e => { e.preventDefault(); showAllImages(); });
  wrap.append(msg, link);
  main.appendChild(wrap);
}

function renderGrid() {
```

- [ ] **Step 5: Add the landing dispatch branch in `renderGrid()`**

Find this exact block (the existing per-game dashboard branch, immediately followed by the start of the slow path):

```js
  if (sel.game && sel.cat === null && !sel.char && !annFilter && !query) {
    lastProfileChar = null;
    main.classList.remove('char-mode');
    renderDashboard(sel.game);
    return;
  }

  lbImgs = [];
  let shown = 0;
```

Replace with:

```js
  if (sel.game && sel.cat === null && !sel.char && !annFilter && !query) {
    lastProfileChar = null;
    main.classList.remove('char-mode');
    renderDashboard(sel.game);
    return;
  }

  if (!sel.game && !sel.cat && !sel.char && !annFilter && !query && !viewAll) {
    lastProfileChar = null;
    main.classList.remove('char-mode');
    renderLanding();
    return;
  }

  lbImgs = [];
  let shown = 0;
```

This is the entire fix: the old final `else` branch in `renderGrid()` (the one that loops `GO` and builds a card for every image) is untouched — it's now only reached when `viewAll` is `true`, reproducing today's exact "All Images" behavior, or when `query` is non-empty (search-the-whole-archive, also unchanged).

- [ ] **Step 6: Build and confirm the new code is present**

```bash
npx @11ty/eleventy
grep -c "function renderLanding" dist/server/skylanders/archive/index.html
grep -c "function showAllImages" dist/server/skylanders/archive/index.html
grep -o "Pick a game from the sidebar to start browsing\." dist/server/skylanders/archive/index.html
```

Expected: `1`, `1`, and one matching line for the message text.

- [ ] **Step 7: Visual check of the new default state**

```bash
npx @11ty/eleventy --serve --port=8080 &
sleep 3
npx playwright screenshot --browser=webkit http://localhost:8080/server/skylanders/archive/ /tmp/archive-landing.png
```

Open `/tmp/archive-landing.png` (Read tool). Confirm: the sidebar renders normally (game list, "All Images" entry, etc.) but the main content area shows only the short message and the "Browse everything (`<N>` images)" link — not a long grid of images. Stop the dev server when done: find its PID with `lsof -ti :8080` and `kill` it.

- [ ] **Step 8: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: stop Skylanders archive from rendering every image on initial load"
```

---

### Task 2: Hash-based routing across archive views

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:3136` (the `render()` function — add a `syncHash();` call)
- Modify: `scripts/reclassify-tumblr.mjs` (insert `hashFromState()`, `syncHash()`, and `parseHash()` immediately before `function render()`)
- Modify: `scripts/reclassify-tumblr.mjs` (the bootstrap tail, immediately before the existing `#pose=` parsing block — insert a `parseHash()` call and a `popstate` listener)

**Interfaces:**
- Consumes: `viewAll`, `showAllImages()` from Task 1 (already committed); `sel`, `annFilter`, `mvActive`, `poseDetailChar`, `expanded`, `GO`, `SKYLANDERS`, `TREE` (all pre-existing module-level state/data in this file).
- Produces: nothing further tasks depend on — this is the last task in the plan.

- [ ] **Step 1: Add `hashFromState()`, `syncHash()`, and `parseHash()`**

Find this exact block (`scripts/reclassify-tumblr.mjs:3134-3136`):

```js
}

function render() { renderSidebar(); renderGrid(); renderCharPanel(); if (tagModeOn) refreshTagOverlays(); }
```

Replace with:

```js
}

let _navigatingFromHistory = false;

function hashFromState() {
  if (mvActive || poseDetailChar) return null; // those features manage the hash themselves
  if (annFilter) return '#ann/' + annFilter;
  if (sel.char) return '#char/' + encodeURIComponent(sel.char);
  if (viewAll) return '#all';
  if (sel.game && sel.cat) return '#' + sel.game + '/' + sel.cat;
  if (sel.game) return '#' + sel.game;
  return '#';
}

function syncHash() {
  const next = hashFromState();
  if (next === null) return;
  if (location.hash === next) return;
  if (_navigatingFromHistory) return;
  history.pushState(null, '', next);
}

function parseHash() {
  const h = location.hash;
  if (/^#(model|texture|pose)=/.test(h)) return; // owned by model-viewer.js / the pose-editor deep link below

  const annMatch = h.match(/^#ann\/(background|detail)$/);
  const charMatch = h.match(/^#char\/(.+)$/);
  const pathMatch = h.match(/^#([^/]+)(?:\/([^/]+))?$/);

  if (h === '#all') {
    sel = {game: null, cat: null, char: null};
    annFilter = null;
    viewAll = true;
    return;
  }
  if (annMatch) {
    sel = {game: null, cat: null, char: null};
    annFilter = annMatch[1];
    viewAll = false;
    return;
  }
  if (charMatch) {
    const name = decodeURIComponent(charMatch[1]);
    const sky = SKYLANDERS.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (sky) {
      sel = {game: null, cat: null, char: sky.name.toLowerCase()};
      annFilter = null;
      viewAll = false;
      return;
    }
  } else if (pathMatch && pathMatch[1]) {
    const game = pathMatch[1];
    const cat = pathMatch[2];
    if (GO.includes(game)) {
      if (!cat || (TREE[game] && TREE[game][cat])) {
        sel = {game, cat: cat || null, char: null};
        annFilter = null;
        viewAll = false;
        expanded.add(game);
        return;
      }
    }
  }

  // Empty hash, or anything that didn't match a valid state above: landing.
  sel = {game: null, cat: null, char: null};
  annFilter = null;
  viewAll = false;
}

function render() {
  renderSidebar();
  renderGrid();
  renderCharPanel();
  if (tagModeOn) refreshTagOverlays();
  syncHash();
}
```

- [ ] **Step 2: Verify the pure logic with `node -e` (no browser needed)**

```bash
node -e "
let sel = {game: null, cat: null, char: null};
let viewAll = false;
let annFilter = null;
let mvActive = false;
let poseDetailChar = null;
const GO = ['imaginators', 'lost-islands'];
const TREE = { imaginators: { 'character-art': [1] } };
const SKYLANDERS = [{ name: 'Spyro' }];
const expanded = new Set();

function hashFromState() {
  if (mvActive || poseDetailChar) return null;
  if (annFilter) return '#ann/' + annFilter;
  if (sel.char) return '#char/' + encodeURIComponent(sel.char);
  if (viewAll) return '#all';
  if (sel.game && sel.cat) return '#' + sel.game + '/' + sel.cat;
  if (sel.game) return '#' + sel.game;
  return '#';
}

let location = { hash: '' };
function parseHash() {
  const h = location.hash;
  if (/^#(model|texture|pose)=/.test(h)) return;
  const annMatch = h.match(/^#ann\/(background|detail)\$/);
  const charMatch = h.match(/^#char\/(.+)\$/);
  const pathMatch = h.match(/^#([^/]+)(?:\/([^/]+))?\$/);
  if (h === '#all') { sel = {game:null,cat:null,char:null}; annFilter=null; viewAll=true; return; }
  if (annMatch) { sel = {game:null,cat:null,char:null}; annFilter=annMatch[1]; viewAll=false; return; }
  if (charMatch) {
    const name = decodeURIComponent(charMatch[1]);
    const sky = SKYLANDERS.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (sky) { sel = {game:null,cat:null,char:sky.name.toLowerCase()}; annFilter=null; viewAll=false; return; }
  } else if (pathMatch && pathMatch[1]) {
    const game = pathMatch[1]; const cat = pathMatch[2];
    if (GO.includes(game)) {
      if (!cat || (TREE[game] && TREE[game][cat])) {
        sel = {game, cat: cat||null, char: null}; annFilter=null; viewAll=false; expanded.add(game); return;
      }
    }
  }
  sel = {game:null,cat:null,char:null}; annFilter=null; viewAll=false;
}

const checks = [];

sel = {game:'imaginators', cat:'character-art', char:null};
checks.push(['game+cat', hashFromState() === '#imaginators/character-art']);

sel = {game:null,cat:null,char:'spyro'}; annFilter=null;
checks.push(['char', hashFromState() === '#char/spyro']);

sel = {game:null,cat:null,char:null}; viewAll = true;
checks.push(['all', hashFromState() === '#all']);

mvActive = true;
checks.push(['mv-active-suppressed', hashFromState() === null]);
mvActive = false; viewAll = false;

location.hash = '#imaginators/character-art';
parseHash();
checks.push(['parse game+cat', sel.game === 'imaginators' && sel.cat === 'character-art']);

location.hash = '#char/Spyro';
parseHash();
checks.push(['parse char', sel.char === 'spyro']);

location.hash = '#all';
parseHash();
checks.push(['parse all', viewAll === true]);

location.hash = '#not-a-real-game';
parseHash();
checks.push(['parse invalid falls back to landing', sel.game === null && sel.cat === null && sel.char === null && viewAll === false]);

location.hash = '#pose=Spyro';
sel = {game:'imaginators', cat:null, char:null};
parseHash();
checks.push(['pose hash left untouched', sel.game === 'imaginators']);

let failed = false;
for (const [name, ok] of checks) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
"
```

Expected: every line prints `PASS: ...`, exit code 0. (This script re-implements `hashFromState`/`parseHash` inline with mock `location`/state rather than importing the file, since the real functions live inside a generated-HTML template string, not an importable module — the logic is copy-identical to Step 1's code, just with the regex `$`-escaping doubled for the shell heredoc.)

- [ ] **Step 3: Wire `parseHash()` into the bootstrap**

Find this exact block (the bootstrap tail, right before the existing `#pose=` parsing):

```js
{
  const m = location.hash.match(/^#pose=(.+)$/);
  const sky = m && SKYLANDERS.find(s => s.name === decodeURIComponent(m[1]));
  if (sky) {
    if (window.ProfileModelViewer) openPoseDetail(sky);
    else window.addEventListener('DOMContentLoaded', () => openPoseDetail(sky), { once: true });
  }
}
render();
</script>
```

Replace with:

```js
parseHash();
window.addEventListener('popstate', () => {
  _navigatingFromHistory = true;
  parseHash();
  render();
  _navigatingFromHistory = false;
});

{
  const m = location.hash.match(/^#pose=(.+)$/);
  const sky = m && SKYLANDERS.find(s => s.name === decodeURIComponent(m[1]));
  if (sky) {
    if (window.ProfileModelViewer) openPoseDetail(sky);
    else window.addEventListener('DOMContentLoaded', () => openPoseDetail(sky), { once: true });
  }
}
render();
</script>
```

- [ ] **Step 4: Build and confirm the new code is present**

```bash
npx @11ty/eleventy
grep -c "function parseHash" dist/server/skylanders/archive/index.html
grep -c "function syncHash" dist/server/skylanders/archive/index.html
grep -c "addEventListener('popstate'" dist/server/skylanders/archive/index.html
```

Expected: `1`, `1`, `1`.

- [ ] **Step 5: Visual check of direct deep-links**

```bash
npx @11ty/eleventy --serve --port=8080 &
sleep 3
npx playwright screenshot --browser=webkit "http://localhost:8080/server/skylanders/archive/#imaginators/character-art" /tmp/archive-deeplink-category.png
npx playwright screenshot --browser=webkit "http://localhost:8080/server/skylanders/archive/#all" /tmp/archive-deeplink-all.png
npx playwright screenshot --browser=webkit "http://localhost:8080/server/skylanders/archive/#not-a-real-game" /tmp/archive-deeplink-invalid.png
```

Open all three screenshots (Read tool). Confirm: the first shows the Imaginators category-art grid directly (with that section expanded/highlighted in the sidebar), the second shows the full all-games dump (same as clicking "All Images"), and the third shows the landing message (graceful fallback, no errors). Stop the dev server when done.

- [ ] **Step 6: Manual interactive check (no scripted browser-automation tool is available in this environment for click+back-button sequences — describe what you did and observed)**

Open `http://localhost:8080/server/skylanders/archive/` in an actual browser. Click a game in the sidebar, then a category, then a character from the "By Character" list. At each step, note the address bar's hash. Then use the browser's back button three times and confirm each step reverses correctly (category → game → landing) with the sidebar's highlighted/expanded state matching. Then open the embedded 3D model viewer and the pose editor (if reachable from this view) and confirm their own `#model=`/`#texture=`/`#pose=` hashes still work and aren't overwritten by this feature.

- [ ] **Step 7: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: add hash-based routing across Skylanders archive views"
```

## Self-Review Notes

- **Spec coverage:** Section 1 (state→slug mapping) → Task 2 Step 1 (`hashFromState`/`parseHash`). Section 2 (`viewAll` flag) → Task 1 Steps 1-3. Section 3 (landing content) → Task 1 Steps 4-5. Section 4 (`syncHash`) → Task 2 Step 1. Section 5 (`parseHash` validation) → Task 2 Step 1. Section 6 (`popstate`) → Task 2 Step 3. Error Handling section's four cases are all exercised by Task 2 Step 2's `node -e` checks (invalid hash → landing fallback, `#pose=` left untouched) and Step 5/6's visual/manual checks (model-viewer/pose-editor non-collision, rapid navigation via pushState's no-op-when-unchanged guard).
- **Placeholder scan:** no TBD/TODO; every step shows complete, runnable code or a fully-specified manual procedure.
- **Type consistency:** `viewAll`, `showAllImages()`, `renderLanding()` (Task 1) are referenced by exact name in Task 2's `hashFromState()`/`parseHash()` without redefinition. `sel`, `annFilter`, `mvActive`, `poseDetailChar`, `expanded`, `GO`, `TREE`, `SKYLANDERS` are all pre-existing names confirmed against the current file, not invented.
