# Bulk Auto-Fill Across All Characters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single header-toolbar button to the archive curation UI that runs the existing per-character "Auto-fill" logic across every character in one pass, without ever overwriting an existing render.

**Architecture:** Three sequential refactor/add steps in `scripts/reclassify-tumblr.mjs`: extract a pure patch-computation helper out of the existing per-character auto-fill function, split the existing save function into a non-rendering raw variant plus a thin rendering wrapper, then add the bulk button/status HTML and the loop that ties both together.

**Tech Stack:** Vanilla DOM/JS generated via template-literal strings inside a Node `.mjs` script (no build step, no framework). No test framework in this project (confirmed by every prior plan) — verification is manual, via the project's own curation server (`scripts/archive-server.mjs`) plus Playwright (WebKit) browser automation for precise DOM/state assertions, run as throwaway scripts.

## Global Constraints

- No new dependencies, no new files — every change is an edit to `scripts/reclassify-tumblr.mjs`.
- `render` auto-fill must never overwrite an existing render, in the new bulk path only — the existing per-character render button's overwrite-always behavior must stay exactly as it is today.
- `figures`/`abilityIcons` stay additive-only (unchanged behavior), just applied to every character.
- The new bulk button and its logic are curation-only — they must be stripped from the `--publish` build via the same `.replace()` mechanism as the other editing buttons (`tagModeBtnHTML`, `addImageBtnHTML`, `publishBtnHTML`).
- One combined POST per character that needs any field changed — never one POST per field, never a POST for characters needing no changes.
- One `render()` call at the end of the whole bulk run, not one per character.
- Continue past individual save failures during the bulk run; report a final success/failure count rather than aborting on the first error.
- Avoid Google Chrome for any browser-based testing in this plan — use Playwright's `webkit` browser type.

---

## Task 1: Extract `computeAutoFillPatch` from `autoFillCharField`

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1176-1196`

**Interfaces:**
- Consumes: nothing from other tasks (foundation task).
- Produces: `function computeAutoFillPatch(sky, field, { onlyIfMissing = false } = {})` — pure, no side effects, returns a patch object (e.g. `{ render: '...' }` or `{ figures: [...] }`) or `null` if nothing to add. Task 3 calls this directly with `onlyIfMissing: true` for `render`.

- [ ] **Step 1: Replace `autoFillCharField` with the extracted helper + thin wrapper**

In `scripts/reclassify-tumblr.mjs`, find (around line 1176):

```js
function autoFillCharField(sky, field) {
  const lname = sky.name.toLowerCase();
  const byCat = imagesByCategory(lname);
  const cats  = field === 'render' ? RENDER_CATS : field === 'figures' ? FIGURE_CATS : ABILITY_CATS;

  if (field === 'render') {
    for (const c of cats) {
      const pick = (byCat[c] || [])[0];
      if (pick) { saveCharField(sky.name, { render: pick.path }); return; }
    }
    return;
  }

  const existing = new Set(sky[field] || []);
  const additions = [];
  for (const c of cats) {
    for (const img of (byCat[c] || [])) {
      if (!existing.has(img.path) && !additions.includes(img.path)) additions.push(img.path);
    }
  }
  if (additions.length) saveCharField(sky.name, { [field]: [...(sky[field] || []), ...additions] });
}
```

Replace with:

```js
function computeAutoFillPatch(sky, field, { onlyIfMissing = false } = {}) {
  const lname = sky.name.toLowerCase();
  const byCat = imagesByCategory(lname);
  const cats  = field === 'render' ? RENDER_CATS : field === 'figures' ? FIGURE_CATS : ABILITY_CATS;

  if (field === 'render') {
    if (onlyIfMissing && sky.render) return null;
    for (const c of cats) {
      const pick = (byCat[c] || [])[0];
      if (pick) return { render: pick.path };
    }
    return null;
  }

  const existing = new Set(sky[field] || []);
  const additions = [];
  for (const c of cats) {
    for (const img of (byCat[c] || [])) {
      if (!existing.has(img.path) && !additions.includes(img.path)) additions.push(img.path);
    }
  }
  return additions.length ? { [field]: [...(sky[field] || []), ...additions] } : null;
}

function autoFillCharField(sky, field) {
  const patch = computeAutoFillPatch(sky, field);
  if (patch) saveCharField(sky.name, patch);
}
```

- [ ] **Step 2: Regenerate the curation HTML**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Expected: `index.html rebuilt.` / `Done.` with no errors.

- [ ] **Step 3: Confirm the curation server is reachable**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7373/index.html
```

Expected: `200`. If not 200, start it first: `node scripts/archive-server.mjs ./skylanders-archive` (run in the background, then re-check).

- [ ] **Step 4: Verify the per-character auto-fill buttons still behave exactly as before (regression check)**

This is the test for this task — `autoFillCharField`'s observable behavior must be unchanged. Set up a Playwright (WebKit) scratch harness if you don't already have one:

```bash
mkdir -p /tmp/pw-test && cd /tmp/pw-test && [ -f package.json ] || npm init -y >/dev/null 2>&1
npm install playwright@1.61.0 2>&1 | tail -5
npx playwright install webkit 2>&1 | tail -5
```

Write `/tmp/pw-test/check-autofill-regression.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [page error]', e.message));

await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);

// reclassify-tumblr.mjs's main script is a classic (non-module) <script>,
// so its top-level functions/consts are reachable as bare references from
// page.evaluate — confirmed working for SKYLANDERS/sel/render/openPoseDetail
// etc. in this exact codebase already.
const result = await page.evaluate(() => {
  // Find a character with at least one figures-category image not yet in figures.
  const sky = SKYLANDERS.find(s => {
    const patch = typeof computeAutoFillPatch === 'function' ? computeAutoFillPatch(s, 'figures') : null;
    return !!patch;
  });
  if (!sky) return { skipped: true };
  const before = { render: sky.render, figuresLen: (sky.figures || []).length };
  autoFillCharField(sky, 'figures');
  return { skipped: false, name: sky.name, before, computeAutoFillPatchExists: typeof computeAutoFillPatch === 'function' };
});
console.log(JSON.stringify(result, null, 2));

await page.waitForTimeout(800); // let the save's fetch + render() settle

const after = await page.evaluate((name) => {
  const sky = SKYLANDERS.find(s => s.name === name);
  return sky ? { figuresLen: (sky.figures || []).length } : null;
}, result.name);
console.log('After auto-fill, figures length:', JSON.stringify(after));

await browser.close();
```

Run: `node /tmp/pw-test/check-autofill-regression.mjs`

Expected: `computeAutoFillPatchExists: true`, and the `figures` array length strictly increases between `before` and `after` for the picked character (confirms `autoFillCharField` still adds new figures exactly as before, now routed through the new helper).

- [ ] **Step 5: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "refactor: extract computeAutoFillPatch from autoFillCharField"
```

---

## Task 2: Split `saveCharField` into a raw variant plus a thin wrapper

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:1199-1209`

**Interfaces:**
- Consumes: nothing from Task 1 directly (independent refactor of a different function), but both land in the same file.
- Produces: `async function saveCharFieldRaw(name, patch)` — POSTs to `/api/update-character` and merges the patch into the in-memory `SKYLANDERS` entry; throws on failure; does **not** call `render()` and does **not** catch/alert. Task 3 calls this directly inside its bulk loop.

- [ ] **Step 1: Replace `saveCharField` with the split version**

In `scripts/reclassify-tumblr.mjs`, find (around line 1199):

```js
async function saveCharField(name, patch) {
  const sky = SKYLANDERS.find(s => s.name === name);
  try {
    const res = await fetch('/api/update-character', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ...patch })
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    if (sky) Object.assign(sky, patch);
    render();
  } catch (e) {
    alert('Error saving: ' + e.message);
  }
}
```

Replace with:

```js
async function saveCharFieldRaw(name, patch) {
  const sky = SKYLANDERS.find(s => s.name === name);
  const res = await fetch('/api/update-character', {
    method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name, ...patch })
  });
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  if (sky) Object.assign(sky, patch);
}

async function saveCharField(name, patch) {
  try {
    await saveCharFieldRaw(name, patch);
    render();
  } catch (e) {
    alert('Error saving: ' + e.message);
  }
}
```

- [ ] **Step 2: Regenerate the curation HTML**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Expected: `index.html rebuilt.` / `Done.` with no errors.

- [ ] **Step 3: Verify existing single-character saves still work (regression check)**

Write `/tmp/pw-test/check-savefield-regression.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [page error]', e.message));

await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);

const result = await page.evaluate(async () => {
  const sky = SKYLANDERS.find(s => s.name === 'Zap');
  if (!sky) return { error: 'Zap not found' };
  const originalRender = sky.render;
  // saveCharFieldRaw must exist and must NOT call render() itself —
  // verify by checking it returns a real promise that resolves cleanly.
  const rawExists = typeof saveCharFieldRaw === 'function';
  await saveCharFieldRaw('Zap', { render: originalRender }); // no-op value, just exercising the path
  return { rawExists, originalRender, skyRenderAfter: sky.render };
});
console.log(JSON.stringify(result, null, 2));

await browser.close();
```

Run: `node /tmp/pw-test/check-savefield-regression.mjs`

Expected: `rawExists: true`, and `skyRenderAfter` equals `originalRender` (the round-trip POST + merge succeeded without throwing).

- [ ] **Step 4: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "refactor: split saveCharField into saveCharFieldRaw + rendering wrapper"
```

---

## Task 3: Bulk "Auto-fill All" button and logic

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:438-440` (new `autoFillAllBtnHTML` constant, placed alongside `publishBtnHTML`)
- Modify: `scripts/reclassify-tumblr.mjs:1808` (header composition — add the new button)
- Modify: `scripts/reclassify-tumblr.mjs:1116-1138` area (new `autoFillAllCharacters()` function, placed near `publishArchive`)
- Modify: `scripts/reclassify-tumblr.mjs:3160-3168` (`--publish` strip list — add the new button's removal)

**Interfaces:**
- Consumes: `computeAutoFillPatch(sky, field, { onlyIfMissing })` (Task 1), `saveCharFieldRaw(name, patch)` (Task 2), `SKYLANDERS` (existing top-level array), `render()` (existing).
- Produces: nothing new for other tasks — this is the final user-facing wiring.

- [ ] **Step 1: Add the `autoFillAllBtnHTML` constant**

In `scripts/reclassify-tumblr.mjs`, find (around line 438):

```js
const publishBtnHTML = `
  <button id="publish-btn" onclick="publishArchive()" title="Re-sort, regenerate the site's archive page, and sync images into src/images/skylanders-archive/">Publish</button>
  <span id="publish-status"></span>`;
```

Add immediately after it:

```js
const publishBtnHTML = `
  <button id="publish-btn" onclick="publishArchive()" title="Re-sort, regenerate the site's archive page, and sync images into src/images/skylanders-archive/">Publish</button>
  <span id="publish-status"></span>`;

const autoFillAllBtnHTML = `
  <button id="autofill-all-btn" onclick="autoFillAllCharacters()" title="Fill in missing renders and add any newly-tagged figures/ability icons, across every character">Auto-fill All</button>
  <span id="autofill-all-status"></span>`;
```

- [ ] **Step 2: Add the button to the header**

In `scripts/reclassify-tumblr.mjs`, find (around line 1808):

```js
  <input id="q" type="search" placeholder="Search…" autocomplete="off">${tagModeBtnHTML}${addImageBtnHTML}${publishBtnHTML}
```

Change to:

```js
  <input id="q" type="search" placeholder="Search…" autocomplete="off">${tagModeBtnHTML}${addImageBtnHTML}${publishBtnHTML}${autoFillAllBtnHTML}
```

- [ ] **Step 3: Add `autoFillAllCharacters()` near `publishArchive`**

In `scripts/reclassify-tumblr.mjs`, find the end of `publishArchive` (around line 1138):

```js
async function publishArchive() {
  const btn = document.getElementById('publish-btn');
  const statusEl = document.getElementById('publish-status');
  btn.disabled = true;
  statusEl.className = ''; statusEl.textContent = 'Publishing…';

  try {
    const res = await fetch(PUBLISH_API, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('Server responded ' + res.status));

    statusEl.className = 'ok'; statusEl.textContent = '✓ Published';
    setTimeout(() => { if (statusEl.textContent === '✓ Published') statusEl.textContent = ''; }, 4000);
  } catch (e) {
    const msg = e.message || '';
    statusEl.className = 'err';
    statusEl.textContent = msg.includes('fetch') || msg.includes('Failed')
      ? 'Start the server: node scripts/archive-server.mjs ./skylanders-archive'
      : 'Error: ' + msg;
  } finally {
    btn.disabled = false;
  }
}
```

Add immediately after it:

```js
async function autoFillAllCharacters() {
  if (!confirm('Auto-fill every character?\n\nFills in renders only for characters that have none, and adds any newly-tagged figures/ability icons to every character. Existing renders are never overwritten.')) return;

  const btn = document.getElementById('autofill-all-btn');
  const statusEl = document.getElementById('autofill-all-status');
  btn.disabled = true;
  statusEl.className = '';

  let updated = 0, failed = 0;
  const total = SKYLANDERS.length;
  for (let i = 0; i < total; i++) {
    const sky = SKYLANDERS[i];
    statusEl.textContent = 'Auto-filling… ' + (i + 1) + '/' + total;
    const patch = {};
    for (const field of ['render', 'figures', 'abilityIcons']) {
      const fieldPatch = computeAutoFillPatch(sky, field, { onlyIfMissing: field === 'render' });
      if (fieldPatch) Object.assign(patch, fieldPatch);
    }
    if (Object.keys(patch).length) {
      try {
        await saveCharFieldRaw(sky.name, patch);
        updated++;
      } catch (e) {
        failed++;
      }
    }
  }

  render();
  statusEl.className = failed ? 'err' : 'ok';
  statusEl.textContent = (failed ? '⚠ ' : '✓ ') + 'Auto-filled ' + updated + '/' + total + ' characters' + (failed ? ' — ' + failed + ' failed' : '');
  btn.disabled = false;
}
```

Note: this file already contains many literal `…`/`✓`-style escapes elsewhere in the same script (e.g. directly above in `publishArchive`) — write them exactly as shown (a single backslash), not doubled, matching the surrounding code exactly.

- [ ] **Step 4: Add the new button to the `--publish` strip list**

In `scripts/reclassify-tumblr.mjs`, find (around line 3160):

```js
const htmlPublish = html
  .replace(tagModeBtnHTML, '')
  .replace(tagBarHTML, '')
  .replace(editBtnHTML, '')
  .replace(editPanelHTML, '')
  .replace(addImageBtnHTML, '')
  .replace(addModalHTML, '')
  .replace(imagePickerModalHTML, '')
  .replace(publishBtnHTML, '')
```

Change to:

```js
const htmlPublish = html
  .replace(tagModeBtnHTML, '')
  .replace(tagBarHTML, '')
  .replace(editBtnHTML, '')
  .replace(editPanelHTML, '')
  .replace(addImageBtnHTML, '')
  .replace(addModalHTML, '')
  .replace(imagePickerModalHTML, '')
  .replace(publishBtnHTML, '')
  .replace(autoFillAllBtnHTML, '')
```

- [ ] **Step 5: Regenerate both the curation HTML and the published build**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
node scripts/reclassify-tumblr.mjs ./skylanders-archive --publish
```

Expected: both complete with `index.html rebuilt.` / `Done.` and no errors.

- [ ] **Step 6: Confirm the button is absent from the published build**

```bash
grep -c "autofill-all-btn" src/pages/server/skylanders/archive/index.html
```

Expected: `0`.

- [ ] **Step 7: Confirm the button is present in the curation build**

```bash
grep -c "autofill-all-btn" skylanders-archive/index.html
```

Expected: a number greater than `0`.

- [ ] **Step 8: Functional test — render-only-if-missing, figures/abilityIcons additive, across all characters**

Write `/tmp/pw-test/check-bulk-autofill.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('dialog', d => d.accept()); // auto-accept the confirm()
page.on('pageerror', e => console.log('  [page error]', e.message));

await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);

// Snapshot state before, for two characters: one with an existing render
// (must stay unchanged) and one with none (must get filled, if any render
// category image is tagged for it).
const before = await page.evaluate(() => {
  const withRender = SKYLANDERS.find(s => s.render);
  const withoutRender = SKYLANDERS.find(s => !s.render);
  return {
    withRender: withRender && { name: withRender.name, render: withRender.render },
    withoutRender: withoutRender && { name: withoutRender.name, render: withoutRender.render },
  };
});
console.log('Before:', JSON.stringify(before, null, 2));

await page.click('#autofill-all-btn');
// Bulk run is sequential over ~213 characters (one network round-trip each
// for characters needing changes) — give it generous time to finish.
await page.waitForFunction(
  () => document.getElementById('autofill-all-btn').disabled === false,
  { timeout: 120000 }
);

const statusText = await page.evaluate(() => document.getElementById('autofill-all-status').textContent);
console.log('Final status:', statusText);

const after = await page.evaluate((names) => {
  const a = SKYLANDERS.find(s => s.name === names.withRender);
  const b = SKYLANDERS.find(s => s.name === names.withoutRender);
  return {
    withRender: a && { name: a.name, render: a.render },
    withoutRender: b && { name: b.name, render: b.render },
  };
}, { withRender: before.withRender?.name, withoutRender: before.withoutRender?.name });
console.log('After:', JSON.stringify(after, null, 2));

await browser.close();
```

Run: `node /tmp/pw-test/check-bulk-autofill.mjs` (this will take a while — it's a real sequential pass over every character)

Expected:
- `Final status` matches the pattern `✓ Auto-filled <N>/<total> characters` (or with `— <N> failed` appended if any individual save failed).
- `after.withRender.render` is **identical** to `before.withRender.render` (never overwritten).
- `after.withoutRender.render` is either still empty (no matching category image exists for that character) or now set to some path (filled in) — either way, confirm by manual inspection that it was **not previously set** and the bulk run is what could have set it.

- [ ] **Step 9: Confirm cancelling the confirm() dialog does nothing**

Write `/tmp/pw-test/check-bulk-autofill-cancel.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('dialog', d => d.dismiss()); // cancel the confirm()

await page.goto('http://127.0.0.1:7373/index.html', { waitUntil: 'load' });
await page.waitForTimeout(500);

await page.click('#autofill-all-btn');
await page.waitForTimeout(500);

const state = await page.evaluate(() => ({
  btnDisabled: document.getElementById('autofill-all-btn').disabled,
  statusText: document.getElementById('autofill-all-status').textContent,
}));
console.log(JSON.stringify(state));

await browser.close();
```

Run: `node /tmp/pw-test/check-bulk-autofill-cancel.mjs`

Expected: `btnDisabled: false`, `statusText: ""` — nothing ran.

- [ ] **Step 10: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: add bulk auto-fill across all characters"
```

---

## Final Verification (manual, after all tasks)

- [ ] Open the curation UI in a real browser (not Chrome), click "Auto-fill All", confirm the dialog, and watch the status text count up live ("Auto-filling… N/213") through to a final summary.
- [ ] Spot-check 2-3 characters that had no render before: confirm they now show a render (if a matching tagged image existed) in their profile panel.
- [ ] Spot-check 2-3 characters that already had a render: confirm it's unchanged.
- [ ] Spot-check a character with newly-tagged figure/ability-icon images not previously in their `figures`/`abilityIcons` lists: confirm those got added.
- [ ] Confirm the per-character "Auto-fill" buttons (render, figures, ability icons) inside an individual character's profile panel still work exactly as before — these must be unaffected by this whole feature.
- [ ] Run `npm run publish-archive` and confirm "Auto-fill All" does not appear anywhere on the published page.
