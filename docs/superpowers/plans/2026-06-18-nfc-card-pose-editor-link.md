# NFC Card Builder → Pose Editor Deep Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a link in the NFC card builder that jumps straight into the archive's pose-detail view for the currently-selected character, so a posed 3D model render can be imported as card art without manually hunting for the character in a separate UI.

**Architecture:** Two independent client-side JS changes, no new files, no build pipeline changes. `nfc-card.njk` gains a link whose `href` is computed from the selected character (resolving variants to their base name) and points at `/server/skylanders/archive/#pose=<name>`. `scripts/reclassify-tumblr.mjs`'s main script gains a `#pose=<name>` hash check (mirroring the existing `#model=`/`#texture=` convention already used by `model-viewer.js`) that calls the pre-existing `openPoseDetail(sky)` function.

**Tech Stack:** Vanilla DOM/JS, Nunjucks templating (Eleventy), no test framework in this project (confirmed by prior plans — no jest/vitest/mocha). Verification uses Playwright (WebKit channel — avoid Chrome per current project preference) driving the already-running curation server and a temporary Eleventy dev server, plus reading DOM state directly via `page.evaluate`.

## Global Constraints

- No new dependencies, no new files — both changes are edits to existing files (`src/pages/server/skylanders/nfc-card.njk`, `scripts/reclassify-tumblr.mjs`).
- Changes to `scripts/reclassify-tumblr.mjs` must land in the main always-shipped script section, not inside any curation-only block — this feature must work on the published `--publish` site, not just the local curation server.
- This project has no test framework — do not invent one. Verification is via Playwright (WebKit) browser automation and direct DOM/state assertions, run as throwaway scripts (not committed).
- Avoid Google Chrome for any testing in this plan — use Playwright's `webkit` browser type (already cached locally as of this session; if missing, `npx playwright install webkit` in a scratch directory with its own `package.json`).
- Variant characters must resolve to their **base** character name before being used in the `#pose=` link — the archive's model-matching and pose-detail view are keyed on base names only.

---

## Task 1: NFC card builder — add the pose-editor link

**Files:**
- Modify: `src/pages/server/skylanders/nfc-card.njk:450-464` (CHARS construction — add `baseName`)
- Modify: `src/pages/server/skylanders/nfc-card.njk:433-443` (new opt-section HTML)
- Modify: `src/pages/server/skylanders/nfc-card.njk:1446-1466` (`selectCharacter` — wire the link's href)

**Interfaces:**
- Consumes: nothing from other tasks (foundation task).
- Produces: `char.baseName` field on flattened variant entries in `CHARS` (variant entries only — base character entries have no `baseName`, callers must use `char.baseName || char.name`). A `#pose-link` anchor element whose `href` Task 2 will respond to.

- [ ] **Step 1: Add `baseName` to flattened variant entries**

In `src/pages/server/skylanders/nfc-card.njk`, find (around line 461):

```js
    const variants = (c.variants || []).map(v => ({ ...base, name: v.name, image: v.image }));
```

Change to:

```js
    const variants = (c.variants || []).map(v => ({ ...base, name: v.name, image: v.image, baseName: base.name }));
```

- [ ] **Step 2: Add the new opt-section HTML**

In `src/pages/server/skylanders/nfc-card.njk`, find (around lines 433-443):

```html
      <div class="opt-section" id="arc-art-section" style="display:none">
        <span class="opt-label">Archive Art
          <label id="arc-show-all-label" style="font-weight:400;font-size:11px;margin-left:8px;opacity:.6;cursor:pointer">
            <input type="checkbox" id="arc-show-all" style="vertical-align:middle;margin-right:3px">show all
          </label>
        </span>
        <div id="arc-art-gallery" class="arc-gallery"></div>
        <span id="arc-art-status" class="arc-status-msg"></span>
        <button class="clear-btn" id="arc-clear" style="margin-top:6px">✕ Clear archive layers</button>
      </div>
    </div>

  </div>
</div>
```

Change to:

```html
      <div class="opt-section" id="arc-art-section" style="display:none">
        <span class="opt-label">Archive Art
          <label id="arc-show-all-label" style="font-weight:400;font-size:11px;margin-left:8px;opacity:.6;cursor:pointer">
            <input type="checkbox" id="arc-show-all" style="vertical-align:middle;margin-right:3px">show all
          </label>
        </span>
        <div id="arc-art-gallery" class="arc-gallery"></div>
        <span id="arc-art-status" class="arc-status-msg"></span>
        <button class="clear-btn" id="arc-clear" style="margin-top:6px">✕ Clear archive layers</button>
      </div>

      <div class="opt-section" id="pose-link-section" style="display:none">
        <span class="opt-label">3D Model Art</span>
        <a id="pose-link" class="clear-btn" style="display:block;text-align:center;text-decoration:none" target="_blank" rel="noopener">↗ Pose a 3D model for this character</a>
      </div>
    </div>

  </div>
</div>
```

- [ ] **Step 3: Wire the link's href in `selectCharacter`**

In `src/pages/server/skylanders/nfc-card.njk`, find (around lines 1445-1446):

```js
  // ── Character selection ────────────────────────────────────────────────────
  async function selectCharacter(char) {
```

Change to:

```js
  // ── Character selection ────────────────────────────────────────────────────
  const poseLinkSection = document.getElementById('pose-link-section');
  const poseLink = document.getElementById('pose-link');

  async function selectCharacter(char) {
```

Then find, inside that same function (around line 1462):

```js
    document.getElementById('export-btn').disabled = false;
    charImg = await loadCharImg(char.name);
```

Change to:

```js
    document.getElementById('export-btn').disabled = false;
    poseLinkSection.style.display = '';
    poseLink.href = '/server/skylanders/archive/#pose=' + encodeURIComponent(char.baseName || char.name);
    charImg = await loadCharImg(char.name);
```

- [ ] **Step 4: Set up a Playwright (WebKit) scratch harness**

```bash
mkdir -p /tmp/pw-test && cd /tmp/pw-test && [ -f package.json ] || npm init -y >/dev/null 2>&1
npm install playwright@1.61.0 2>&1 | tail -5
npx playwright install webkit 2>&1 | tail -5
```

Expected: installs cleanly (browsers may already be cached from prior work in this repo — installer will say so if no download is needed).

- [ ] **Step 5: Verify the link's href for a base character and a variant character**

Write `/tmp/pw-test/check-pose-link.mjs`. Note: `selectCharacter` is declared
inside nfc-card.njk's `<script type="module">` block, so unlike the archive
page's classic (non-module) main script, it is **not** reachable as a bare
reference from `page.evaluate` — module top-level bindings are private to
the module. `CHARS`, however, lives in the page's earlier plain `<script>`
tag, so it's readable. Drive the actual UI (click the character thumbnail)
rather than calling `selectCharacter` directly:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [page error]', e.message));

await page.goto('http://localhost:8081/server/skylanders/nfc-card/', { waitUntil: 'networkidle' });

const names = await page.evaluate(() => {
  const base = CHARS.find(c => !c.baseName);
  const variant = CHARS.find(c => c.baseName);
  return { baseName: base.name, variantName: variant.name, variantBaseName: variant.baseName };
});
console.log('Testing with:', names);

await page.locator(`.char-thumb[data-name="${names.baseName}"]`).first().click();
await page.waitForTimeout(300);
const baseHref = await page.locator('#pose-link').getAttribute('href');
const baseExpected = '/server/skylanders/archive/#pose=' + encodeURIComponent(names.baseName);
console.log('base href:', baseHref, '| matches:', baseHref.endsWith(baseExpected));

await page.locator(`.char-thumb[data-name="${names.variantName}"]`).first().click();
await page.waitForTimeout(300);
const variantHref = await page.locator('#pose-link').getAttribute('href');
const variantExpected = '/server/skylanders/archive/#pose=' + encodeURIComponent(names.variantBaseName);
console.log('variant href:', variantHref, '| matches base name (not variant name):', variantHref.endsWith(variantExpected));

await browser.close();
```

Before running, start a throwaway Eleventy dev server on port 8081:

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
npx @11ty/eleventy --serve --port 8081 > /tmp/eleventy-test.log 2>&1 &
until curl -s -o /dev/null -w "%{http_code}" http://localhost:8081/server/skylanders/nfc-card/ | grep -q 200; do sleep 1; done
node /tmp/pw-test/check-pose-link.mjs
```

Expected output: both `base href matches: true` and `variant href matches base name (not variant name): true`.

- [ ] **Step 6: Stop the throwaway dev server**

```bash
pkill -f "eleventy --serve --port 8081"
```

- [ ] **Step 7: Commit**

```bash
git add src/pages/server/skylanders/nfc-card.njk
git commit -m "feat: add pose-editor link to NFC card builder"
```

---

## Task 2: Archive page — `#pose=` hash deep link

**Files:**
- Modify: `scripts/reclassify-tumblr.mjs:3119-3120`

**Interfaces:**
- Consumes: `SKYLANDERS` (array, top-level binding already defined at `scripts/reclassify-tumblr.mjs:1889`), `openPoseDetail(sky)` (already defined by the prior bone-posing-plan work — takes one `SKYLANDERS` entry, sets `poseDetailChar` and calls `render()`).
- Produces: nothing new for other tasks — this is the consumer side of Task 1's link.

- [ ] **Step 1: Add the hash check before the final bootstrap `render()`**

In `scripts/reclassify-tumblr.mjs`, find (around lines 3115-3120):

```js
window.addEventListener('skylander-model-viewer-close', () => {
  mvActive = false;
  render();
});

render();
```

Change to:

```js
window.addEventListener('skylander-model-viewer-close', () => {
  mvActive = false;
  render();
});

// Pose-editor deep link from the NFC card builder: #pose=<character name>
// opens straight into that character's pose-detail view. Mirrors the
// #model=/#texture= deep-link pattern above (model-viewer.js), including
// its same harmless double-render shape (openPoseDetail calls render()
// itself; the unconditional render() below runs again right after).
{
  const m = location.hash.match(/^#pose=(.+)$/);
  const sky = m && SKYLANDERS.find(s => s.name === decodeURIComponent(m[1]));
  if (sky) openPoseDetail(sky);
}
render();
```

- [ ] **Step 2: Regenerate the curation HTML so the curation server picks up the change**

```bash
cd /Users/cais_solomonik/Documents/repositories/quaint-lab
node scripts/reclassify-tumblr.mjs ./skylanders-archive
```

Expected: completes without errors (the curation server at `http://127.0.0.1:7373` should already be running from earlier in this session — confirm with `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7373/index.html`, expect `200`; if it's not running, start it with `node scripts/archive-server.mjs ./skylanders-archive` in the background first).

- [ ] **Step 3: Verify the deep link opens pose-detail for a character with a matched model**

Write `/tmp/pw-test/check-pose-deeplink.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [page error]', e.message));

await page.goto('http://127.0.0.1:7373/index.html#pose=Trigger%20Happy', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const opened = await page.evaluate(() => poseDetailChar);
console.log('poseDetailChar after #pose= deep link:', opened);
const backBtnVisible = await page.locator('.pose-detail-back').isVisible().catch(() => false);
console.log('pose-detail-back button visible:', backBtnVisible);

await browser.close();
```

Run: `node /tmp/pw-test/check-pose-deeplink.mjs`

Expected: `poseDetailChar after #pose= deep link: Trigger Happy` and `pose-detail-back button visible: true`.

- [ ] **Step 4: Verify the graceful fallback for a character with no matched model**

Write `/tmp/pw-test/check-pose-deeplink-empty.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();

// "Default" is cataloged in models.json but is never fuzzy-matched to any
// real SKYLANDERS character name — use a real character confirmed earlier
// in this project's investigation to have no matched 3D model. If your
// archive data differs, substitute any character name with sky.models = [].
const charWithNoModel = await page.evaluate(async () => {
  await new Promise(r => setTimeout(r, 100));
  return (typeof SKYLANDERS !== 'undefined' ? SKYLANDERS : []).find(s => !s.models || !s.models.length)?.name;
});
console.log('Testing character with no matched model:', charWithNoModel);

await page.goto('http://127.0.0.1:7373/index.html#pose=' + encodeURIComponent(charWithNoModel), { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const emptyMsg = await page.locator('.prof-mv-empty').textContent().catch(() => null);
console.log('Empty-state message shown:', emptyMsg);

await browser.close();
```

Run: `node /tmp/pw-test/check-pose-deeplink-empty.mjs`

Expected: `Empty-state message shown: No 3D model available for this character.`

- [ ] **Step 5: Regression check — confirm the existing `#model=`/`#texture=` deep link still works**

Write `/tmp/pw-test/check-model-deeplink-regression.mjs`:

```js
import { webkit } from 'playwright';

const browser = await webkit.launch();
const page = await browser.newPage();

await page.goto('http://127.0.0.1:7373/index.html#model=LI-M-001', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const state = await page.evaluate(() => ({ mvActive, sel }));
console.log(JSON.stringify(state));

await browser.close();
```

Run: `node /tmp/pw-test/check-model-deeplink-regression.mjs`

Expected: `mvActive: true` and `sel.game: 'lost-islands'` in the printed JSON — confirms the pre-existing deep link still functions unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/reclassify-tumblr.mjs
git commit -m "feat: add #pose= deep link to open pose-detail view from outside the archive"
```

---

## Final Verification (manual, after all tasks)

This is the actual end-to-end round trip the feature exists for — confirm it
works from the real NFC card builder, not just via direct hash navigation:

- [ ] Run `npm run publish-archive` (regenerates the published archive page
  and `skylanders-index.json` with both this plan's changes baked in).
- [ ] Start the Eleventy dev server: `npx @11ty/eleventy --serve` (default
  port 8080, or `npm start`).
- [ ] Open `http://localhost:8080/server/skylanders/nfc-card/` in a real
  browser (not Chrome — Safari or Firefox), select a character with a
  matched 3D model (e.g. Trigger Happy). Confirm the "↗ Pose a 3D model for
  this character" link appears in the right panel.
- [ ] Click the link — confirm it opens `/server/skylanders/archive/` in a
  new tab, landing directly in that character's pose-detail view (skeleton
  overlay and joint spheres visible, no manual navigation needed).
- [ ] Go back to the NFC card builder tab, select a variant character (one
  with a "Legendary"/"Super Shot"/etc. prefix). Click the link again —
  confirm it lands on the **base** character's pose-detail view, not a
  broken or empty one.
- [ ] Select a character with no matched 3D model. Confirm the link still
  appears, and clicking it shows "No 3D model available for this character."
  in the archive's pose-detail view rather than erroring or doing nothing.
- [ ] In the pose-detail view, click a joint sphere, drag a slider, then
  click "↗ Send to NFC" — confirm this still works exactly as before (this
  plan doesn't touch that code path, but it's the other half of the round
  trip this feature completes).
