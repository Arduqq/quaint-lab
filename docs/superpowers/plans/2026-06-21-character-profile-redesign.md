# Character Profile Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the form-like, 3-column character profile view (sidebar + center pane + side metadata panel) with a single consolidated trading-card-style profile pane, in both the curation editor and the published site.

**Architecture:** All work is in `scripts/reclassify-tumblr.mjs`. Today, `renderCharProfile()` (always rebuilds, into `#main`) and `renderCharPanel()` (memoized per-character, into a separate `#char-panel` column) have genuinely different rebuild lifecycles — that split exists to avoid wiping in-progress form input and avoid remounting the expensive 3D model viewer on every incidental re-render (e.g. typing in the global search box). Task 1 preserves both lifecycles exactly, but gives them sibling DOM containers inside one `#main` pane, visually ordered via CSS `order` (not DOM order) so the result reads as one consolidated, normally-scrolling profile. Tasks 2-4 then restyle the content inside those containers into the trading-card design, without touching the lifecycle mechanism again.

**Tech Stack:** Vanilla DOM/JS generated via template-literal strings inside a Node `.mjs` script, no build step, no framework, no test framework (verification is manual via the curation server + Playwright/webkit).

## Global Constraints

- No new files, no new dependencies — every change is inside `scripts/reclassify-tumblr.mjs`.
- Same template serves curation and published builds — `PUBLISH` keeps gating only edit affordances inline, exactly as today. No separate published-only branch.
- No data model or API changes — same `sky` fields, same `/api/update-character` payload shape, same `saveCharField`/`saveCharFieldRaw`/`saveCharPanel` functions internally unchanged.
- The 3D model viewer (`renderProfileModelViewer`) must not be destroyed/remounted on every incidental re-render — only when the selected character actually changes. Same for in-progress metadata-form input (species/gender/role/extra fields, checkboxes) — must survive unrelated re-renders (e.g. typing in the global search box while the panel is open).
- Every existing empty/edge-case state (no render, no element, no figures/abilityIcons/variants/model, character not in roster) must keep working, just restyled.
- Avoid Google Chrome for any browser-based testing — use Playwright's `webkit` browser type.

---

## Task 1: Layout consolidation (lifecycle-preserving)

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1357-1358` (`#layout`/`.has-panel` CSS)
- Modify: `scripts/reclassify-tumblr.mjs:1408-1412` (`#main`/`#char-panel` CSS)
- Modify: `scripts/reclassify-tumblr.mjs:1859-1912` (layout HTML: remove `<aside id="char-panel">`)
- Modify: `scripts/reclassify-tumblr.mjs:1970` (add a new tracking variable next to `lastPanelChar`)
- Modify: `scripts/reclassify-tumblr.mjs:2706-2716` (`renderGrid`'s pose-detail branch — remove dead `has-panel` clear)
- Modify: `scripts/reclassify-tumblr.mjs:2734-2792` (`renderGrid`'s clearing/branching logic)
- Modify: `scripts/reclassify-tumblr.mjs:2321-2366` (`renderCharProfile` — target a new sub-container instead of `#main` directly)
- Modify: `scripts/reclassify-tumblr.mjs:2808-2903` (`renderCharPanel` — target new containers instead of `#char-panel`)

**Interfaces:**
- Consumes: nothing from other tasks (foundation task).
- Produces: three DOM containers inside `#main` that Tasks 2-4 build their content into — `#char-profile-rebuild` (a `display:contents` wrapper; `renderCharProfile` clears and rebuilds its children every call), `#char-meta-strip` (`order:2`; `renderCharPanel` writes the metadata form here, memoized), `#char-meta-model` (`order:6`; `renderCharPanel` mounts the 3D viewer here, memoized). Tasks 2-4 give the hero/galleries/variants/feed elements inside `#char-profile-rebuild` explicit inline `style.order` values (1, 3, 4, 5, 7 respectively) — Task 1 sets these order values on placeholder/empty sections so the skeleton is already in the right visual order before any restyling.

- [ ] **Step 1: Remove the 3-column grid mechanism**

In `scripts/reclassify-tumblr.mjs`, find (around line 1357):

```css
#layout{flex:1 1 0;min-height:0;display:grid;grid-template-columns:var(--sb) 1fr}
#layout.has-panel{grid-template-columns:var(--sb) 1fr var(--cp)}
```

Replace with:

```css
#layout{flex:1 1 0;min-height:0;display:grid;grid-template-columns:var(--sb) 1fr}
```

In the same file's `:root` block (around line 1346), find:

```css
:root{--bg:#0e0e14;--bg2:#14142a;--bg3:#111120;--bd:rgba(255,255,255,.08);
  --txt:#ddd;--muted:rgba(255,255,255,.6);--gold:#ffcc00;--acc:#4f7aff;--sb:234px;--cp:280px}
```

Replace with:

```css
:root{--bg:#0e0e14;--bg2:#14142a;--bg3:#111120;--bd:rgba(255,255,255,.08);
  --txt:#ddd;--muted:rgba(255,255,255,.6);--gold:#ffcc00;--acc:#4f7aff;--sb:234px}
```

- [ ] **Step 2: Replace `#main`/`#char-panel` CSS with the consolidated-pane CSS**

Find (around line 1408):

```css
#main{overflow-y:auto;padding:14px 18px}
/* Character profile panel ─────────────────────────────────────────────── */
#char-panel{display:none;overflow-y:auto;background:var(--bg2);
  border-left:1px solid var(--bd);padding:14px}
#layout.has-panel #char-panel{display:block}
```

Replace with:

```css
#main{overflow-y:auto;padding:14px 18px}
/* Character profile (consolidated pane) ───────────────────────────────── */
/* When viewing a character, #main becomes a flex column so the always-
   rebuilt content (hero/galleries/variants/feed, inside #char-profile-
   rebuild) and the memoized content (metadata strip, 3D model viewer)
   can be visually interleaved via CSS `order`, while staying separate DOM
   subtrees with independent rebuild lifecycles — see renderGrid(). */
#main.char-mode{display:flex;flex-direction:column}
#char-profile-rebuild{display:contents}
#char-meta-strip{order:2}
#char-meta-model{order:6}
```

(The `.cp-*` rules below this, lines 1413-1452, stay exactly as they are for now — Task 3 restyles them.)

- [ ] **Step 3: Remove the `<aside id="char-panel">` element**

Find (around line 1911):

```html
  <div id="pose-detail-root"></div>
  <aside id="char-panel"></aside>
</div>
```

Replace with:

```html
  <div id="pose-detail-root"></div>
</div>
```

- [ ] **Step 4: Add a `lastProfileChar` tracking variable**

Find (around line 1970):

```js
let lastPanelChar = null; // tracks which character the #char-panel form was built for
```

Replace with:

```js
let lastPanelChar = null; // tracks which character the metadata strip/3D viewer were built for
let lastProfileChar = null; // tracks which character #char-profile-rebuild's containers exist for
```

- [ ] **Step 5: Remove the dead `has-panel` clear in the pose-detail branch**

Find (around line 2706):

```js
  if (poseDetailChar) {
    // #layout is a CSS grid (`var(--sb) 1fr` / `var(--sb) 1fr var(--cp)` via
    // .has-panel) — display:none fully removes an item from grid flow, but
    // renderCharPanel() (called right after this inside render()) early-
    // returns while poseDetailChar is set and never touches has-panel
    // itself, so it has to be cleared here or the stale #char-panel column
    // would keep reserving width next to the detail view.
    document.getElementById('layout').classList.remove('has-panel');
    main.style.display = 'none';
    mvRoot.style.display = 'none';
    poseDetailRoot.style.display = 'flex';
    renderPoseDetail(poseDetailChar);
```

Replace with:

```js
  if (poseDetailChar) {
    main.style.display = 'none';
    mvRoot.style.display = 'none';
    poseDetailRoot.style.display = 'flex';
    renderPoseDetail(poseDetailChar);
```

- [ ] **Step 6: Restructure `renderGrid()`'s clearing/branching to preserve both lifecycles**

Find (around line 2730, the lines immediately after the `mvRoot`/`main.style.display` block and before the dashboard check):

```js
  if (sel.game && sel.cat === null && !sel.char && !annFilter && !query) {
    renderDashboard(sel.game);
    return;
  }

  main.innerHTML = '';
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

  lbImgs = [];
  let shown = 0;
```

Then find the three-way branch a few lines down (around line 2746):

```js
  if (annFilter) {
    const imgs = [];
    for (const g of GO) {
      for (const [, rawImgs] of catsSorted(g)) {
        for (const img of rawImgs) {
          if ((img.annotations||[]).includes(annFilter) && (!query || searchMatch(img, query))) imgs.push(img);
        }
      }
    }
    addSection(annFilter === 'background' ? 'Backgrounds' : 'Details', imgs);
  } else if (sel.char) {
    const lname = sel.char;
    const sky = SKYLANDERS.find(s => s.name.toLowerCase() === lname);
    const dispName = sky?.name || lname;
    renderCharProfile(lname, sky);
    const featured = [], hidden = [];
    for (const g of GO) {
      for (const [, rawImgs] of catsSorted(g)) {
        for (const img of rawImgs) {
          if (!(img.skylanders||[]).map(s => s.toLowerCase()).includes(lname)) continue;
          if (query && !searchMatch(img, query)) continue;
          (img.featured === false ? hidden : featured).push(img);
        }
      }
    }
    addSection(dispName + ' — Featured', featured);
    addSection(dispName + ' — Not Featured', hidden);
  } else {
    const games = sel.game ? [sel.game] : GO;
    for (const g of games) {
      if (!TREE[g]) continue;
      const cats = sel.cat
        ? (TREE[g][sel.cat] ? [[sel.cat, TREE[g][sel.cat]]] : [])
        : catsSorted(g);

      for (const [c, rawImgs] of cats) {
        const imgs = query ? rawImgs.filter(i => searchMatch(i, query)) : rawImgs;
        const title = sel.game ? CAT_LBL(c) : (GAME_LBL[g]??g) + ' / ' + CAT_LBL(c);
        addSection(title, imgs);
      }
    }
  }
```

Replace with:

```js
  if (annFilter) {
    lastProfileChar = null;
    main.classList.remove('char-mode');
    main.innerHTML = '';
    const imgs = [];
    for (const g of GO) {
      for (const [, rawImgs] of catsSorted(g)) {
        for (const img of rawImgs) {
          if ((img.annotations||[]).includes(annFilter) && (!query || searchMatch(img, query))) imgs.push(img);
        }
      }
    }
    addSection(main, annFilter === 'background' ? 'Backgrounds' : 'Details', imgs);
  } else if (sel.char) {
    const lname = sel.char;
    const sky = SKYLANDERS.find(s => s.name.toLowerCase() === lname);
    const dispName = sky?.name || lname;

    if (lname !== lastProfileChar) {
      // Switching characters (or entering the profile view fresh): the
      // metadata strip/3D viewer must rebuild too, so destroy the old
      // viewer instance before the container holding it is replaced.
      window.ProfileModelViewer?.destroy();
      main.classList.add('char-mode');
      main.innerHTML = '<div id="char-profile-rebuild" style="display:contents"></div>'
        + '<div id="char-meta-strip"></div>'
        + '<div id="char-meta-model"></div>';
      lastProfileChar = lname;
      lastPanelChar = null;
    }
    renderCharProfile(lname, sky);
    const profileRoot = document.getElementById('char-profile-rebuild');
    const featured = [], hidden = [];
    for (const g of GO) {
      for (const [, rawImgs] of catsSorted(g)) {
        for (const img of rawImgs) {
          if (!(img.skylanders||[]).map(s => s.toLowerCase()).includes(lname)) continue;
          if (query && !searchMatch(img, query)) continue;
          (img.featured === false ? hidden : featured).push(img);
        }
      }
    }
    addSection(profileRoot, dispName + ' — Featured', featured, 7);
    addSection(profileRoot, dispName + ' — Not Featured', hidden, 7);
  } else {
    lastProfileChar = null;
    main.classList.remove('char-mode');
    main.innerHTML = '';
    const games = sel.game ? [sel.game] : GO;
    for (const g of games) {
      if (!TREE[g]) continue;
      const cats = sel.cat
        ? (TREE[g][sel.cat] ? [[sel.cat, TREE[g][sel.cat]]] : [])
        : catsSorted(g);

      for (const [c, rawImgs] of cats) {
        const imgs = query ? rawImgs.filter(i => searchMatch(i, query)) : rawImgs;
        const title = sel.game ? CAT_LBL(c) : (GAME_LBL[g]??g) + ' / ' + CAT_LBL(c);
        addSection(main, title, imgs);
      }
    }
  }
```

Now update `addSection` itself (a few lines above, around line 2738) to take an explicit target and optional order, instead of closing over `main`:

Find:

```js
  function addSection(title, imgs) {
    if (!imgs.length) return;
    const startIdx = lbImgs.length;
    imgs.forEach(i => lbImgs.push(i));
    shown += imgs.length;

    const sec = document.createElement('div'); sec.className = 'sec';
    const hd  = document.createElement('div'); hd.className = 'sec-hd';
    hd.innerHTML = title + ' <span class="cnt">' + imgs.length + '</span>';
    sec.appendChild(hd);

    const grid = document.createElement('div'); grid.className = 'grid';
    imgs.forEach((img, li) => grid.appendChild(makeCard(img, startIdx + li)));
    sec.appendChild(grid);
    main.appendChild(sec);
  }
```

Replace with:

```js
  function addSection(target, title, imgs, order) {
    if (!imgs.length) return;
    const startIdx = lbImgs.length;
    imgs.forEach(i => lbImgs.push(i));
    shown += imgs.length;

    const sec = document.createElement('div'); sec.className = 'sec';
    if (order != null) sec.style.order = order;
    const hd  = document.createElement('div'); hd.className = 'sec-hd';
    hd.innerHTML = title + ' <span class="cnt">' + imgs.length + '</span>';
    sec.appendChild(hd);

    const grid = document.createElement('div'); grid.className = 'grid';
    imgs.forEach((img, li) => grid.appendChild(makeCard(img, startIdx + li)));
    sec.appendChild(grid);
    target.appendChild(sec);
  }
```

- [ ] **Step 7: Retarget `renderCharProfile` to `#char-profile-rebuild` and set section order**

Find (around line 2321):

```js
function renderCharProfile(lname, sky) {
  const main = document.getElementById('main');

  const header = document.createElement('div'); header.className = 'prof-header';
```

Replace with:

```js
function renderCharProfile(lname, sky) {
  const main = document.getElementById('char-profile-rebuild');
  main.innerHTML = '';

  const header = document.createElement('div'); header.className = 'prof-header';
  header.style.order = 1;
```

Find the end of the same function (around line 2361-2366):

```js
  main.appendChild(renderSec);

  main.appendChild(profGallery(lname, sky, 'figures', 'Figures'));
  main.appendChild(profGallery(lname, sky, 'abilityIcons', 'Ability Icons'));
  main.appendChild(profVariants(lname, sky));
}
```

Replace with:

```js
  main.appendChild(renderSec);

  const figuresSec = profGallery(lname, sky, 'figures', 'Figures');
  figuresSec.style.order = 3;
  main.appendChild(figuresSec);

  const abilitySec = profGallery(lname, sky, 'abilityIcons', 'Ability Icons');
  abilitySec.style.order = 4;
  main.appendChild(abilitySec);

  const variantsSec = profVariants(lname, sky);
  variantsSec.style.order = 5;
  main.appendChild(variantsSec);
}
```

(The `renderSec` block right above already gets `order:1` via the shared `header` — to keep the render section in the same visual position as the header for now, find the line right after `if (!sky) return;` that declares `renderSec` and add an order on it too:

```js
  const renderSec = document.createElement('div'); renderSec.className = 'prof-section';
```

becomes:

```js
  const renderSec = document.createElement('div'); renderSec.className = 'prof-section';
  renderSec.style.order = 1;
```

`header` and `renderSec` are two separate top-level elements both appended to `main` (the `display:contents` wrapper) — giving both `order:1` is fine, flexbox breaks the tie by document order, so `header` still renders before `renderSec`. Task 2 collapses these two into one hero element; this is the minimal change to get Task 1's skeleton in the right visual position without doing Task 2's redesign yet.)

- [ ] **Step 8: Retarget `renderCharPanel` to the two new containers**

Find (around line 2808):

```js
function renderCharPanel() {
  const panel  = document.getElementById('char-panel');
  const layout = document.getElementById('layout');

  if (poseDetailChar) return; // detail view owns ProfileModelViewer's single instance while open

  if (!sel.char) {
    layout.classList.remove('has-panel');
    window.ProfileModelViewer?.destroy();
    panel.innerHTML = '';
    lastPanelChar = null;
    return;
  }
  layout.classList.add('has-panel');
  // Only rebuild when the selected character changes — preserves in-progress
  // edits when render() runs again for unrelated reasons (search, etc.)
  if (sel.char === lastPanelChar) return;
  window.ProfileModelViewer?.destroy();
  lastPanelChar = sel.char;

  const sky = SKYLANDERS.find(s => s.name.toLowerCase() === sel.char);

  if (!sky) {
    const dispName = sel.char.replace(/\b\w/g, c => c.toUpperCase());
    panel.innerHTML = '<div class="cp-name">' + escAttr(dispName) + '</div>'
      + '<div class="cp-sub">Not in roster</div>'
      + '<p style="font-size:.7rem;color:var(--muted);line-height:1.5">'
      + 'This character isn’t part of the tracked roster, so there’s nothing to edit here yet.</p>';
    return;
  }
```

Replace with:

```js
function renderCharPanel() {
  if (poseDetailChar) return; // detail view owns ProfileModelViewer's single instance while open

  if (!sel.char) {
    window.ProfileModelViewer?.destroy();
    lastPanelChar = null;
    return;
  }
  // Only rebuild when the selected character changes — preserves in-progress
  // edits when render() runs again for unrelated reasons (search, etc.), and
  // avoids destroying/remounting the 3D viewer on every incidental re-render.
  if (sel.char === lastPanelChar) return;
  lastPanelChar = sel.char;

  const stripPanel = document.getElementById('char-meta-strip');
  const modelPanel = document.getElementById('char-meta-model');
  const sky = SKYLANDERS.find(s => s.name.toLowerCase() === sel.char);

  if (!sky) {
    const dispName = sel.char.replace(/\b\w/g, c => c.toUpperCase());
    stripPanel.innerHTML = '<div class="cp-name">' + escAttr(dispName) + '</div>'
      + '<div class="cp-sub">Not in roster</div>'
      + '<p style="font-size:.7rem;color:var(--muted);line-height:1.5">'
      + 'This character isn’t part of the tracked roster, so there’s nothing to edit here yet.</p>';
    modelPanel.innerHTML = '';
    return;
  }
```

Note: `window.ProfileModelViewer?.destroy()` for the switching-character case already happens in `renderGrid()` (Step 6, right before it recreates the containers) — it's removed here to avoid destroying it twice; `renderCharPanel()` now only handles the `!sel.char` (deselecting) case, where the containers themselves no longer exist in the DOM (already replaced by grid/dashboard markup), so there's nothing to clear except the viewer instance itself.

Find the end of the same function (around line 2881-2884):

```js
  panel.innerHTML = '<div id="prof-model-panel"></div>'
    + '<div class="cp-name">' + escAttr(sky.name) + '</div>'
    + '<div class="cp-sub">' + escAttr(sky.game) + '</div>'
    + metaHTML;
```

Replace with:

```js
  stripPanel.innerHTML = '<div class="cp-sub">' + escAttr(sky.game) + '</div>' + metaHTML;
  modelPanel.innerHTML = '<div id="prof-model-panel"></div>';
```

(`cp-name` is dropped here — Task 2's hero already shows the character's name once; showing it a second time in the strip would be redundant. `cp-sub`, the game subtitle e.g. "Skylanders: Giants", is kept since nothing else on the page shows it.)

A few lines below, find:

```js
  if (!PUBLISH) {
    const extraWrap = document.getElementById('cp-extra');
```

This and everything through `renderProfileModelViewer(sky);` at the very end of the function stays unchanged — `cp-extra`/`cp-add-prop`/`cp-save` are looked up by `document.getElementById`, which works regardless of which container they're physically inside, and `renderProfileModelViewer(sky)` does its own `document.getElementById('prof-model-panel')` lookup, which now resolves inside `#char-meta-model` instead of the old `#char-panel`.

- [ ] **Step 9: Regenerate and smoke-test in the curation server**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Expected: `index.html rebuilt.` / `Done.` with no errors. Then start (if not already running) `node scripts/archive-server.mjs ./skylanders-archive` and confirm `http://127.0.0.1:7373/index.html` returns 200.

- [ ] **Step 10: Verify the lifecycle split actually works (this is the test for this task)**

Set up a Playwright (WebKit) scratch script. Write `/tmp/pw-test/check-profile-consolidation.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [page error]', e.message));

await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);

// 1. Selecting a character: no third grid column, char-mode class present.
const pickName = await page.evaluate(() => SKYLANDERS.find(s => s.name)?.name);
await page.evaluate((name) => {
  sel = { game: null, cat: null, char: name.toLowerCase() };
  render();
}, pickName);
await page.waitForTimeout(300);

const layoutInfo = await page.evaluate(() => {
  const cs = getComputedStyle(document.getElementById('layout'));
  return {
    gridColumns: cs.gridTemplateColumns,
    mainHasCharMode: document.getElementById('main').classList.contains('char-mode'),
    hasMetaStrip: !!document.getElementById('char-meta-strip'),
    hasMetaModel: !!document.getElementById('char-meta-model'),
    hasOldCharPanel: !!document.getElementById('char-panel'),
  };
});
console.log('After selecting', pickName, JSON.stringify(layoutInfo));

// 2. Type into a metadata field, then trigger an unrelated re-render (search
// query change) — the typed value must survive.
await page.fill('#cp-species', 'TEST-SPECIES-VALUE');
await page.evaluate(() => { query = 'xyz-unrelated-search'; render(); });
await page.waitForTimeout(200);
const speciesAfterUnrelatedRender = await page.evaluate(() => document.getElementById('cp-species')?.value);
console.log('Species field survives unrelated render:', speciesAfterUnrelatedRender === 'TEST-SPECIES-VALUE');
await page.evaluate(() => { query = ''; render(); });

// 3. Switching to a different character rebuilds the strip/model (lastPanelChar resets).
const secondName = await page.evaluate((first) => SKYLANDERS.find(s => s.name !== first)?.name, pickName);
await page.evaluate((name) => {
  sel = { game: null, cat: null, char: name.toLowerCase() };
  render();
}, secondName);
await page.waitForTimeout(300);
const speciesAfterSwitch = await page.evaluate(() => document.getElementById('cp-species')?.value);
console.log('Species field cleared/rebuilt after switching character (expect NOT TEST-SPECIES-VALUE):', speciesAfterSwitch);

// 4. Deselecting returns to a 2-column grid with no stray containers.
await page.evaluate(() => { sel = { game: SKYLANDERS[0]?.game || null, cat: null, char: null }; render(); });
await page.waitForTimeout(300);
const afterDeselect = await page.evaluate(() => ({
  gridColumns: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
  hasMetaStrip: !!document.getElementById('char-meta-strip'),
}));
console.log('After deselecting:', JSON.stringify(afterDeselect));

await browser.close();
```

Run: `node /tmp/pw-test/check-profile-consolidation.mjs`

Expected:
- `gridColumns` after selecting a character is a 2-value grid (no third column), `mainHasCharMode: true`, `hasMetaStrip: true`, `hasMetaModel: true`, `hasOldCharPanel: false`.
- `Species field survives unrelated render: true`.
- `speciesAfterSwitch` is the SECOND character's actual species value (or empty string), definitely not `'TEST-SPECIES-VALUE'` — confirming the strip rebuilt for the new character.
- After deselecting, `gridColumns` is back to a 2-value grid, `hasMetaStrip: false` (the container was removed along with the rest of `#main`'s old content).

- [ ] **Step 11: Verify the 3D viewer doesn't remount on unrelated re-renders**

Add to the same script (or a follow-up one), right after step 2 above (before switching characters): instrument `window.ProfileModelViewer.mount` to count calls, trigger a few unrelated re-renders, and confirm the count doesn't increase:

```js
await page.evaluate(() => {
  window.__mountCalls = 0;
  const orig = window.ProfileModelViewer.mount.bind(window.ProfileModelViewer);
  window.ProfileModelViewer.mount = (...args) => { window.__mountCalls++; return orig(...args); };
});
const before = await page.evaluate(() => window.__mountCalls);
await page.evaluate(() => { query = 'another-unrelated-query'; render(); query = ''; render(); });
await page.waitForTimeout(300);
const after = await page.evaluate(() => window.__mountCalls);
console.log('Mount calls before/after unrelated re-renders (expect equal):', before, after);
```

Expected: `before` and `after` are equal (only re-instrument and check this on a character that actually has a model, i.e. `sky.models?.length`).

- [ ] **Step 12: Verify non-character views still render correctly**

In the same or a new script, navigate to a game dashboard and a category grid (no character selected) and confirm no errors and normal-looking `.sec`/`.grid`/dashboard markup:

```js
await page.evaluate(() => { sel = { game: SKYLANDERS[0]?.game, cat: null, char: null }; query=''; render(); });
await page.waitForTimeout(300);
const dashOk = await page.evaluate(() => !!document.querySelector('.dash-card, .dash-grid, #empty'));
console.log('Dashboard/grid view still renders:', dashOk);
```

Expected: `true`, and no `pageerror` events logged during any of this script's run.

- [ ] **Step 13: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "refactor: consolidate character profile into one pane, preserve rebuild lifecycles"
```

---

## Task 2: Trading-card hero

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1522-1543` (`.prof-header`/`.prof-name`/`.prof-badge`/`.prof-render`/`.prof-actions` CSS)
- Modify: `scripts/reclassify-tumblr.mjs:2321-2361` (`renderCharProfile`'s header + render section, from Task 1's output)

**Interfaces:**
- Consumes: `#char-profile-rebuild` container and the `order` convention from Task 1 (hero gets `order:1`).
- Produces: a single `.prof-hero` element (replacing the separate `header`/`renderSec` elements from Task 1), containing the render image on the left and name/badge/species/role on the right. Task 3's secondary strip sits visually right after it (`order:2`, already a separate container per Task 1 — no change needed from Task 2's side).

- [ ] **Step 1: Replace the header + render-section CSS with the hero card CSS**

Find (around line 1522):

```css
/* Character profile ─────────────────────────────────────────────────────── */
.prof-header{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.prof-name{font-size:1.5rem;color:#fff;letter-spacing:.3px;text-transform:uppercase}
.prof-badge{font-size:.85rem;text-transform:uppercase;letter-spacing:1px;
  border:1.5px solid;border-radius:4px;padding:3px 10px}
.prof-section{margin-bottom:28px}
.prof-section-hd{font-size:1.05rem;color:var(--gold);letter-spacing:.5px;
  margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(255,204,0,.15);
  display:flex;align-items:baseline;gap:8px}
.prof-section-hd .cnt{color:var(--muted);font-size:.8rem;font-weight:normal;letter-spacing:0;text-transform:none}
.prof-empty{color:var(--muted);font-size:.85rem;margin-bottom:10px}
.prof-render{display:flex;justify-content:center;align-items:center;min-height:160px;
  background:rgba(255,255,255,.03);border:1px solid var(--bd);border-radius:8px;
  padding:14px;margin-bottom:10px}
.prof-render img{max-width:100%;max-height:340px;object-fit:contain}
.prof-render-empty{color:var(--muted);font-size:.95rem;padding:40px}
.prof-actions{display:flex;flex-wrap:wrap;gap:8px}
.prof-actions button{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;padding:7px 14px;font-size:.85rem;font-family:inherit;cursor:pointer;transition:all .12s}
.prof-actions button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.prof-actions button.prof-danger{border-color:rgba(255,80,80,.3);color:#ff8888}
.prof-actions button.prof-danger:hover{background:rgba(255,80,80,.12);border-color:rgba(255,80,80,.5)}
```

Replace with:

```css
/* Character profile ─────────────────────────────────────────────────────── */
.prof-hero{display:flex;gap:0;margin-bottom:18px;background:rgba(255,255,255,.03);
  border:1px solid var(--bd);border-radius:10px;overflow:hidden}
.prof-hero-art{flex:0 0 42%;min-height:220px;display:flex;align-items:center;justify-content:center;
  background:#0d0d14;padding:14px;box-sizing:border-box}
.prof-hero-art img{max-width:100%;max-height:320px;object-fit:contain}
.prof-render-empty{color:var(--muted);font-size:.95rem;padding:40px;text-align:center}
.prof-hero-info{flex:1;min-width:0;padding:20px 22px;display:flex;flex-direction:column;
  justify-content:center;gap:14px;background:var(--bg2)}
.prof-name{font-size:1.5rem;color:#fff;letter-spacing:.3px;text-transform:uppercase}
.prof-badge{display:inline-block;font-size:.78rem;text-transform:uppercase;letter-spacing:1px;
  border:1.5px solid;border-radius:20px;padding:3px 12px;margin-top:6px}
.prof-hero-stats{display:flex;flex-direction:column;gap:10px}
.prof-hero-stat .k{display:block;font-size:.62rem;text-transform:uppercase;letter-spacing:.06em;
  color:var(--muted);margin-bottom:2px}
.prof-hero-stat .v{font-size:.88rem;color:var(--txt);font-weight:600}
.prof-section{margin-bottom:28px}
.prof-section-hd{font-size:1.05rem;color:var(--gold);letter-spacing:.5px;
  margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid rgba(255,204,0,.15);
  display:flex;align-items:baseline;gap:8px}
.prof-section-hd .cnt{color:var(--muted);font-size:.8rem;font-weight:normal;letter-spacing:0;text-transform:none}
.prof-empty{color:var(--muted);font-size:.85rem;margin-bottom:10px}
.prof-actions{display:flex;flex-wrap:wrap;gap:8px}
.prof-actions button{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;padding:7px 14px;font-size:.85rem;font-family:inherit;cursor:pointer;transition:all .12s}
.prof-actions button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.prof-actions button.prof-danger{border-color:rgba(255,80,80,.3);color:#ff8888}
.prof-actions button.prof-danger:hover{background:rgba(255,80,80,.12);border-color:rgba(255,80,80,.5)}
```

- [ ] **Step 2: Rebuild `renderCharProfile`'s hero section**

Find the whole header + render block (around line 2321-2361, the code Task 1 left mostly intact aside from `order` assignments):

```js
function renderCharProfile(lname, sky) {
  const main = document.getElementById('char-profile-rebuild');
  main.innerHTML = '';

  const header = document.createElement('div'); header.className = 'prof-header';
  header.style.order = 1;
  const nameEl = document.createElement('h2'); nameEl.className = 'prof-name';
  nameEl.textContent = sky ? sky.name : lname.replace(/\b\w/g, c => c.toUpperCase());
  header.appendChild(nameEl);
  if (sky && sky.element) {
    const col = EL_COL[sky.element] || '#888';
    const badge = document.createElement('span'); badge.className = 'prof-badge';
    badge.textContent = sky.element;
    badge.style.borderColor = col;
    badge.style.color = col;
    badge.style.background = col + '22';
    header.appendChild(badge);
  }
  main.appendChild(header);

  if (!sky) return;

  // Render
  const renderSec = document.createElement('div'); renderSec.className = 'prof-section';
  renderSec.style.order = 1;
  const renderHd = document.createElement('div'); renderHd.className = 'prof-section-hd';
  renderHd.textContent = 'Render';
  renderSec.appendChild(renderHd);

  const renderBox = document.createElement('div'); renderBox.className = 'prof-render';
  renderBox.innerHTML = sky.render
    ? '<img src="' + ARCHIVE_BASE + sky.render + '" alt="">'
    : '<div class="prof-render-empty">No render assigned</div>';
  renderSec.appendChild(renderBox);

  if (!PUBLISH) {
    const actions = document.createElement('div'); actions.className = 'prof-actions';
    actions.appendChild(profBtn(sky.render ? 'Change render' : '+ Assign render', () =>
      openImagePicker(lname, { field: 'render' })));
    actions.appendChild(profBtn('Auto-fill', () => autoFillCharField(sky, 'render')));
    if (sky.render) actions.appendChild(profBtn('Remove', () => saveCharField(sky.name, { render: null }), 'prof-danger'));
    renderSec.appendChild(actions);
  }
  main.appendChild(renderSec);
```

Replace with:

```js
function renderCharProfile(lname, sky) {
  const main = document.getElementById('char-profile-rebuild');
  main.innerHTML = '';

  if (!sky) {
    const nameEl = document.createElement('h2'); nameEl.className = 'prof-name';
    nameEl.style.order = 1;
    nameEl.textContent = lname.replace(/\b\w/g, c => c.toUpperCase());
    main.appendChild(nameEl);
    return;
  }

  const hero = document.createElement('div'); hero.className = 'prof-hero';
  hero.style.order = 1;

  const art = document.createElement('div'); art.className = 'prof-hero-art';
  art.innerHTML = sky.render
    ? '<img src="' + ARCHIVE_BASE + sky.render + '" alt="">'
    : '<div class="prof-render-empty">No render assigned</div>';
  hero.appendChild(art);

  const info = document.createElement('div'); info.className = 'prof-hero-info';

  const nameEl = document.createElement('h2'); nameEl.className = 'prof-name';
  nameEl.textContent = sky.name;
  info.appendChild(nameEl);

  if (sky.element) {
    const col = EL_COL[sky.element] || '#888';
    const badge = document.createElement('span'); badge.className = 'prof-badge';
    badge.textContent = sky.element;
    badge.style.borderColor = col;
    badge.style.color = col;
    badge.style.background = col + '22';
    info.appendChild(badge);
  }

  const stats = document.createElement('div'); stats.className = 'prof-hero-stats';
  [['Species', sky.species], ['Role', sky.role]].forEach(([label, value]) => {
    if (!value) return;
    const stat = document.createElement('div'); stat.className = 'prof-hero-stat';
    stat.innerHTML = '<span class="k">' + label + '</span><span class="v">' + escAttr(value) + '</span>';
    stats.appendChild(stat);
  });
  if (stats.children.length) info.appendChild(stats);

  if (!PUBLISH) {
    const actions = document.createElement('div'); actions.className = 'prof-actions';
    actions.appendChild(profBtn(sky.render ? 'Change render' : '+ Assign render', () =>
      openImagePicker(lname, { field: 'render' })));
    actions.appendChild(profBtn('Auto-fill', () => autoFillCharField(sky, 'render')));
    if (sky.render) actions.appendChild(profBtn('Remove', () => saveCharField(sky.name, { render: null }), 'prof-danger'));
    info.appendChild(actions);
  }

  hero.appendChild(info);
  main.appendChild(hero);
```

Note: the rest of the function (figures/ability-icons/variants appending, with their `order` values from Task 1) stays exactly as Task 1 left it — only the header+render block above is replaced. The `!sky` early-return moved to the top of this new version (matching the spec's "character not in roster" requirement, which only needs the name shown — there's no hero for a character with no roster entry at all, since there's no data to put in one).

- [ ] **Step 3: Regenerate and verify**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Expected: no errors. Then in Playwright (webkit), load a character with a render/species/role set and confirm via `page.evaluate`:

```js
const heroInfo = await page.evaluate(() => {
  const hero = document.querySelector('.prof-hero');
  return {
    exists: !!hero,
    hasArt: !!hero?.querySelector('.prof-hero-art img, .prof-render-empty'),
    statCount: hero?.querySelectorAll('.prof-hero-stat').length,
  };
});
console.log(JSON.stringify(heroInfo));
```

Expected: `exists: true`, `hasArt: true`, `statCount` equal to however many of species/role are set (2 if both present, fewer if one is missing — confirm by also testing a character missing one of these fields and seeing the count drop by 1, with no broken/empty stat row rendered for the missing one).

- [ ] **Step 4: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: redesign character profile hero as a trading card"
```

---

## Task 3: Secondary details strip

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1413-1452` (`.cp-*` CSS — restyle into a pill strip)
- Modify: `scripts/reclassify-tumblr.mjs:2839-2901` (`renderCharPanel`'s `metaHTML` construction — gender/owned/level/favorite/extra fields, plus the curation Save flow)

**Interfaces:**
- Consumes: `#char-meta-strip` container from Task 1 (`order:2`, already positioned directly under the hero).
- Produces: no new interfaces — `saveCharPanel()` (untouched) keeps reading the same `cp-*` element IDs, just restyled.

- [ ] **Step 1: Replace the `.cp-*` form CSS with pill-strip CSS**

Find (around line 1413):

```css
.cp-name{font-size:.95rem;font-weight:700;color:#fff;margin-bottom:2px}
.cp-sub{font-size:.65rem;color:var(--muted);margin-bottom:14px;text-transform:uppercase;letter-spacing:.5px}
.cp-field{margin-bottom:10px}
.cp-field label{display:block;font-size:.62rem;color:var(--muted);
  text-transform:uppercase;letter-spacing:.6px;margin-bottom:3px}
.cp-field input[type=text],.cp-field input[type=number],.cp-field select{
  width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);
  color:#fff;padding:5px 7px;border-radius:4px;font-size:.74rem;font-family:inherit}
.cp-field input:focus,.cp-field select:focus{outline:none;border-color:var(--acc)}
.cp-field select option{background:#1a1a2a;color:#fff}
.cp-checks{display:flex;gap:14px;align-items:center;font-size:.72rem;color:#ccc}
.cp-checks label{display:flex;align-items:center;gap:5px;cursor:pointer}
.cp-checks input[type=checkbox]{accent-color:var(--acc);width:13px;height:13px;cursor:pointer}
.cp-checks input[type=number]{width:48px;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.15);color:#fff;padding:3px 5px;border-radius:4px;
  font-size:.72rem;font-family:inherit}
.cp-hr{border:none;border-top:1px solid var(--bd);margin:14px 0}
.cp-extra-row{display:flex;gap:5px;margin-bottom:6px}
.cp-extra-row input{flex:1;min-width:0;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.15);color:#fff;padding:4px 6px;border-radius:4px;
  font-size:.7rem;font-family:inherit}
.cp-extra-row input:focus{outline:none;border-color:var(--acc)}
.cp-extra-rm{flex-shrink:0;background:none;border:1px solid rgba(255,255,255,.15);
  color:var(--muted);border-radius:4px;width:24px;cursor:pointer;font-size:.8rem;
  font-family:inherit;line-height:1}
.cp-extra-rm:hover{color:#ff6b6b;border-color:rgba(255,107,107,.4)}
#cp-add-prop{margin-top:2px;background:none;border:1px dashed rgba(255,255,255,.2);
  color:var(--muted);border-radius:4px;padding:4px 10px;font-size:.68rem;cursor:pointer;
  font-family:inherit;width:100%}
#cp-add-prop:hover{color:#fff;border-color:rgba(255,255,255,.4)}
#cp-save{margin-top:14px;width:100%;padding:7px;background:rgba(80,220,100,.13);
  border:1.5px solid rgba(80,220,100,.4);color:#5fdc6f;border-radius:5px;cursor:pointer;
  font-size:.74rem;font-weight:700;font-family:inherit}
#cp-save:hover{background:rgba(80,220,100,.23)}
#cp-status{display:block;margin-top:8px;font-size:.68rem;text-align:center;min-height:1.2em}
#cp-status.ok{color:#5fdc6f}
#cp-status.err{color:#ff6b6b}
.cp-ro{font-size:.74rem;color:#fff;padding:5px 0}
.cp-extra-ro{display:flex;justify-content:space-between;gap:8px;font-size:.72rem;color:#ccc;padding:3px 0}
.cp-extra-ro-key{color:var(--muted)}
```

Replace with:

```css
#char-meta-strip{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;
  margin-bottom:24px;padding:10px 16px;background:rgba(255,255,255,.03);
  border:1px solid var(--bd);border-radius:8px;font-size:.74rem}
.cp-sub{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;
  flex:1 0 100%}
.cp-pill{display:inline-flex;align-items:center;gap:5px;color:var(--txt)}
.cp-pill .k{color:var(--muted);text-transform:uppercase;font-size:.62rem;letter-spacing:.05em}
.cp-field{display:flex;align-items:center;gap:5px}
.cp-field label{font-size:.62rem;color:var(--muted);text-transform:uppercase;letter-spacing:.6px}
.cp-field input[type=text],.cp-field input[type=number],.cp-field select{
  background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);
  color:#fff;padding:4px 6px;border-radius:4px;font-size:.74rem;font-family:inherit}
.cp-field input[type=text]{width:110px}
.cp-field input:focus,.cp-field select:focus{outline:none;border-color:var(--acc)}
.cp-field select option{background:#1a1a2a;color:#fff}
.cp-checks{display:flex;gap:14px;align-items:center;font-size:.72rem;color:#ccc}
.cp-checks label{display:flex;align-items:center;gap:5px;cursor:pointer}
.cp-checks input[type=checkbox]{accent-color:var(--acc);width:13px;height:13px;cursor:pointer}
.cp-checks input[type=number]{width:48px;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.15);color:#fff;padding:3px 5px;border-radius:4px;
  font-size:.72rem;font-family:inherit}
.cp-extra-row{display:flex;gap:5px;align-items:center}
.cp-extra-row input{min-width:0;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.15);color:#fff;padding:4px 6px;border-radius:4px;
  font-size:.7rem;font-family:inherit;width:90px}
.cp-extra-row input:focus{outline:none;border-color:var(--acc)}
.cp-extra-rm{flex-shrink:0;background:none;border:1px solid rgba(255,255,255,.15);
  color:var(--muted);border-radius:4px;width:22px;cursor:pointer;font-size:.78rem;
  font-family:inherit;line-height:1}
.cp-extra-rm:hover{color:#ff6b6b;border-color:rgba(255,107,107,.4)}
#cp-add-prop{background:none;border:1px dashed rgba(255,255,255,.2);
  color:var(--muted);border-radius:4px;padding:4px 10px;font-size:.68rem;cursor:pointer;
  font-family:inherit}
#cp-add-prop:hover{color:#fff;border-color:rgba(255,255,255,.4)}
#cp-save{flex:1 0 100%;margin-top:6px;padding:7px;background:rgba(80,220,100,.13);
  border:1.5px solid rgba(80,220,100,.4);color:#5fdc6f;border-radius:5px;cursor:pointer;
  font-size:.74rem;font-weight:700;font-family:inherit}
#cp-save:hover{background:rgba(80,220,100,.23)}
#cp-status{flex:1 0 100%;font-size:.68rem;text-align:center;min-height:1.2em}
#cp-status.ok{color:#5fdc6f}
#cp-status.err{color:#ff6b6b}
.cp-ro{font-size:.74rem;color:#fff}
.cp-extra-ro{display:inline-flex;gap:5px;font-size:.72rem;color:#ccc}
.cp-extra-ro-key{color:var(--muted)}
```

- [ ] **Step 2: Restyle `metaHTML` into pills (gender moves here; species/role stay hero-only)**

Find (around line 2845, the published/read-only branch):

```js
  const metaHTML = PUBLISH
    ? '<div class="cp-field"><label>Element</label><div class="cp-ro">' + escAttr(elLabel) + '</div></div>'
      + '<div class="cp-field"><label>Species</label><div class="cp-ro">' + escAttr(sky.species || '—') + '</div></div>'
      + '<div class="cp-field"><label>Gender</label><div class="cp-ro">' + escAttr(sky.gender || '—') + '</div></div>'
      + '<div class="cp-field"><label>Role</label><div class="cp-ro">' + escAttr(sky.role || '—') + '</div></div>'
      + '<div class="cp-field cp-checks">'
        + '<span>' + (sky.owned ? '✓ Owned' : '✕ Not owned') + '</span>'
        + (sky.favorite ? '<span>★ Favorite</span>' : '')
        + (sky.level != null ? '<span>Lvl ' + escAttr(sky.level) + '</span>' : '')
      + '</div>'
      + (hasExtra
        ? '<hr class="cp-hr">'
          + '<div class="cp-sub" style="margin-bottom:8px">Custom Properties</div>'
          + '<div id="cp-extra">' + Object.entries(sky.extra).map(([k, v]) =>
              '<div class="cp-extra-ro"><span class="cp-extra-ro-key">' + escAttr(k) + '</span><span>' + escAttr(v) + '</span></div>'
            ).join('') + '</div>'
        : '')
    : '<div class="cp-field"><label>Element</label><select id="cp-element">'
        + ELEMENTS.map(e => '<option value="' + e + '"' + (e === sky.element ? ' selected' : '') + '>'
          + e.charAt(0).toUpperCase() + e.slice(1) + '</option>').join('')
        + '</select></div>'
      + '<div class="cp-field"><label>Species</label><input id="cp-species" type="text" value="' + escAttr(sky.species) + '"></div>'
      + '<div class="cp-field"><label>Gender</label><input id="cp-gender" type="text" value="' + escAttr(sky.gender) + '"></div>'
      + '<div class="cp-field"><label>Role</label><input id="cp-role" type="text" value="' + escAttr(sky.role) + '"></div>'
      + '<div class="cp-field cp-checks">'
        + '<label><input id="cp-owned" type="checkbox"' + (sky.owned ? ' checked' : '') + '> Owned</label>'
        + '<label><input id="cp-favorite" type="checkbox"' + (sky.favorite ? ' checked' : '') + '> Favorite</label>'
        + '<label>Lvl <input id="cp-level" type="number" min="0" max="20" value="' + escAttr(sky.level ?? '') + '"></label>'
      + '</div>'
      + '<hr class="cp-hr">'
      + '<div class="cp-sub" style="margin-bottom:8px">Custom Properties</div>'
      + '<div id="cp-extra"></div>'
      + '<button id="cp-add-prop" type="button">+ Add property</button>'
      + '<button id="cp-save" type="button">Save Character</button>'
      + '<span id="cp-status"></span>';
```

Replace with:

```js
  const metaHTML = PUBLISH
    ? '<span class="cp-pill"><span class="k">Gender</span>' + escAttr(sky.gender || '—') + '</span>'
      + '<span class="cp-pill">' + (sky.owned ? '✓ Owned' : '✕ Not owned') + '</span>'
      + (sky.favorite ? '<span class="cp-pill">★ Favorite</span>' : '')
      + (sky.level != null ? '<span class="cp-pill"><span class="k">Lvl</span>' + escAttr(sky.level) + '</span>' : '')
      + (hasExtra
        ? '<span id="cp-extra">' + Object.entries(sky.extra).map(([k, v]) =>
              '<span class="cp-extra-ro"><span class="cp-extra-ro-key">' + escAttr(k) + '</span>' + escAttr(v) + '</span>'
            ).join('') + '</span>'
        : '')
      // Element select is curation-only input, but the element value itself
      // is already shown on the hero badge — no read-only duplicate needed.
    : '<input id="cp-element" type="hidden" value="' + escAttr(sky.element || '') + '">'
      + '<input id="cp-species" type="hidden" value="' + escAttr(sky.species || '') + '">'
      + '<div class="cp-field"><label>Gender</label><input id="cp-gender" type="text" value="' + escAttr(sky.gender) + '"></div>'
      + '<div class="cp-field cp-checks">'
        + '<label><input id="cp-owned" type="checkbox"' + (sky.owned ? ' checked' : '') + '> Owned</label>'
        + '<label><input id="cp-favorite" type="checkbox"' + (sky.favorite ? ' checked' : '') + '> Favorite</label>'
        + '<label>Lvl <input id="cp-level" type="number" min="0" max="20" value="' + escAttr(sky.level ?? '') + '"></label>'
      + '</div>'
      + '<div id="cp-extra"></div>'
      + '<button id="cp-add-prop" type="button">+ Add property</button>'
      + '<button id="cp-save" type="button">Save Character</button>'
      + '<span id="cp-status"></span>';
```

This drops the curation-mode visible Species/Role text inputs and the Element `<select>` from the strip — Task 2's hero shows species/role read-only, and editing them (along with element) needs its own affordance. Add one right next to the hero's existing render actions instead: find (Task 2's Step 2 output, in the `!PUBLISH` block inside `renderCharProfile`):

```js
  if (!PUBLISH) {
    const actions = document.createElement('div'); actions.className = 'prof-actions';
    actions.appendChild(profBtn(sky.render ? 'Change render' : '+ Assign render', () =>
      openImagePicker(lname, { field: 'render' })));
    actions.appendChild(profBtn('Auto-fill', () => autoFillCharField(sky, 'render')));
    if (sky.render) actions.appendChild(profBtn('Remove', () => saveCharField(sky.name, { render: null }), 'prof-danger'));
    info.appendChild(actions);
  }
```

Replace with:

```js
  if (!PUBLISH) {
    const actions = document.createElement('div'); actions.className = 'prof-actions';
    actions.appendChild(profBtn(sky.render ? 'Change render' : '+ Assign render', () =>
      openImagePicker(lname, { field: 'render' })));
    actions.appendChild(profBtn('Auto-fill', () => autoFillCharField(sky, 'render')));
    if (sky.render) actions.appendChild(profBtn('Remove', () => saveCharField(sky.name, { render: null }), 'prof-danger'));
    info.appendChild(actions);

    const editStats = document.createElement('div'); editStats.className = 'prof-actions';
    const elementSelect = document.createElement('select');
    elementSelect.id = 'cp-element-hero';
    elementSelect.innerHTML = ELEMENTS.map(e => '<option value="' + e + '"' + (e === sky.element ? ' selected' : '') + '>'
      + e.charAt(0).toUpperCase() + e.slice(1) + '</option>').join('');
    const speciesInput = document.createElement('input');
    speciesInput.id = 'cp-species-hero'; speciesInput.type = 'text'; speciesInput.placeholder = 'Species';
    speciesInput.value = sky.species || '';
    const roleInput = document.createElement('input');
    roleInput.id = 'cp-role-hero'; roleInput.type = 'text'; roleInput.placeholder = 'Role';
    roleInput.value = sky.role || '';
    editStats.appendChild(elementSelect);
    editStats.appendChild(speciesInput);
    editStats.appendChild(roleInput);
    info.appendChild(editStats);
  }
```

And `saveCharPanel()` (around line 2913-2925) needs to read these hero-side inputs instead of the now-removed `cp-element`/`cp-species`/`cp-role`. Find:

```js
  const payload = {
    name,
    element:  document.getElementById('cp-element').value,
    species:  document.getElementById('cp-species').value.trim(),
    gender:   document.getElementById('cp-gender').value.trim(),
    role:     document.getElementById('cp-role').value.trim(),
    owned:    document.getElementById('cp-owned').checked,
    favorite: document.getElementById('cp-favorite').checked,
    level:    document.getElementById('cp-level').value === '' ? null : Number(document.getElementById('cp-level').value),
    extra,
  };
```

Replace with:

```js
  const payload = {
    name,
    element:  document.getElementById('cp-element-hero').value,
    species:  document.getElementById('cp-species-hero').value.trim(),
    gender:   document.getElementById('cp-gender').value.trim(),
    role:     document.getElementById('cp-role-hero').value.trim(),
    owned:    document.getElementById('cp-owned').checked,
    favorite: document.getElementById('cp-favorite').checked,
    level:    document.getElementById('cp-level').value === '' ? null : Number(document.getElementById('cp-level').value),
    extra,
  };
```

Since saving (`cp-save`, inside the strip) now reads from inputs physically located in the hero (a sibling container, both children of `#char-profile-rebuild`/`#char-meta-strip` respectively, both always present together whenever a real character is selected), this works the same way `cp-extra`/`cp-save` already work across containers today — plain `document.getElementById`, no container-scoping assumptions anywhere in this codebase's existing code.

Also remove the now-stale comment 2 lines above `metaHTML`'s declaration (around line 2842-2844):

```js
  // Published builds show metadata read-only — there's no server on the live
  // site to receive edits, so the editable form + Save button (which posts
  // to /api/update-character) only get built in curation mode.
```

This comment is still accurate — leave it as-is.

- [ ] **Step 3: Regenerate and verify**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Then in Playwright (webkit), for a character with `owned`/`level`/`favorite`/`extra` all set:

```js
const stripInfo = await page.evaluate(() => {
  const strip = document.getElementById('char-meta-strip');
  return {
    pillCount: strip?.querySelectorAll('.cp-pill, .cp-field').length,
    hasElementSelect: !!document.getElementById('cp-element-hero'),
    hasSpeciesInput: !!document.getElementById('cp-species-hero'),
  };
});
console.log(JSON.stringify(stripInfo));
```

Expected: `pillCount > 0`, `hasElementSelect: true`, `hasSpeciesInput: true` (in curation mode). Then exercise an actual Save: change the species input's value, click `#cp-save`, wait, and confirm `SKYLANDERS.find(...).species` reflects the new value and `#cp-status` shows the saved confirmation — mirroring the existing `saveCharPanel` regression pattern already used elsewhere in this project's plans.

- [ ] **Step 4: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: restyle character metadata as a secondary details strip"
```

---

## Task 4: Restyle stacked sections + final cross-build verification

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1544-1599` (`.prof-gallery`/`.prof-variant`/`.prof-mv-*` CSS — visual polish only, no structural change)

**Interfaces:**
- Consumes: the `order` values already set by Task 1/2 on the figures/ability-icons/variants sections and the `#char-meta-model` container — no JS changes in this task, CSS only.
- Produces: nothing further — this is the last task.

- [ ] **Step 1: Cap and center the embedded 3D model viewer's width**

`.prof-gallery` (figures/ability-icons grid) needs no CSS change in this task — it already gets its column layout from the shared `.grid` class applied alongside it (`const grid = document.createElement('div'); grid.className = 'grid prof-gallery';` in `profGallery()`, line 2232), and that layout is already correct at full page width.

Find (around line 1580):

```css
/* Profile model viewer */
.prof-mv-wrap{margin-bottom:16px}
.prof-mv-canvas-wrap{width:100%;aspect-ratio:1/1;background:var(--bg3);
  border-radius:6px;overflow:hidden;border:1px solid var(--bd)}
```

Replace with:

```css
/* Profile model viewer */
#char-meta-model{margin-bottom:28px}
.prof-mv-wrap{margin-bottom:0}
.prof-mv-canvas-wrap{width:100%;max-width:480px;aspect-ratio:1/1;background:var(--bg3);
  border-radius:8px;overflow:hidden;border:1px solid var(--bd);margin:0 auto}
```

This centers and caps the embedded viewer's width so it doesn't stretch full-page-wide now that it's no longer confined to the old narrow side panel.

- [ ] **Step 2: Regenerate both builds**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
node scripts/reclassify-tumblr.mjs ./skylanders-archive --publish
```

Expected: both complete with `index.html rebuilt.` / `Done.` and no errors.

- [ ] **Step 3: Full cross-build edge-case sweep (this is the test for this task, and for the feature as a whole)**

Write `/tmp/pw-test/check-profile-redesign-final.mjs`:

```js
import { webkit } from 'playwright';

async function checkCharacter(url, label, charName, expectEditable) {
  const browser = await webkit.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.evaluate((name) => {
    sel = { game: null, cat: null, char: name.toLowerCase() };
    render();
  }, charName);
  await page.waitForTimeout(500);

  const info = await page.evaluate(() => ({
    heroExists: !!document.querySelector('.prof-hero, .prof-name'),
    stripExists: !!document.getElementById('char-meta-strip'),
    hasAnyEditButton: !!document.querySelector('.prof-actions button, #cp-save, #cp-add-prop'),
    gridColumns: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
    emptyStates: Array.from(document.querySelectorAll('.prof-empty, .prof-render-empty, .prof-mv-empty')).map(e => e.textContent),
  }));
  console.log(`[${label}/${charName}]`, JSON.stringify(info), 'errors:', errors);
  await page.screenshot({ path: `/tmp/profile-redesign-${label}-${charName.replace(/\s+/g,'-')}.png` });
  await browser.close();
  return { info, errors };
}

// Pick one fully-populated and one sparse character from the live data.
const browser = await webkit.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);
const { full, sparse } = await page.evaluate(() => ({
  full: SKYLANDERS.find(s => s.render && (s.figures||[]).length && (s.variants||[]).length && s.models?.length)?.name,
  sparse: SKYLANDERS.find(s => !s.render && !(s.figures||[]).length && !(s.variants||[]).length && !s.models?.length)?.name,
}));
await browser.close();
console.log('Full:', full, '| Sparse:', sparse);

for (const name of [full, sparse].filter(Boolean)) {
  const curation = await checkCharacter('http://127.0.0.1:7373/index.html', 'curation', name, true);
  const published = await checkCharacter('http://localhost:8080/server/skylanders/archive/', 'published', name, false);

  if (published.info.hasAnyEditButton) {
    console.log(`FAIL: published build for ${name} still has an edit affordance`);
  }
  if (curation.errors.length || published.errors.length) {
    console.log(`FAIL: page errors for ${name}`);
  }
}
```

Run: `node /tmp/pw-test/check-profile-redesign-final.mjs` (the published-build half requires the Eleventy dev server running at `localhost:8080` — start with `npx @11ty/eleventy --serve` if not already running, from a separate terminal/background process; the curation half needs `archive-server.mjs` running, as throughout this plan)

Expected:
- No `FAIL:` lines printed.
- For the fully-populated character: `heroExists: true` in both builds, `stripExists: true`, `gridColumns` is a 2-column grid (no third column) in both builds, curation has edit buttons (`hasAnyEditButton: true`), published has none (`hasAnyEditButton: false`).
- For the sparse character: same structural checks pass, and `emptyStates` includes the expected "No render assigned"/"None assigned yet."/"No 3D model available for this character." messages with no JS errors — confirming every empty-state path still works after the redesign.
- Manually open both screenshots (`/tmp/profile-redesign-curation-*.png`, `/tmp/profile-redesign-published-*.png`) and visually confirm the trading-card hero, the secondary strip, and the stacked sections look as designed, and that the published screenshots show no buttons/inputs anywhere.

- [ ] **Step 4: Verify the full-page pose editor still works from its new mount location**

```js
import { webkit } from 'playwright';
const browser = await webkit.launch();
const page = await browser.newPage();
await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);
const charWithModel = await page.evaluate(() => SKYLANDERS.find(s => s.models?.length)?.name);
await page.evaluate((name) => {
  sel = { game: null, cat: null, char: name.toLowerCase() };
  render();
}, charWithModel);
await page.waitForTimeout(800);
await page.click('.prof-mv-card-btn'); // "Pose & send to card →"
await page.waitForTimeout(800);
const poseInfo = await page.evaluate(() => ({
  poseDetailChar: typeof poseDetailChar !== 'undefined' ? poseDetailChar : null,
  canvasChildren: document.querySelector('.prof-mv-canvas-wrap')?.children.length,
}));
console.log(JSON.stringify(poseInfo));
await page.click('.pose-detail-back');
await page.waitForTimeout(500);
const afterClose = await page.evaluate(() => ({
  gridColumns: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
  heroStillThere: !!document.querySelector('.prof-hero'),
}));
console.log('After closing pose detail:', JSON.stringify(afterClose));
await browser.close();
```

Expected: `poseDetailChar` matches the selected character, `canvasChildren > 0` (model mounted), and after closing, the layout returns to a correctly-laid-out 2-column grid with the hero card present again.

- [ ] **Step 5: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "style: restyle figures/variants/3D-viewer sections to match the trading-card theme"
```

## Final Verification (manual, after all tasks)

- [ ] Open the curation UI in a real browser (not Chrome), click through several characters with different combinations of populated/empty fields, confirm the trading card + strip + sections all look right and every existing edit action (render change/auto-fill/remove, gallery add/auto-fill/remove, variant add/remove, metadata save) still works.
- [ ] Confirm the published build (`localhost:8080/server/skylanders/archive/`) shows the same visual design with zero edit affordances anywhere.
- [ ] Confirm typing into the global search box while a character profile is open does not clear in-progress metadata-field edits.
- [ ] Confirm switching from one character to another correctly rebuilds the hero/strip/3D-viewer for the new character (no stale data left over from the previous one).
