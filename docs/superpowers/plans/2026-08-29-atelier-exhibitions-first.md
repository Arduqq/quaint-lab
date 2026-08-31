# Atelier Exhibitions-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign `/atelier/` to lead with curated exhibitions (Karat + future canvas exhibitions) instead of a raw content grid, with the existing category-based browsing moved to a new secondary `/atelier/browse/` page.

**Architecture:** A small backend/builder addition (an optional `description` field on canvas exhibitions, so every exhibition type has one) enables a uniform "title + blurb" card list driven by the pre-existing `collections.exhibitions` (already globs every exhibition `.md` regardless of layout). The old grid content is split: its "Recent artwork" strip is dropped (redundant with the site's RSS feed), and its category-block browsing moves to a new page reusing the exact CSS classes it already has.

**Tech Stack:** Node.js `http` server (Studio), Eleventy v3 (public site), vanilla JS, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-29-atelier-exhibitions-first-design.md`

## Global Constraints

- No new npm dependencies.
- No new CSS — every class this plan uses (`.atelier-cat-block`, `.atelier-flex-gallery`, `.atelier-thumb`, `.badge-new`, `.atelier-more-grid`, `.atelier-more-item`, `.atelier-more-thumbs`, `.atelier-more-label`, `.atelier-cat-count`, `.feed`, `.post`, `.post-title`, `.post-excerpt`) already exists in `src/css/style.css` — confirmed present before writing this plan.
- No automated test suite exists in this repo — verification is manual.
- `/atelier/browse/` is reachable only via a link from `/atelier/` — it must not be added to primary site navigation.
- Migrating Karat's content or building the Helix Vacui exhibition's content is explicitly out of scope — this plan only prepares the pages/data model.

---

## Task 1: `description` field on canvas exhibitions

**Files:**
- Modify: `studio/server.js:190-248` (`readExhibition`, `writeExhibition`), `studio/server.js:599-632` (`POST`/`PUT /api/exhibition` routes)
- Modify: `studio/public/index.html:50-57` (exhibition editor toolbar)
- Modify: `studio/public/exhibition-builder.js:34-66` (`createExhibition`, `openExhibitionEditor`), `studio/public/exhibition-builder.js:443-471` (`saveExhibition`)

**Interfaces:**
- Consumes: existing `exhibitionPaths()`, `parseFM()`/`dumpFM()`, `CANVAS_LAYOUT` constant, `exState.meta` object shape (`{slug, title, canvasWidth, canvasHeight, background}`), `api()`/`showToast()` from `app.js`.
- Produces (consumed by Task 2): `readExhibition()`'s returned `meta` now includes `description` (a string, `''` if never set); `writeExhibition()` persists it in frontmatter. Task 2 doesn't call any of this task's code directly — it reads the persisted `.md` frontmatter through Eleventy's normal data cascade — but needs to know the field is named `description` and is always a string (never `undefined`) on any canvas exhibition written after this task lands.

- [ ] **Step 1: Persist `description` in `readExhibition`/`writeExhibition`**

In `studio/server.js`, `readExhibition()` (around line 190), add `description` to the returned `meta` object:

```js
  const result = {
    meta: {
      slug: safeSlug,
      title:       data.posttitle || safeSlug,
      description: data.description || '',
      canvasWidth:  data.canvasWidth  || 1600,
      canvasHeight: data.canvasHeight || 1000,
      background:   data.background  || '#1a1a2e',
    },
    elements,
  };
```

In `writeExhibition()` (around line 221), add `description` to the `data` object written to frontmatter:

```js
  const data = {
    title:     'Exhibition',
    ...existing,
    posttitle:   meta.title,
    description: meta.description || '',
    layout:      CANVAS_LAYOUT,
    permalink:   `atelier/${safeSlug}/`,
    canvasWidth:  meta.canvasWidth,
    canvasHeight: meta.canvasHeight,
    background:   meta.background,
  };
```

(`...existing` still comes first so a pre-existing `description` from a legacy or hand-edited file is preserved as a fallback, but `meta.description` — what the builder actually sent — always wins, matching how every other managed field already behaves here.)

- [ ] **Step 2: Accept `description` in the POST/PUT routes**

In `studio/server.js`, `POST /api/exhibition` (around line 600):

```js
  if (method === 'POST' && pathname === '/api/exhibition') {
    const { slug, title, description, canvasWidth, canvasHeight, background } = await parseBody(req);
    if (!slug || !title) return send(res, 400, { error: 'Missing slug or title' });
    const { slug: safeSlug, md } = exhibitionPaths(slug);
    if (!safeSlug) return send(res, 400, { error: 'Slug is empty after sanitizing' });
    if (fs.existsSync(md)) return send(res, 409, { error: 'Slug already exists' });
    try {
      writeExhibition(slug, {
        title,
        description:  description || '',
        canvasWidth:  canvasWidth  || 1600,
        canvasHeight: canvasHeight || 1000,
        background:   background   || '#1a1a2e',
      }, []);
    } catch (e) {
      return send(res, 409, { error: String(e.message) });
    }
    return send(res, 201, readExhibition(slug));
  }
```

`PUT /api/exhibition` (around line 620) needs no change — it already forwards the whole `meta` object it receives straight into `writeExhibition(slug, meta, elements)`, so once the builder includes `description` in that object (Step 4), it flows through automatically.

- [ ] **Step 3: Add a description textarea to the editor toolbar**

In `studio/public/index.html`, the `.exhibition-toolbar` div (lines 50-57) currently has the title span, "+ Text", the background color picker, and Save, in a single non-wrapping row. A textarea doesn't belong inline in that row — add it as a second row, right after the toolbar div closes:

```html
      <div class="exhibition-toolbar">
        <button id="btn-exhibition-back" class="btn-secondary">← Back</button>
        <span id="exhibition-editor-title" class="section-label"></span>
        <div style="flex:1"></div>
        <button id="btn-add-text" class="btn-secondary">+ Text</button>
        <label class="exhibition-bg-label">bg <input type="color" id="exhibition-bg-color" value="#1a1a2e"></label>
        <button id="btn-save-exhibition" class="btn-primary">Save</button>
      </div>
      <div class="exhibition-description-row" style="padding:0 .75rem .5rem; background:var(--surface);">
        <textarea id="exhibition-description" placeholder="Description shown on the atelier page…" rows="2" style="width:100%; resize:vertical;"></textarea>
      </div>
```

- [ ] **Step 4: Wire the description field into the builder's JS**

In `studio/public/exhibition-builder.js`, `createExhibition()` (line 34) doesn't need a description at creation time (matches the spec's "no validation beyond what already exists" — you write it in after creating, same as you'd set up the canvas itself before it means anything). No change there.

`openExhibitionEditor()` (line 47), add one line after the existing `exhibition-bg-color` line (58):

```js
  document.getElementById('exhibition-editor-title').textContent = ex.meta.title;
  document.getElementById('exhibition-bg-color').value = ex.meta.background;
  document.getElementById('exhibition-description').value = ex.meta.description || '';
```

`saveExhibition()` (line 443), add `description` to the `meta` object sent in the `PUT` body:

```js
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
```

(Reading straight from the DOM element here, rather than keeping a separate `exState.meta.description` in sync on every keystroke, matches how `exhibition-bg-color`'s value is read indirectly through `exState.meta.background` today but is simpler for a plain textarea with no live-canvas effect — there's nothing on the canvas that needs to reflect the description as you type, unlike the background color.)

- [ ] **Step 5: Verify manually**

```bash
npm run studio
```
Open the Exhibitions tab, create a test exhibition, type a description into the new textarea, click Save, click ← Back, reopen it — confirm the description reappears exactly as typed. Then verify via curl that it's actually in the frontmatter:
```bash
cat src/posts/exhibitions/<your-test-slug>.md
```
Expected: a `description: "..."` line (or block form, depending on `dumpFM`'s quoting rules for the text you used) in the frontmatter. Delete the test exhibition's two files afterward.

- [ ] **Step 6: Commit**

```bash
git add studio/server.js studio/public/index.html studio/public/exhibition-builder.js
git commit -m "feat: add description field to canvas exhibitions"
```

---

## Task 2: `/atelier/` front page (exhibitions-first)

**Files:**
- Modify: `src/pages/atelier.njk` (full replacement of the file's content)

**Interfaces:**
- Consumes: `collections.exhibitions` (already defined in `.eleventy.js`, globs every `.md` under `src/posts/exhibitions/`); each exhibition's `data.posttitle`, `data.description` (Task 1 guarantees this is always a string, `''` if unset, on canvas exhibitions; Karat already has a real one), and `.url`. Reuses the existing `.feed`/`.post`/`.post-info`/`.post-title`/`.post-excerpt` CSS classes (already in `src/css/style.css`, currently used by `categories.njk`'s non-artwork feed) — no new CSS.
- Produces: nothing consumed by Task 3 — the two pages are independent, linked only by a plain `<a href>`.

- [ ] **Step 1: Replace `atelier.njk`'s content**

Replace the entire body of `src/pages/atelier.njk` (keep the existing frontmatter — `title`, `layout: base.njk`, `permalink: "atelier/"` — unchanged) with:

```njk
<section>
  <h2>{{ title }} <a href="/feed-artwork.xml" target="_blank" style="font-size: 0.8rem; vertical-align: middle;">[RSS Feed]</a></h2>
  <p class="tagline">Curated exhibitions of my artwork — each one a small, hand-arranged show, not just a feed.</p>
</section>

<section class="feed">
  {% for exhibition in collections.exhibitions %}
    <a class="post" href="{{ exhibition.url }}">
      <div class="post-info">
        <h3 class="post-title">{{ exhibition.data.posttitle }}</h3>
        {% if exhibition.data.description %}
          <p class="post-excerpt">{{ exhibition.data.description }}</p>
        {% endif %}
      </div>
    </a>
  {% endfor %}
</section>

<section>
  <p><a href="/atelier/browse/">Browse everything by category →</a></p>
</section>
```

The `{% if exhibition.data.description %}` guard matters even though Task 1 makes canvas exhibitions always have a `description` key: Karat and any future legacy-style exhibition might not, and an empty `<p class="post-excerpt"></p>` would render as ugly empty vertical space in the `.post` flex layout.

- [ ] **Step 2: Verify manually**

```bash
npx @11ty/eleventy
grep -A3 'class="post"' dist/atelier/index.html
```
Expected: one `.post` block for Karat with its existing real description, and (if you left a test canvas exhibition from Task 1's verification around, or create a fresh one) one for it too. Confirm neither the old `.exhibitions`/`.categories-gallery` markup nor an `illustration-gallery`/"Recent Exhibition Inventory" section appears anywhere in `dist/atelier/index.html`. Load the page in a browser and confirm the cards are readable and link correctly. Clean up `dist/` and any test exhibition afterward.

- [ ] **Step 3: Commit**

```bash
git add src/pages/atelier.njk
git commit -m "feat: redesign atelier front page to lead with exhibitions"
```

---

## Task 3: `/atelier/browse/` secondary page

**Files:**
- Create: `src/pages/atelier-browse.njk`

**Interfaces:**
- Consumes: `collections.artworkByCategory` (already defined in `.eleventy.js`), the `slug` filter, `collections.newestArtworkUrls`. Reuses the exact CSS classes already in `src/css/style.css`: `.atelier-cat-block`, `.atelier-cat-count`, `.atelier-flex-gallery`, `.atelier-thumb`, `.badge-new`, `.atelier-more-grid`, `.atelier-more-item`, `.atelier-more-thumbs`, `.atelier-more-label`.
- Produces: nothing consumed elsewhere — reachable only via the link Task 2 added to `/atelier/`.

- [ ] **Step 1: Create the browse page**

Create `src/pages/atelier-browse.njk`:

```njk
---
title: "Browse"
layout: base.njk
permalink: "atelier/browse/"
---
<section>
  <h2>{{ title }}</h2>
  <p class="tagline">Every artwork, organized by category. Looking for something specific? Start here — or head back to the <a href="/atelier/">curated exhibitions</a>.</p>
</section>

<section class="atelier-all">

  {% set featuredSlugs = ['karat', 'helix-vacui', 'character', 'watercolor', 'photos', 'concepts', 'scene'] %}
  {% for cat in collections.artworkByCategory %}
    {% set catSlug = cat.name | slug %}
    {% if catSlug in featuredSlugs %}
      <div class="atelier-cat-block">
        <h3>{{ cat.name }} <a href="/categories/{{ catSlug }}/" class="atelier-cat-count">{{ cat.artworks | length }}</a></h3>
        <div class="atelier-flex-gallery">
          {% for artwork in cat.artworks | limit(20) %}
            <a class="atelier-thumb" href="{{ artwork.url }}" title="{{ artwork.data.posttitle }}">
              <img src="/images/artwork/thumbnails/{{ artwork.data.image }}" alt="{{ artwork.data.posttitle }}">
              {% if artwork.url in collections.newestArtworkUrls %}<span class="badge-new">new</span>{% endif %}
            </a>
          {% endfor %}
        </div>
      </div>
    {% endif %}
  {% endfor %}

  <div class="atelier-cat-block">
    <h3>More</h3>
    <div class="atelier-more-grid">
      {% for cat in collections.artworkByCategory %}
        {% set catSlug = cat.name | slug %}
        {% if not (catSlug in featuredSlugs) %}
          <a class="atelier-more-item" href="/categories/{{ catSlug }}/">
            <div class="atelier-more-thumbs">
              {% for artwork in cat.artworks | limit(2) %}
                <img src="/images/artwork/thumbnails/{{ artwork.data.image }}" alt="">
              {% endfor %}
            </div>
            <span class="atelier-more-label">{{ cat.name }} <em>({{ cat.artworks | length }})</em></span>
          </a>
        {% endif %}
      {% endfor %}
    </div>
  </div>

</section>
```

This is the stashed WIP design (recovered from `git stash show a90e7ffa03471756f8ea509188087a7192de2d12`) with its "Recent" block removed and its permalink changed from `atelier/` to `atelier/browse/`.

- [ ] **Step 2: Verify manually**

```bash
npx @11ty/eleventy
ls dist/atelier/browse/index.html
grep -c 'atelier-cat-block' dist/atelier/browse/index.html
```
Expected: the file exists; the count is at least 2 (one per featured category present in your content, plus the "More" block). Load it in a browser and confirm the featured category blocks and "More" grid render with real thumbnails, and that clicking through to a category link (e.g. `/categories/karat/`) works. Confirm `/atelier/` (Task 2) links to it and that it doesn't appear in `src/_includes/navigation.njk` or `src/_includes/sidebar.njk` (grep both — it shouldn't be there, since this plan never touches either file).

```bash
grep -rn "atelier/browse" src/_includes/navigation.njk src/_includes/sidebar.njk
```
Expected: no output.

Clean up `dist/` afterward.

- [ ] **Step 3: Commit**

```bash
git add src/pages/atelier-browse.njk
git commit -m "feat: add atelier browse page for category-based archive"
```
