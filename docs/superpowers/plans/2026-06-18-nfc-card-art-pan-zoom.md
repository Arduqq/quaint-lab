# NFC Card Art Pan & Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag the character art around and scroll-wheel zoom it
within its frame on the NFC card preview, with a reset button and automatic
reset whenever the active character image changes.

**Architecture:** Three new fields on the existing `state` object
(`artOffsetX`, `artOffsetY`, `artZoom`) get applied inside `drawArtPanel`'s
existing auto-fit/center math, on top of it rather than replacing it.
`drawArtPanel` also records the currently-active layout's art panel
rectangle into a module-level variable every redraw, which `pointerdown`/
`wheel` listeners on `#card-canvas` use to hit-test whether an interaction
should start. Resetting the three new fields to default is a single small
helper called from a new button and from every place the active character
image already changes.

**Tech Stack:** Vanilla Canvas 2D + DOM (no libraries) — this file
(`src/pages/server/skylanders/nfc-card.njk`) is a single self-contained
`<script type="module">`, no external imports.

## Global Constraints

- Single file: `src/pages/server/skylanders/nfc-card.njk`. No new files.
- This file's `<script type="module">` has fully private module scope —
  none of its top-level `const`/`let`/functions (`state`, `drawCard`,
  `canvas`, etc.) are reachable from outside, not even via a devtools
  console or `page.evaluate()` in a separate script context. (Confirmed
  empirically this session — attempting `page.evaluate(() => state...)`
  from an external Puppeteer script throws `ReferenceError: state is not
  defined`, unlike the classic `<script>` blocks elsewhere in this
  project.) This means verification for both tasks must drive the page
  through **real synthetic mouse/wheel events** (Puppeteer's `page.mouse`
  API, or dispatched `PointerEvent`/`WheelEvent`s) and check results via
  `canvas.toDataURL()` (a public method on the DOM element, unaffected by
  module privacy) or screenshots — never by reaching into the module's
  internals.
- No test framework exists in this project (no jest/vitest/mocha,
  confirmed earlier this session) — verification is live-browser only via
  Puppeteer connected to a real Chrome instance over the remote-debugging
  protocol (`open -a "Google Chrome" --args --remote-debugging-port=<port>
  --user-data-dir=/tmp/<unique-dir>`, then `puppeteer.connect({ browserURL:
  'http://localhost:<port>' })`). Headless `puppeteer.launch()` crashes in
  this sandboxed environment — this exact connect-to-real-Chrome pattern
  has been used successfully many times already this session.
- The art panel is already clipped (`ctx.clip()` when `framed: true`, and
  the whole card has an outer rounded-rect clip regardless) — free
  dragging/zooming never needs explicit bounds-checking; overflow is
  cropped for free.
- Don't touch the background (`bgBase`/`arcBgImg`) or detail-layer
  (`arcDetailImg`) positioning — this feature is scoped to the character
  art (`srcImg`) only.
- This page is served directly by Eleventy's `--serve` (port 8080 in this
  session's running instance) at `/server/skylanders/nfc-card/` — editing
  a `.njk` template is picked up live by Eleventy's watcher; just reload
  the browser tab after saving, no rebuild command needed (unlike the
  curation archive's build script).

---

## Task 1: Pan & zoom — state, rendering, and pointer/wheel interaction

**Files:**
- Modify: `src/pages/server/skylanders/nfc-card.njk`
  - `state` object (~line 545-565)
  - module-level `let` declarations (~line 578-581)
  - `#card-canvas` CSS rule (~line 119)
  - `drawArtPanel` function (~line 924-1028)
  - new interaction-wiring block, placed after the browse-arrows wiring
    and before the "Init" IIFE (~line 1710-1712)

**Interfaces:**
- Consumes: nothing from other tasks (this is the foundation task).
- Produces: `state.artOffsetX`, `state.artOffsetY`, `state.artZoom`
  (numbers, defaults `0, 0, 1`) on the existing `state` object; a
  module-level `lastArtPanelRect` (`{x, y, w, h}` in the canvas's internal
  638×1011 coordinate space, or `null` before the first draw) that Task 2
  does not need to touch but should know exists.

- [ ] **Step 1: Add the three new state fields**

Find, in the `const state = {` block:

```js
  layout: 'half',
  showName: true,
  showAttack: true,
  showElement: true,
  showLogo: true,
};
```

Change to:

```js
  layout: 'half',
  showName: true,
  showAttack: true,
  showElement: true,
  showLogo: true,
  artOffsetX: 0, // px, in card-canvas (638×1011) space — user pan on top of drawArtPanel's auto-fit
  artOffsetY: 0,
  artZoom: 1,    // multiplier on top of drawArtPanel's auto-fit scale
};
```

- [ ] **Step 2: Add the art-panel-rect tracking variable**

Find:

```js
  let charImg = null;
  let charImgIsArt = false; // true when charImg is a painted illustration (hi-res tooltip art / custom upload), not a transparent in-game figure cutout
  let logoImg = null;
  let usingCustomImg = false;
```

Change to:

```js
  let charImg = null;
  let charImgIsArt = false; // true when charImg is a painted illustration (hi-res tooltip art / custom upload), not a transparent in-game figure cutout
  let logoImg = null;
  let usingCustomImg = false;
  // {x, y, w, h} of the currently-active layout's art panel, in canvas-
  // internal (638×1011) space — set by drawArtPanel every redraw, read by
  // the pointer/wheel handlers below to hit-test where dragging/zooming is
  // allowed to start. Only one layout's drawArtPanel call runs per redraw.
  let lastArtPanelRect = null;
```

- [ ] **Step 3: Disable native touch panning/zooming on the canvas**

Find:

```css
  #card-canvas { width: auto; height: auto; max-width: 100%; display: block; border-radius: 4px; }
```

Change to:

```css
  #card-canvas { width: auto; height: auto; max-width: 100%; display: block; border-radius: 4px; touch-action: none; }
```

- [ ] **Step 4: Apply pan/zoom inside `drawArtPanel`, and track its rect**

Find:

```js
    function drawArtPanel(x, y, w, h, { framed = false, cornerStyle = 'round' } = {}) {
      ctx.save();
```

Change to:

```js
    function drawArtPanel(x, y, w, h, { framed = false, cornerStyle = 'round' } = {}) {
      lastArtPanelRect = { x, y, w, h };
      ctx.save();
```

Then find (the two image-drawing branches, further down in the same function):

```js
      const srcIsArt = srcImg && (srcImg === arcArtImg || (srcImg === charImg && charImgIsArt));

      if (srcIsArt) {
        const iw = srcImg.naturalWidth || w, ih = srcImg.naturalHeight || h;
        const sc = Math.max(w / iw, h / ih);
        const dw = iw * sc, dh = ih * sc;
        ctx.drawImage(srcImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      } else if (srcImg) {
        const pad = Math.min(w, h) * 0.05;
        let iw = srcImg.naturalWidth || 400, ih = srcImg.naturalHeight || 400;
        const sc = Math.min((w-pad*2)/iw, (h-pad*2)/ih);
        iw *= sc; ih *= sc;
        const ix = x + (w-iw)/2, iy = y + (h-ih)/2;
        ctx.save(); ctx.shadowColor = pal.accent; ctx.shadowBlur = 70; ctx.globalAlpha = 0.5; ctx.drawImage(srcImg,ix,iy,iw,ih); ctx.restore();
        ctx.drawImage(srcImg, ix, iy, iw, ih);
      } else {
```

Change to:

```js
      const srcIsArt = srcImg && (srcImg === arcArtImg || (srcImg === charImg && charImgIsArt));

      if (srcIsArt) {
        const iw = srcImg.naturalWidth || w, ih = srcImg.naturalHeight || h;
        const sc = Math.max(w / iw, h / ih) * state.artZoom;
        const dw = iw * sc, dh = ih * sc;
        ctx.drawImage(srcImg, x + (w - dw) / 2 + state.artOffsetX, y + (h - dh) / 2 + state.artOffsetY, dw, dh);
      } else if (srcImg) {
        const pad = Math.min(w, h) * 0.05;
        let iw = srcImg.naturalWidth || 400, ih = srcImg.naturalHeight || 400;
        const sc = Math.min((w-pad*2)/iw, (h-pad*2)/ih) * state.artZoom;
        iw *= sc; ih *= sc;
        const ix = x + (w-iw)/2 + state.artOffsetX, iy = y + (h-ih)/2 + state.artOffsetY;
        ctx.save(); ctx.shadowColor = pal.accent; ctx.shadowBlur = 70; ctx.globalAlpha = 0.5; ctx.drawImage(srcImg,ix,iy,iw,ih); ctx.restore();
        ctx.drawImage(srcImg, ix, iy, iw, ih);
      } else {
```

- [ ] **Step 5: Add the pointer-drag and wheel-zoom handlers**

Find:

```js
  browsePrevBtn.addEventListener('click', () => pageArchiveArt(-1));
  browseNextBtn.addEventListener('click', () => pageArchiveArt(1));

  // ── Init: wait for fonts before first draw ─────────────────────────────────
```

Change to:

```js
  browsePrevBtn.addEventListener('click', () => pageArchiveArt(-1));
  browseNextBtn.addEventListener('click', () => pageArchiveArt(1));

  // ── Art pan & zoom: drag to move, scroll wheel to scale ───────────────────
  // Only active when the pointer is within the currently active layout's
  // art panel (tracked by drawArtPanel into lastArtPanelRect every redraw).
  // Free dragging/zooming needs no bounds-checking — the panel (and the
  // card itself) are already clipped, so overflow is cropped for free.
  function clientToCardSpace(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (CARD_W / rect.width),
      y: (clientY - rect.top)  * (CARD_H / rect.height),
    };
  }
  function insideArtPanel(cardX, cardY) {
    if (!lastArtPanelRect) return false;
    const { x, y, w, h } = lastArtPanelRect;
    return cardX >= x && cardX <= x + w && cardY >= y && cardY <= y + h;
  }

  let artDrag = null; // { pointerId, startClientX, startClientY, startOffsetX, startOffsetY }
  let artDragRaf = null;

  canvas.addEventListener('pointerdown', e => {
    const p = clientToCardSpace(e.clientX, e.clientY);
    if (!insideArtPanel(p.x, p.y)) return;
    artDrag = {
      pointerId: e.pointerId,
      startClientX: e.clientX, startClientY: e.clientY,
      startOffsetX: state.artOffsetX, startOffsetY: state.artOffsetY,
    };
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', e => {
    if (!artDrag || e.pointerId !== artDrag.pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = CARD_W / rect.width, scaleY = CARD_H / rect.height;
    state.artOffsetX = artDrag.startOffsetX + (e.clientX - artDrag.startClientX) * scaleX;
    state.artOffsetY = artDrag.startOffsetY + (e.clientY - artDrag.startClientY) * scaleY;
    if (!artDragRaf) artDragRaf = requestAnimationFrame(() => { artDragRaf = null; drawCard(); });
  });

  function endArtDrag(e) {
    if (artDrag && e.pointerId === artDrag.pointerId) artDrag = null;
  }
  canvas.addEventListener('pointerup', endArtDrag);
  canvas.addEventListener('pointercancel', endArtDrag);

  const ART_ZOOM_MIN = 0.3, ART_ZOOM_MAX = 4, ART_ZOOM_STEP = 1.08;
  canvas.addEventListener('wheel', e => {
    const p = clientToCardSpace(e.clientX, e.clientY);
    if (!insideArtPanel(p.x, p.y)) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? ART_ZOOM_STEP : 1 / ART_ZOOM_STEP;
    state.artZoom = Math.min(ART_ZOOM_MAX, Math.max(ART_ZOOM_MIN, state.artZoom * factor));
    drawCard();
  }, { passive: false });

  // ── Init: wait for fonts before first draw ─────────────────────────────────
```

- [ ] **Step 6: Manual live-browser verification**

The page is served at `http://localhost:8080/server/skylanders/nfc-card/`
(Eleventy `--serve` is already running in this session on port 8080 —
confirm with `curl -s -o /dev/null -w "%{http_code}\n"
http://localhost:8080/server/skylanders/nfc-card/`, expect `200`). Reload
the tab after saving — Eleventy's watcher rebuilds `.njk` templates live,
no build command needed.

Drive it with Puppeteer connected to a real Chrome instance (the
established pattern this session):

```bash
rm -rf /tmp/chrome-debug-nfc1
open -a "Google Chrome" --args --remote-debugging-port=9777 --user-data-dir=/tmp/chrome-debug-nfc1 "about:blank" &
sleep 2
curl -s http://localhost:9777/json/version | head -3   # confirm it's up
```

Then a Node script (run from the project root so `puppeteer` resolves):

```js
import puppeteer from 'puppeteer';
const browser = await puppeteer.connect({ browserURL: 'http://localhost:9777' });
const page = await browser.newPage();
await page.goto('http://localhost:8080/server/skylanders/nfc-card/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 1000));

// Pick a character with art (first char-grid thumb)
await page.click('.char-thumb');
await new Promise(r => setTimeout(r, 800));

const canvasBox = await page.evaluate(() => {
  const r = document.getElementById('card-canvas').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const before = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());

// Drag from the panel's center toward its top-left corner
const cx = canvasBox.x + canvasBox.w * 0.5, cy = canvasBox.y + canvasBox.h * 0.3;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 60, cy - 40, { steps: 8 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 200));
const afterDrag = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
console.log('drag changed canvas:', before !== afterDrag);

// Scroll-zoom over the same point
await page.mouse.move(cx, cy);
await page.mouse.wheel({ deltaY: -240 });
await new Promise(r => setTimeout(r, 200));
const afterZoom = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
console.log('zoom changed canvas:', afterDrag !== afterZoom);

// Drag/scroll OUTSIDE the art panel (over the name plate near the bottom) should no-op
const outX = canvasBox.x + canvasBox.w * 0.5, outY = canvasBox.y + canvasBox.h * 0.92;
await page.mouse.move(outX, outY);
await page.mouse.down();
await page.mouse.move(outX - 60, outY - 40, { steps: 8 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 200));
const afterOutsideDrag = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
console.log('outside-panel drag was a no-op:', afterZoom === afterOutsideDrag);

await page.screenshot({ path: '/tmp/nfc-pan-zoom-half.png' });
await browser.disconnect();
```

If `page.mouse.wheel` isn't available in the installed Puppeteer version,
dispatch a synthetic event instead: `page.evaluate((x, y) => {
document.getElementById('card-canvas').dispatchEvent(new WheelEvent('wheel',
{ deltaY: -240, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}, cx, cy)`.

Expected: `drag changed canvas: true`, `zoom changed canvas: true`,
`outside-panel drag was a no-op: true`. Open
`/tmp/nfc-pan-zoom-half.png` and visually confirm the art is shifted up-left
and zoomed in compared to its default centered position.

Repeat the drag+zoom check (steps above, minus the no-op check) after
clicking the "Quarter Image" and "Full Image" layout swatches
(`document.querySelector('[data-layout="quarter"]')` /
`[data-layout="full"]`, then click and redo the drag/zoom against that
layout's panel position) — confirm both also report `true`/`true`.

Clean up: delete the temp screenshot/script, close the Chrome instance
(`pkill -f "remote-debugging-port=9777"`), remove
`/tmp/chrome-debug-nfc1`.

- [ ] **Step 7: Commit**

```bash
git add src/pages/server/skylanders/nfc-card.njk
git commit -m "feat: drag to pan and scroll to zoom the character art on the NFC card"
```

---

## Task 2: Reset button and automatic reset on image change

**Files:**
- Modify: `src/pages/server/skylanders/nfc-card.njk`
  - `.preview-actions` HTML (~line 298-301)
  - new `resetArtTransform()` helper, placed alongside the other small
    helpers (next to where it's first used is fine — see Step 2)
  - `selectCharacter` (~line 1446-1452)
  - the art-gallery `buildArcGallery` call inside `loadArchivePickers`
    (~line 1534-1535) — **not** the background/detail/attack-icon
    galleries, which don't change the character art
  - the custom-image upload handler (~line 1652-1661)
  - the `arc-clear` button handler (~line 1663-1669)
  - the `clear-custom` button handler (~line 1671-1676)
  - the posed-snapshot sessionStorage loader (~line 1731-1750)

**Interfaces:**
- Consumes: `state.artOffsetX`, `state.artOffsetY`, `state.artZoom` (Task 1).
- Produces: `function resetArtTransform()` — zeroes/defaults the three
  fields, does not call `drawCard()` itself (callers redraw afterward,
  matching the existing pattern at every call site below).

Line numbers above are from before Task 1's edits — Task 1 inserts ~50
lines before line 1710, so everything from `selectCharacter` onward will
have shifted down by roughly that amount. Use the "Find" text blocks below
to locate each edit; don't rely on the line numbers.

- [ ] **Step 1: Add the reset button**

Find:

```html
      <div class="preview-actions">
        <button class="nfc-btn" id="export-btn" disabled>↓ Export PNG</button>
        <span class="size-note">638 × 1011 px · transparent rounded corners · Cricut-ready</span>
      </div>
```

Change to:

```html
      <div class="preview-actions">
        <button class="clear-btn" id="reset-art-btn" style="max-width:260px">↺ Reset position</button>
        <button class="nfc-btn" id="export-btn" disabled>↓ Export PNG</button>
        <span class="size-note">638 × 1011 px · transparent rounded corners · Cricut-ready</span>
      </div>
```

- [ ] **Step 2: Add `resetArtTransform()` and wire the button**

Find:

```js
  document.getElementById('export-btn').addEventListener('click', () => {
    const slug = (state.customName.trim() || state.characterName || 'skylander').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const a = document.createElement('a'); a.download = `skylanders-nfc-${slug}.png`; a.href = canvas.toDataURL('image/png'); a.click();
  });
```

Change to:

```js
  document.getElementById('export-btn').addEventListener('click', () => {
    const slug = (state.customName.trim() || state.characterName || 'skylander').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const a = document.createElement('a'); a.download = `skylanders-nfc-${slug}.png`; a.href = canvas.toDataURL('image/png'); a.click();
  });

  // Zeroes the user's pan/zoom on the character art back to centered/
  // default fit. Does not redraw — every call site below already calls
  // drawCard() right after, whether directly or via an existing chain.
  function resetArtTransform() {
    state.artOffsetX = 0;
    state.artOffsetY = 0;
    state.artZoom = 1;
  }
  document.getElementById('reset-art-btn').addEventListener('click', () => { resetArtTransform(); drawCard(); });
```

- [ ] **Step 3: Reset on character selection**

Find:

```js
    // Reset archive selections on new character
    arcBgImg = null; arcDetailImg = null; arcArtImg = null; arcAttackIconImg = null;
    arcBgUrl = null; arcDetailUrl = null; arcArtUrl = null; arcAttackIconUrl = null;
    updateBgOpacityRow();
```

Change to:

```js
    // Reset archive selections on new character
    arcBgImg = null; arcDetailImg = null; arcArtImg = null; arcAttackIconImg = null;
    arcBgUrl = null; arcDetailUrl = null; arcArtUrl = null; arcAttackIconUrl = null;
    resetArtTransform();
    updateBgOpacityRow();
```

- [ ] **Step 4: Reset when picking archive character art (not background/detail/attack-icon)**

Find:

```js
    buildArcGallery(artGallery, artStatus, artImages, arcArtUrl,
      (url, img) => { arcArtUrl = url; arcArtImg = img; });
```

Change to:

```js
    buildArcGallery(artGallery, artStatus, artImages, arcArtUrl,
      (url, img) => { arcArtUrl = url; arcArtImg = img; resetArtTransform(); });
```

(`buildArcGallery`'s own thumb click handler calls `drawCard()` right
after invoking this callback — don't add another `drawCard()` call here.)

- [ ] **Step 5: Reset on custom image upload**

Find:

```js
    reader.onload = async ev => {
      charImg = await tryLoad(ev.target.result);
      charImgIsArt = true;
      if (charImg) { usingCustomImg = true; document.getElementById('custom-indicator').style.display = 'block'; document.getElementById('export-btn').disabled = false; drawCard(); }
    };
```

Change to:

```js
    reader.onload = async ev => {
      charImg = await tryLoad(ev.target.result);
      charImgIsArt = true;
      if (charImg) { usingCustomImg = true; resetArtTransform(); document.getElementById('custom-indicator').style.display = 'block'; document.getElementById('export-btn').disabled = false; drawCard(); }
    };
```

- [ ] **Step 6: Reset on "Clear archive layers"**

Find:

```js
  document.getElementById('arc-clear').addEventListener('click', () => {
    arcBgImg = null; arcDetailImg = null; arcArtImg = null; arcAttackIconImg = null;
    arcBgUrl = null; arcDetailUrl = null; arcArtUrl = null; arcAttackIconUrl = null;
    updateBgOpacityRow();
    document.querySelectorAll('.arc-thumb').forEach(t => t.classList.remove('selected'));
    drawCard();
  });
```

Change to:

```js
  document.getElementById('arc-clear').addEventListener('click', () => {
    arcBgImg = null; arcDetailImg = null; arcArtImg = null; arcAttackIconImg = null;
    arcBgUrl = null; arcDetailUrl = null; arcArtUrl = null; arcAttackIconUrl = null;
    resetArtTransform();
    updateBgOpacityRow();
    document.querySelectorAll('.arc-thumb').forEach(t => t.classList.remove('selected'));
    drawCard();
  });
```

- [ ] **Step 7: Reset on "Clear custom image"**

Find:

```js
  document.getElementById('clear-custom').addEventListener('click', async () => {
    document.getElementById('custom-img').value = ''; document.getElementById('custom-indicator').style.display = 'none'; usingCustomImg = false;
    if (state.characterName) { const c = CHARS.find(c => c.name === state.characterName); if (c) charImg = await loadCharImg(c.name); }
    else charImg = null;
    drawCard();
  });
```

Change to:

```js
  document.getElementById('clear-custom').addEventListener('click', async () => {
    document.getElementById('custom-img').value = ''; document.getElementById('custom-indicator').style.display = 'none'; usingCustomImg = false;
    resetArtTransform();
    if (state.characterName) { const c = CHARS.find(c => c.name === state.characterName); if (c) charImg = await loadCharImg(c.name); }
    else charImg = null;
    drawCard();
  });
```

- [ ] **Step 8: Reset when loading a posed snapshot from the bone-posing detail view**

Find:

```js
        const img = await tryLoad(artData);
        if (img) {
          charImg = img;
          // Transparent character cutout (posed 3D render), not a full-bleed
          // painted illustration — gets the contain-fit + glow treatment
          // drawArtPanel uses for in-game cutouts, not the cover-fit one.
          charImgIsArt = false;
          usingCustomImg = true;
          document.getElementById('custom-indicator').style.display = 'block';
          document.getElementById('export-btn').disabled = false;
          drawCard();
        }
```

Change to:

```js
        const img = await tryLoad(artData);
        if (img) {
          charImg = img;
          // Transparent character cutout (posed 3D render), not a full-bleed
          // painted illustration — gets the contain-fit + glow treatment
          // drawArtPanel uses for in-game cutouts, not the cover-fit one.
          charImgIsArt = false;
          usingCustomImg = true;
          resetArtTransform();
          document.getElementById('custom-indicator').style.display = 'block';
          document.getElementById('export-btn').disabled = false;
          drawCard();
        }
```

- [ ] **Step 9: Manual live-browser verification**

Reuse the Chrome-debug-instance pattern from Task 1, Step 6 (fresh
`--user-data-dir`, fresh port). With the page loaded at
`http://localhost:8080/server/skylanders/nfc-card/`:

```js
import puppeteer from 'puppeteer';
const browser = await puppeteer.connect({ browserURL: 'http://localhost:<port>' });
const page = await browser.newPage();
await page.goto('http://localhost:8080/server/skylanders/nfc-card/', { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 1000));

const thumbs = await page.$$('.char-thumb');
await thumbs[0].click();
await new Promise(r => setTimeout(r, 800));
const freshA = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());

// Drag the art away from its default position
const canvasBox = await page.evaluate(() => {
  const r = document.getElementById('card-canvas').getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const cx = canvasBox.x + canvasBox.w * 0.5, cy = canvasBox.y + canvasBox.h * 0.3;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 80, cy - 60, { steps: 8 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 200));
const draggedA = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
console.log('drag actually moved it:', freshA !== draggedA);

// Click "Reset position" — should match the fresh, undragged render exactly
await page.click('#reset-art-btn');
await new Promise(r => setTimeout(r, 200));
const resetA = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
console.log('reset button restores exact original render:', resetA === freshA);

// Drag again, then switch to a different character — should auto-reset
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx - 80, cy - 60, { steps: 8 });
await page.mouse.up();
await new Promise(r => setTimeout(r, 200));
await thumbs[1].click();
await new Promise(r => setTimeout(r, 800));
const freshB = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
await thumbs[0].click();
await new Promise(r => setTimeout(r, 800));
const backToA = await page.evaluate(() => document.getElementById('card-canvas').toDataURL());
console.log('switching characters auto-reset pan/zoom:', backToA === freshA);

await browser.disconnect();
```

Expected: all three `console.log` lines print `true`. The middle one in
particular proves the reset button's effect is pixel-identical to a never-
dragged render, not just "close enough." The third proves the auto-reset
on character switch works by comparing against the same `freshA` baseline
captured before any dragging happened.

Then manually (visually, via screenshots) confirm the remaining four
auto-reset paths — picking a different archive art thumbnail for the same
character, uploading a custom image, clicking "Clear archive layers", and
clicking "Clear custom image" — each one resets a dragged/zoomed position
back to centered/default. These four don't need the same byte-exact
`toDataURL()` comparison technique since they change `arcArtImg`/`charImg`
identity rather than swapping between two already-loaded character images,
but they all flow through the same `resetArtTransform()` call confirmed
working above, so a visual spot-check (drag, then trigger the action,
screenshot, confirm it's centered again) is sufficient.

Clean up: delete any temp scripts/screenshots, close the Chrome instance,
remove its temp profile dir.

- [ ] **Step 10: Commit**

```bash
git add src/pages/server/skylanders/nfc-card.njk
git commit -m "feat: add reset-position button and auto-reset on character/art change"
```

---

## Final Verification

1. Open `/server/skylanders/nfc-card/` for real, pick a character, drag and
   scroll-zoom the art by hand, confirm it feels responsive (no visible lag
   — the `requestAnimationFrame` throttle in Task 1 should keep dragging
   smooth even though `drawCard()` redraws the entire card every frame).
2. Export a PNG after panning/zooming — confirm the exported file reflects
   the adjusted position (it reads from the same canvas `drawCard()` just
   painted, so this should already work without any extra code, but
   confirm by eye).
3. Repeat the full pose → "Send to NFC" flow from the archive curation tool
   (the feature this builds on) end to end: pose a character in the
   bone-posing detail view, send to NFC, then drag/zoom the resulting
   transparent cutout into place on the card.
