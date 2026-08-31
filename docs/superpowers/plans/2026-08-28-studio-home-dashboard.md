# Studio Home Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Home" tab to Studio that shows content backlog, repo health, Skylanders archive stats, and journey/pets counts at a glance.

**Architecture:** One new `GET /api/dashboard` endpoint in `studio/server.js` aggregates four independent, individually-fault-tolerant data reads (draft post counts via existing `scanPosts()`, `git status`/`git log` via `exec`, `skylanders-archive/manifest.json`, `src/_data/journey.json` + `pet_list.json`) into one JSON response. The frontend adds a `home` entry to Studio's existing tab-switching system (`studio/public/index.html` + `app.js`), rendering four cards into a new `#home-view` using Studio's existing `.post-card` visual language — no new colors, fonts, or layout system.

**Tech Stack:** Plain Node.js `http` server (no framework), vanilla JS frontend, no build step for Studio itself, no test runner in this repo (verification is manual, matching existing project convention).

**Spec:** `docs/superpowers/specs/2026-08-28-studio-home-dashboard-design.md`

## Global Constraints

- Private/local only — nothing here touches the public Eleventy build or `dist/`.
- No new npm dependencies, no new server, no persistent/cached state — every dashboard number is computed fresh from disk/git on each request, exactly like the rest of Studio.
- No new CSS colors or fonts — reuse existing tokens (`--surface`, `--border`, `--muted`, `--text`, `--accent`, `--font`) and existing classes (`.post-card`, `.section-label`, `.badge-draft`) wherever they fit.
- Each of the four dashboard data sections must degrade independently on failure (`available: false`) rather than breaking the other three or throwing a 500.

---

## Task 1: Dashboard API endpoint

**Files:**
- Modify: `studio/server.js:151` (insert four helper functions after `scanPosts()`, before the `─── API handlers ───` comment)
- Modify: `studio/server.js:397` (insert new route in `handleAPI`, right after the `/api/atelier/quick` handler and before the final `send(res, 404, ...)`)

**Interfaces:**
- Consumes: existing `scanPosts(type)` (returns `[{ file, slug, series, title, date, draft, image, excerpt, data, body }]`), existing `POST_ROOTS` (`{ writing, games, artwork, pets }`), existing `ROOT`, `fs`, `path`, `exec` (already imported at top of `server.js`), existing `send(res, status, data)`.
- Produces: `GET /api/dashboard` → `200` JSON:
  ```json
  {
    "backlog":     { "available": true, "counts": { "writing": 0 }, "recent": [{ "title": "", "type": "artwork", "file": "src/posts/artwork/...", "date": "2026-08-01" }] },
    "repoHealth":  { "available": true, "total": 279, "buckets": { "images": 160 }, "lastCommit": { "date": "2026-08-23", "message": "..." } },
    "skylanders":  { "available": true, "posts": 1301, "images": 13280, "featured": 0, "nonFeatured": 0, "fetchedAt": "2026-06-06T08:49:35.303Z" },
    "journeyPets": { "available": true, "journeyCount": 0, "grades": { "A": 0, "B": 0, "C": 0, "D": 0 }, "petCount": 0 }
  }
  ```
  These exact field names (`available`, `counts`, `recent`, `total`, `buckets`, `lastCommit`, `posts`, `images`, `featured`, `nonFeatured`, `fetchedAt`, `journeyCount`, `grades`, `petCount`) are what Task 2's frontend renders — Task 2 relies on this shape exactly.

- [ ] **Step 1: Add the four dashboard helper functions**

Insert after line 151 (end of `scanPosts()`), before the `// ─── API handlers ───` comment on line 153:

```js
// ─── Dashboard helpers ─────────────────────────────────────────────────────────

function getBacklog() {
  try {
    const counts = {};
    const drafts = [];
    for (const type of Object.keys(POST_ROOTS)) {
      const posts = scanPosts(type);
      counts[type] = posts.filter(p => p.draft).length;
      for (const p of posts) {
        if (p.draft) drafts.push({ title: p.title, type, file: p.file, date: p.date });
      }
    }
    drafts.sort((a, b) => {
      if (!a.date && !b.date) return 0;
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date) - new Date(a.date);
    });
    return { available: true, counts, recent: drafts.slice(0, 5) };
  } catch {
    return { available: false, counts: {}, recent: [] };
  }
}

function getRepoHealth() {
  return new Promise(resolve => {
    exec('git status --porcelain', { cwd: ROOT }, (err, stdout) => {
      if (err) return resolve({ available: false, total: 0, buckets: {}, lastCommit: null });
      const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
      const buckets = {};
      for (const line of lines) {
        const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
        const parts = filePath.split('/');
        const bucket = parts[0] === 'src' ? (parts[1] || 'src') : parts[0];
        buckets[bucket] = (buckets[bucket] || 0) + 1;
      }
      exec('git log -1 --format=%cd|%s --date=short', { cwd: ROOT }, (err2, stdout2) => {
        let lastCommit = null;
        if (!err2 && stdout2.trim()) {
          const [date, ...rest] = stdout2.trim().split('|');
          lastCommit = { date, message: rest.join('|') };
        }
        resolve({ available: true, total: lines.length, buckets, lastCommit });
      });
    });
  });
}

function getSkylandersStats() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'skylanders-archive/manifest.json'), 'utf-8'));
    const posts = manifest.posts || [];
    let images = 0, featured = 0;
    for (const p of posts) {
      for (const img of (p.images || [])) {
        images++;
        if (img.featured) featured++;
      }
    }
    return {
      available:   true,
      posts:       posts.length,
      images,
      featured,
      nonFeatured: images - featured,
      fetchedAt:   manifest.fetched_at || null,
    };
  } catch {
    return { available: false, posts: 0, images: 0, featured: 0, nonFeatured: 0, fetchedAt: null };
  }
}

function getJourneyPetsStats() {
  const result = { available: true, journeyCount: 0, grades: { A: 0, B: 0, C: 0, D: 0 }, petCount: 0 };
  try {
    const journey = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/_data/journey.json'), 'utf-8'));
    result.journeyCount = journey.length;
    for (const entry of journey) {
      if (entry.grade && result.grades[entry.grade] !== undefined) result.grades[entry.grade]++;
    }
  } catch { result.available = false; }
  try {
    const pets = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/_data/pet_list.json'), 'utf-8'));
    result.petCount = pets.length;
  } catch { result.available = false; }
  return result;
}
```

- [ ] **Step 2: Add the `GET /api/dashboard` route**

Insert right after the `/api/atelier/quick` handler ends (after line 397) and before the final `send(res, 404, { error: 'No such route' });` (line 399):

```js
  // GET /api/dashboard
  if (method === 'GET' && pathname === '/api/dashboard') {
    const repoHealth = await getRepoHealth();
    return send(res, 200, {
      backlog:     getBacklog(),
      repoHealth,
      skylanders:  getSkylandersStats(),
      journeyPets: getJourneyPetsStats(),
    });
  }
```

- [ ] **Step 3: Verify manually against the running server**

Run:
```bash
node studio/server.js &
sleep 1
curl -s http://localhost:3001/api/dashboard | python3 -m json.tool
kill %1
```
Expected: valid JSON with all four top-level keys (`backlog`, `repoHealth`, `skylanders`, `journeyPets`), each with `available: true` (in this repo checkout, all four data sources exist), `repoHealth.total` roughly matching `git status --porcelain | wc -l`, and `skylanders.posts` equal to `1301`.

Then confirm graceful degradation: temporarily rename the manifest, re-curl, confirm `skylanders.available` is `false` and the other three sections are still populated, then rename it back.
```bash
mv skylanders-archive/manifest.json skylanders-archive/manifest.json.bak
node studio/server.js &
sleep 1
curl -s http://localhost:3001/api/dashboard | python3 -m json.tool
kill %1
mv skylanders-archive/manifest.json.bak skylanders-archive/manifest.json
```

- [ ] **Step 4: Commit**

```bash
git add studio/server.js
git commit -m "feat: add /api/dashboard endpoint to Studio"
```

---

## Task 2: Home tab UI

**Files:**
- Modify: `studio/public/index.html:18-23` (tab nav), `studio/public/index.html:25-28` (insert `#home-view`, hide `#list-view` by default)
- Modify: `studio/public/app.js:68` (`state.type` default), `studio/public/app.js:85` (DOM refs), `studio/public/app.js:79` (new module state), `studio/public/app.js:168` (insert dashboard functions after `renderPostList`), `studio/public/app.js:216-227` (`backToList()`), `studio/public/app.js:639-658` (tab click handler), `studio/public/app.js:1050` (boot call)
- Modify: `studio/public/style.css:167` (insert dashboard styles after `.post-card-excerpt`, before the `/* ─── Edit view ─── */` comment)

**Interfaces:**
- Consumes: Task 1's `GET /api/dashboard` response shape exactly as documented above; existing `api(method, url, body)`, `esc(s)`, `openEdit(file)`, `state`, `atelierState`, `listView`, `atelierView`, `editView`, `loadPosts()`, `loadAtelier()`.
- Produces: `homeView` / `dashboardGrid` DOM refs, `loadDashboard()`, `renderDashboard(data)`, `openDraftFromHome(draft)`, module-level `cameFromHome` flag — none of these are consumed elsewhere in this plan, but they're the names to use if extending the dashboard later.

- [ ] **Step 1: Add the Home tab and view container to `index.html`**

Replace the tab nav (lines 18-23):

```html
  <nav class="type-tabs">
    <button class="tab active" data-type="home">Home</button>
    <button class="tab" data-type="writing">Writing</button>
    <button class="tab" data-type="games">Games</button>
    <button class="tab" data-type="artwork">Artwork</button>
    <button class="tab" data-type="pets">Pets</button>
  </nav>
```

Then insert `#home-view` right after `<main id="main-view">` (before the `<!-- List view -->` comment) and add `class="hidden"` to `#list-view`:

```html
  <main id="main-view">

    <!-- Home view: dashboard -->
    <div id="home-view">
      <div class="list-header">
        <h2>Home</h2>
      </div>
      <div id="dashboard-grid" class="posts-grid"></div>
    </div>

    <!-- List view -->
    <div id="list-view" class="hidden">
```

(Everything from the existing `<div class="list-header">` inside List view onward is unchanged.)

- [ ] **Step 2: Add DOM refs and module state in `app.js`**

In the `state` object (line 68), change the default type:

```js
const state = {
  type:          'home',
  posts:         [],
  editing:       null,
  artworkSeries: [],
};
```

Add a module-level flag right after the `atelierState` block (after line 79):

```js
let cameFromHome = false;
```

Add DOM refs right after `const editView = $('edit-view');` (line 85):

```js
const homeView      = $('home-view');
const dashboardGrid = $('dashboard-grid');
```

- [ ] **Step 3: Add `loadDashboard`, `renderDashboard`, and `openDraftFromHome`**

Insert after `renderPostList()` ends (after line 168), before the `// ─── Edit view ───` comment:

```js
// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  dashboardGrid.innerHTML = '<p style="color:#555;font-size:.75rem">Loading…</p>';
  const data = await api('GET', '/api/dashboard');
  renderDashboard(data || {});
}

function openDraftFromHome(draft) {
  state.type   = draft.type;
  cameFromHome = true;
  homeView.classList.add('hidden');
  openEdit(draft.file);
}

function renderDashboard(data) {
  const backlog     = data.backlog     || { available: false, counts: {}, recent: [] };
  const repoHealth  = data.repoHealth  || { available: false, total: 0, buckets: {}, lastCommit: null };
  const skylanders  = data.skylanders  || { available: false };
  const journeyPets = data.journeyPets || { available: false, journeyCount: 0, grades: {}, petCount: 0 };

  const backlogStats = Object.entries(backlog.counts)
    .map(([type, n]) => `<span>${esc(type)} <b>${n}</b></span>`).join('');
  const backlogList = backlog.recent.length
    ? `<ul class="dashboard-list">${backlog.recent.map(d =>
        `<li data-file="${esc(d.file)}" data-type="${esc(d.type)}">${esc(d.title)} <span class="badge-draft">${esc(d.type)}</span></li>`
      ).join('')}</ul>`
    : '<p class="dashboard-unavailable">No drafts — everything is published.</p>';

  const bucketList = Object.entries(repoHealth.buckets)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `<li>${esc(name)} <b>${n}</b></li>`).join('');
  const lastCommitLine = repoHealth.lastCommit
    ? `Last commit: ${repoHealth.lastCommit.date} — ${repoHealth.lastCommit.message}`
    : 'No commits found';

  const skyBlock = skylanders.available
    ? `<div class="dashboard-stats">
         <span>Posts <b>${skylanders.posts}</b></span>
         <span>Images <b>${skylanders.images}</b></span>
         <span>Featured <b>${skylanders.featured}</b></span>
       </div>
       <div class="dashboard-footnote">Synced ${esc(skylanders.fetchedAt ? skylanders.fetchedAt.split('T')[0] : '—')}</div>`
    : '<p class="dashboard-unavailable">Archive manifest not found on this checkout.</p>';

  const grades = journeyPets.grades || {};
  const journeyBlock = journeyPets.available
    ? `<div class="dashboard-stats">
         <span>Journey entries <b>${journeyPets.journeyCount}</b></span>
         <span>Pets <b>${journeyPets.petCount}</b></span>
       </div>
       <div class="dashboard-footnote">Grades — A ${grades.A||0} · B ${grades.B||0} · C ${grades.C||0} · D ${grades.D||0}</div>`
    : '<p class="dashboard-unavailable">Journey/pet data not found.</p>';

  dashboardGrid.innerHTML = `
    <div class="post-card dashboard-card">
      <div class="section-label">Content Backlog</div>
      <div class="dashboard-stats">${backlogStats}</div>
      ${backlogList}
    </div>
    <div class="post-card dashboard-card">
      <div class="section-label">Repo Health</div>
      <div class="dashboard-stats"><span>Uncommitted <b>${repoHealth.total}</b></span></div>
      <ul class="dashboard-list">${bucketList}</ul>
      <div class="dashboard-footnote">${esc(lastCommitLine)}</div>
    </div>
    <div class="post-card dashboard-card">
      <div class="section-label">Skylanders Archive</div>
      ${skyBlock}
    </div>
    <div class="post-card dashboard-card">
      <div class="section-label">Journey / Pets</div>
      ${journeyBlock}
    </div>
  `;

  dashboardGrid.querySelectorAll('.dashboard-list li[data-file]').forEach(li => {
    li.addEventListener('click', () => openDraftFromHome({ file: li.dataset.file, type: li.dataset.type }));
  });
}
```

- [ ] **Step 4: Wire Home into the tab click handler**

Replace the tab click handler (lines 639-658):

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

    if (state.type === 'home') {
      listView.classList.add('hidden');
      atelierView.classList.add('hidden');
      homeView.classList.remove('hidden');
      loadDashboard();
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

- [ ] **Step 5: Make "Back" from an edit opened via Home return to Home**

Replace `backToList()` (lines 216-227):

```js
function backToList() {
  editView.classList.add('hidden');
  state.editing = null;
  if (atelierState.fromAtelier) {
    atelierState.fromAtelier = false;
    atelierView.classList.remove('hidden');
    if (atelierState.activeFolder) selectAtelierFolder(atelierState.activeFolder);
  } else if (cameFromHome) {
    cameFromHome = false;
    state.type = 'home';
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.type === 'home'));
    homeView.classList.remove('hidden');
    loadDashboard();
  } else {
    listView.classList.remove('hidden');
    loadPosts();
  }
}
```

- [ ] **Step 6: Boot into Home instead of Writing**

Replace the boot line (line 1050):

```js
loadDashboard();
```

- [ ] **Step 7: Add dashboard CSS**

Insert after `.post-card-excerpt` (after line 167), before `/* ─── Edit view ─── */`:

```css
/* ─── Home / dashboard ──────────────────────────────────────────────────── */
.dashboard-card { cursor: default; }
.dashboard-card:hover { border-color: var(--border); background: var(--surface); }

.dashboard-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin: 0.5rem 0;
  font-size: 0.75rem;
  color: var(--muted);
}
.dashboard-stats b { color: var(--text); font-weight: normal; }

.dashboard-list {
  list-style: none;
  font-size: 0.72rem;
  color: var(--text);
}
.dashboard-list li {
  padding: 0.3rem 0;
  border-top: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.dashboard-list li[data-file] { cursor: pointer; }
.dashboard-list li[data-file]:hover { color: var(--accent); }

.dashboard-footnote {
  margin-top: 0.5rem;
  font-size: 0.65rem;
  color: var(--muted);
}

.dashboard-unavailable {
  font-size: 0.72rem;
  color: var(--muted);
  font-style: italic;
}
```

- [ ] **Step 8: Verify manually in the browser**

Run:
```bash
npm run studio
```
Open `http://localhost:3001`. Confirm:
1. Home is the active tab and loads on first page load, showing four cards: Content Backlog, Repo Health, Skylanders Archive, Journey / Pets.
2. Numbers match Task 1's curl output (Skylanders: 1301 posts; Repo Health total roughly matches `git status --porcelain | wc -l`).
3. Click a recent draft in the Content Backlog card — it opens in the edit view with the right form fields for its type (e.g. an artwork draft shows the Artwork schema).
4. Click "← Back" from that edit — it returns to the Home tab (not the Writing list), and Home reloads.
5. Click through Writing / Games / Artwork / Pets tabs and back to Home — all still work as before (no regression to existing tab behavior).
6. Cards visually match the existing post-card look (dark surface, border, muted labels) — no new colors or fonts introduced.

- [ ] **Step 9: Commit**

```bash
git add studio/public/index.html studio/public/app.js studio/public/style.css
git commit -m "feat: add Home dashboard tab to Studio"
```
