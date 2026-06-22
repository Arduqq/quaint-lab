# Skylanders Hub Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Skylanders hub's card-grid + portal-placeholder layout with a compact, darkSpyro-style page: an action-art banner with randomized character renders, a single-row nav bar, and a plain bordered list of the same destination links.

**Architecture:** One static Eleventy page (`src/pages/server/skylanders/index.njk`) gets a full markup/CSS rewrite (Task 1), then a small client-side randomization script plus one new build-time Nunjucks filter (Task 2) populate the banner's character art from the existing `src/_data/skylanders.json` roster on every page load.

**Tech Stack:** Eleventy (Nunjucks templates), plain CSS (no preprocessor), vanilla JS (no framework) — matching the rest of this codebase.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-22-skylanders-hub-redesign-design.md` — every requirement below traces to a section there.
- Reuse existing fonts/colors only: `'Bangers'` (display), `'Nunito'` (body), `--gold: #ffcc00`, `--gold2: #ff9900`. Do not introduce new fonts or colors.
- Banner art is exactly `RH-2488`, served at `/images/skylanders-archive/ring-of-heroes/banners/banner-assets-used-for-the-gacha-segments-of-sky_748388608360235000_2.png` — already present in `src/images/` (confirmed on disk), no asset work needed.
- The 4 destination hrefs and their description copy are unchanged from today's page: `/server/skylanders/archive/`, `/server/skylanders/collection/`, `/server/skylanders-builder/`, `/server/skylanders/nfc-card/`. The only copy change is the third link's label: "Collection Maker" → "Builder".
- The "Page Doll" placeholder carries forward as a disabled (no-link) fifth entry, not dropped.
- No hits counter, no marquee/blink, no visitor badges.
- No test framework exists in this project — verification is manual/scripted via `curl`, `grep`, one-shot Eleventy builds, and `npx playwright screenshot --browser=webkit` (matching this session's established convention of using WebKit, not Chromium, for any browser-based check).
- This is the *only* page being touched. Do not modify `scripts/reclassify-tumblr.mjs`, `scripts/archive-server.mjs`, or any file under `skylanders-archive/` — those belong to the unrelated curation pipeline.

---

### Task 1: Static page rewrite (shell, banner, nav, link list)

**Files:**
- Modify: `src/pages/server/skylanders/index.njk` (full rewrite, currently 440 lines)

**Interfaces:**
- Produces: three empty `<img class="hub-banner-char">` elements inside `#hub-banner-chars`, with `src=""` and `alt=""` — Task 2's script finds and populates these by class name and DOM order (`document.querySelectorAll('.hub-banner-char')`, indices 0-2).
- Consumes: nothing from other tasks (this task has no dependency on Task 2; the page is fully valid and visually complete except the 3 character images render as broken/blank until Task 2 wires them up).

- [ ] **Step 1: Replace the entire file**

Replace the full contents of `src/pages/server/skylanders/index.njk` with:

```njk
---
title: Skylanders Hub
layout: blank.njk
permalink: "/server/skylanders/"
---

<style>
@import url('https://fonts.googleapis.com/css2?family=Bangers&family=Nunito:wght@700;900&display=swap');

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --gold:  #ffcc00;
  --gold2: #ff9900;
}

html, body {
  height: 100%;
  overflow-x: hidden;
}

body {
  font-family: 'Nunito', 'Segoe UI', sans-serif;
  background-color: #09182e;
  color: #fff;
  min-height: 100vh;
}

/* ── Page shell ── */
#hub-root {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 48px 24px 60px;
}

#hub-panel {
  width: 100%;
  max-width: 720px;
  border: 1px solid #3a4a66;
}

/* ── Banner ── */
#hub-banner {
  position: relative;
  height: 92px;
  overflow: hidden;
}
#hub-banner-bg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center 35%;
}
#hub-banner-scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(to bottom,
    rgba(9,24,46,0) 0%,
    rgba(9,24,46,0.45) 60%,
    rgba(9,24,46,0.92) 100%);
}
#hub-banner-chars {
  position: absolute;
  right: 90px;
  bottom: -12px;
  display: flex;
  align-items: flex-end;
}
.hub-banner-char {
  height: 90px;
  margin-right: -22px;
  opacity: 0.92;
  filter: drop-shadow(0 3px 6px rgba(0,0,0,0.6));
}
.hub-banner-char:nth-child(2) {
  height: 96px;
}
.hub-banner-char:last-child {
  margin-right: 0;
}

#hub-wordmark {
  position: absolute;
  left: 20px;
  top: 50%;
  transform: translateY(-50%);
  font-family: 'Bangers', Impact, sans-serif;
  font-size: clamp(1.4rem, 5vw, 1.75rem);
  letter-spacing: 1px;
  color: var(--gold);
  text-shadow: 2px 2px 0 #09182e, -1px -1px 0 var(--gold2);
}

/* ── Nav bar ── */
#hub-nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: clamp(12px, 4vw, 24px);
  padding: 9px 24px;
  background: #0c1e38;
  border-top: 2px solid var(--gold);
  border-bottom: 1px solid #25324a;
  font-weight: 700;
  font-size: 0.8rem;
  letter-spacing: 0.5px;
}
#hub-nav a {
  color: #cfd8e8;
  text-decoration: none;
  text-transform: uppercase;
  transition: color 0.15s;
}
#hub-nav a:hover {
  color: var(--gold);
  text-decoration: underline;
}
#hub-nav-back {
  margin-left: auto;
  color: #445166 !important;
  font-weight: 400;
  text-transform: none;
}

/* ── Link list ── */
#hub-links {
  padding: 18px 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hub-link-box {
  border: 1px solid #25324a;
  padding: 10px;
}
.hub-link-box a {
  color: var(--gold);
  font-weight: bold;
  text-decoration: underline;
  font-size: 0.95rem;
}
.hub-link-box p {
  color: #a8b4cc;
  font-size: 0.78rem;
  margin-top: 3px;
}
.hub-link-box.disabled {
  opacity: 0.5;
}
.hub-link-box.disabled span {
  color: #cfd8e8;
  font-weight: bold;
  font-size: 0.95rem;
}

/* ── Responsive ── */
@media (max-width: 600px) {
  #hub-nav { gap: 12px; }
  #hub-banner-chars { right: 16px; }
  .hub-banner-char { height: 64px; }
  .hub-banner-char:nth-child(2) { height: 70px; }
}
</style>

<div id="hub-root">
  <div id="hub-panel">

    <div id="hub-banner">
      <img id="hub-banner-bg" src="/images/skylanders-archive/ring-of-heroes/banners/banner-assets-used-for-the-gacha-segments-of-sky_748388608360235000_2.png" alt="">
      <div id="hub-banner-scrim"></div>
      <div id="hub-banner-chars">
        <img class="hub-banner-char" src="" alt="">
        <img class="hub-banner-char" src="" alt="">
        <img class="hub-banner-char" src="" alt="">
      </div>
      <div id="hub-wordmark">SKYLANDERS HUB</div>
    </div>

    <nav id="hub-nav">
      <a href="/server/skylanders/archive/">Archive</a>
      <a href="/server/skylanders/collection/">Collection</a>
      <a href="/server/skylanders-builder/">Builder</a>
      <a href="/server/skylanders/nfc-card/">NFC Cards</a>
      <a id="hub-nav-back" href="/server/">&larr; /server/</a>
    </nav>

    <div id="hub-links">
      <div class="hub-link-box">
        <a href="/server/skylanders/archive/">Archive</a>
        <p>Browse the full Tumblr image archive — classify, tag, and annotate</p>
      </div>
      <div class="hub-link-box">
        <a href="/server/skylanders/collection/">Collection</a>
        <p>View your full Skylanders collection across all six games</p>
      </div>
      <div class="hub-link-box">
        <a href="/server/skylanders-builder/">Builder</a>
        <p>Build and customize your collection data, mark owned figures</p>
      </div>
      <div class="hub-link-box">
        <a href="/server/skylanders/nfc-card/">NFC Cards</a>
        <p>Design custom NFC card art for any Skylander character</p>
      </div>
      <div class="hub-link-box disabled">
        <span>Page Doll</span>
        <p>Coming Soon</p>
      </div>
    </div>

  </div>
</div>
```

- [ ] **Step 2: Build the site and confirm the old elements are gone / new ones are present**

Run:
```bash
npx @11ty/eleventy
grep -o 'id="[a-z-]*"' dist/server/skylanders/index.html | sort -u
```

Expected output includes `id="hub-banner"`, `id="hub-banner-bg"`, `id="hub-banner-scrim"`, `id="hub-banner-chars"`, `id="hub-wordmark"`, `id="hub-nav"`, `id="hub-nav-back"`, `id="hub-links"`, `id="hub-panel"`, `id="hub-root"` — and must NOT include `id="hub-bg"`, `id="hub-logo"`, `id="hub-stage"`, `id="hub-cards"`, `id="hub-portal"`, `id="hub-back"`, `id="portal-caption"`.

Also run:
```bash
grep -c 'class="hub-link-box' dist/server/skylanders/index.html
grep -c 'class="hub-banner-char"' dist/server/skylanders/index.html
```
Expected: `5` (four real links + one disabled) and `3` respectively.

- [ ] **Step 3: Visual check via WebKit screenshot**

```bash
# Start (or confirm running) the Eleventy dev server bound to THIS checkout's root —
# if you're in a worktree, run this from the worktree root, not the main checkout.
npx @11ty/eleventy --serve --port=8080 &
sleep 3
npx playwright screenshot --browser=webkit http://localhost:8080/server/skylanders/ /tmp/hub-task1.png
```

Open `/tmp/hub-task1.png` (Read tool can display it). Confirm: a bordered panel with the RH-2488 banner art, a gold "SKYLANDERS HUB" wordmark on the left of the banner, a dark nav row with 4 gold-hover links + a "← /server/" link on the right, and 5 bordered boxes below (4 with gold links + description text, 1 dimmed "Page Doll / Coming Soon" with no link). The 3 character-art slots in the banner will render as nothing (empty `src`) — that's expected until Task 2.

Stop the dev server when done: `kill %1` (or find/kill the `eleventy --serve` process).

- [ ] **Step 4: Commit**

```bash
git add src/pages/server/skylanders/index.njk
git commit -m "feat: rewrite Skylanders hub as a darkSpyro-style banner+nav+link-list page"
```

---

### Task 2: Randomized banner character art

**Files:**
- Modify: `.eleventy.js:44-46` (insert a new filter directly after the existing `join` filter)
- Modify: `src/pages/server/skylanders/index.njk` (append data + script, no markup/CSS changes)

**Interfaces:**
- Consumes: `.hub-banner-char` (3 elements, DOM order) and `#hub-banner-chars` from Task 1's markup. Consumes the existing global Eleventy data `skylanders` (`src/_data/skylanders.json`, an array of `{ game, characters: [{ name, render, figures }] }`, 159 characters total across 6 games) — already loaded automatically by Eleventy, no new data file needed.
- Produces: a new Nunjucks filter `json` (`eleventyConfig.addFilter("json", obj => JSON.stringify(obj))`) usable by any future template in this repo.

- [ ] **Step 1: Add the `json` filter**

In `.eleventy.js`, find the existing `join` filter:

```js
  eleventyConfig.addFilter("join", (arr, sep = ",") =>
    Array.isArray(arr) ? arr.join(sep) : arr || ""
  );
```

Insert immediately after it (before the `toSlugs` filter):

```js
  eleventyConfig.addFilter("json", (obj) => JSON.stringify(obj));
```

- [ ] **Step 2: Verify the filter in isolation**

```bash
node -e "
const filters = {};
const mockConfig = {
  addFilter: (name, fn) => { filters[name] = fn; },
  addPassthroughCopy: () => {},
  addCollection: () => {}
};
require('./.eleventy.js')(mockConfig);
const input = { a: 1, b: [1, 2] };
const out = filters.json(input);
if (out !== JSON.stringify(input)) { console.error('FAIL:', out); process.exit(1); }
console.log('PASS:', out);
"
```

Expected: `PASS: {"a":1,"b":[1,2]}` — confirms the filter is registered and behaves as plain `JSON.stringify`.

- [ ] **Step 3: Add the data + script to the page**

In `src/pages/server/skylanders/index.njk`, immediately before the final closing `</div>` (the one that closes `#hub-root`), add:

```njk
  <script>
  (function() {
    var games = {{ skylanders | json | safe }};
    var all = games.flatMap(function(g) { return g.characters; })
                    .filter(function(c) { return c.render; });
    var picks = all.slice()
                    .sort(function() { return Math.random() - 0.5; })
                    .slice(0, 3);
    document.addEventListener('DOMContentLoaded', function() {
      var imgs = document.querySelectorAll('.hub-banner-char');
      picks.forEach(function(c, i) {
        if (!imgs[i]) return;
        imgs[i].src = '/images/skylanders-archive/' + c.render;
        imgs[i].alt = c.name;
      });
    });
  })();
  </script>
```

So the end of the file reads:

```njk
    </div>

  </div>

  <script>
  (function() {
    var games = {{ skylanders | json | safe }};
    var all = games.flatMap(function(g) { return g.characters; })
                    .filter(function(c) { return c.render; });
    var picks = all.slice()
                    .sort(function() { return Math.random() - 0.5; })
                    .slice(0, 3);
    document.addEventListener('DOMContentLoaded', function() {
      var imgs = document.querySelectorAll('.hub-banner-char');
      picks.forEach(function(c, i) {
        if (!imgs[i]) return;
        imgs[i].src = '/images/skylanders-archive/' + c.render;
        imgs[i].alt = c.name;
      });
    });
  })();
  </script>
</div>
```

(The outer `</div>` closes `#hub-root`; the script sits inside it, after `#hub-panel` closes — placement inside vs. just before that final tag makes no behavioral difference, just keep it as the last child of `#hub-root`.)

- [ ] **Step 4: Build and confirm the data serialized correctly**

```bash
npx @11ty/eleventy
grep -o '"name":"Spyro"[^}]*' dist/server/skylanders/index.html
```

Expected: a match containing `"name":"Spyro"` followed by a `"render":"spyros-adventure/character-art/character-art-spyro.png"` fragment — confirms the `skylanders` global data was correctly flattened into the inline script as JSON.

- [ ] **Step 5: Visual + behavioral check via WebKit**

```bash
npx @11ty/eleventy --serve --port=8080 &
sleep 3
npx playwright screenshot --browser=webkit http://localhost:8080/server/skylanders/ /tmp/hub-task2-a.png
npx playwright screenshot --browser=webkit http://localhost:8080/server/skylanders/ /tmp/hub-task2-b.png
md5 /tmp/hub-task2-a.png /tmp/hub-task2-b.png
kill %1
```

Open `/tmp/hub-task2-a.png` (Read tool). Confirm: the banner now shows 3 character cutouts clustered together near the right side of the banner, in front of the RH-2488 art, with the wordmark still legible on the left.

Check the `md5` output: the two checksums should differ (each page load independently picks 3 of 159 characters at random — a collision producing the exact same 3 images in the same order across both loads is astronomically unlikely, so differing checksums confirms the randomization runs per-load rather than being baked in at build time).

- [ ] **Step 6: Commit**

```bash
git add .eleventy.js src/pages/server/skylanders/index.njk
git commit -m "feat: randomize Skylanders hub banner character art per page load"
```

---

## Self-Review Notes

- **Spec coverage:** Section 1 (page shell) → Task 1 Step 1. Section 2 (banner) → Task 1 Step 1 (`#hub-banner` block) + Task 2 (character population). Section 3 (randomization script) → Task 2 Steps 1-3. Section 4 (nav bar) → Task 1 Step 1 (`#hub-nav`). Section 5 (link list) → Task 1 Step 1 (`#hub-links`, including the disabled fifth box). Section 6 (responsive) → Task 1 Step 1 (`@media (max-width: 600px)` block). Error Handling section's three cases are all structural consequences of Task 1/2's markup (no extra code needed: empty `src` never points at a missing file, the disabled box has no `<a>`, and the data-shape assumption matches every other consumer of `skylanders.json`). Testing section's 5 manual checks map directly to Task 1 Step 3 and Task 2 Step 5.
- **Placeholder scan:** no TBD/TODO; every step shows complete, runnable code.
- **Type consistency:** `.hub-banner-char` (CSS class, Task 1) matches `document.querySelectorAll('.hub-banner-char')` (Task 2) exactly. The `json` filter name and signature used in Task 2 Step 3 (`{{ skylanders | json | safe }}`) matches the filter registered in Task 2 Step 1. `c.render` / `c.name` field names match `src/_data/skylanders.json`'s actual shape (verified during brainstorming).
