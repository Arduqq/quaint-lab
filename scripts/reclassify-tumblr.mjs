#!/usr/bin/env node
/**
 * reclassify-tumblr.mjs
 * ─────────────────────
 * Re-sort an existing archive without re-downloading anything.
 *
 * Reads manifest.json, re-runs the current game + category detection
 * on every post, wipes old <game>/<category>/ directories, and
 * rebuilds them as hard links into the existing _images/ flat store.
 * Also rewrites manifest.json with updated classifications and rebuilds index.html.
 *
 * Usage:
 *   node scripts/reclassify-tumblr.mjs ~/Desktop/skylanders-archive
 */

import { readFileSync, writeFileSync, existsSync, readdirSync,
         rmSync, mkdirSync, linkSync, copyFileSync } from 'fs';
import { join, dirname, basename, relative } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const OUT       = process.argv[2] ?? './skylanders-archive';
// --publish: emit a stripped-down, edit-free build of the archive page and
// sync its images into the website so it can be browsed (sorted/filtered,
// never edited) on the live site, where no curation server is running.
const isPublish = process.argv.includes('--publish');
const __dir = dirname(fileURLToPath(import.meta.url));

// Character list for tag mode — loaded from the quaint-lab data file at build time
const _skyJsonPath = join(__dir, '../src/_data/skylanders.json');
const SKYLANDERS_LIST = existsSync(_skyJsonPath)
  ? JSON.parse(readFileSync(_skyJsonPath, 'utf8'))
      .flatMap(g => g.characters.map(c => ({ name: c.name, element: c.element || '' })))
  : [];

if (!existsSync(OUT)) {
  console.error(`Archive not found: ${OUT}`); process.exit(1);
}
const manifestPath = join(OUT, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest.json in ${OUT}`); process.exit(1);
}

// ── Games ──────────────────────────────────────────────────────────────────
const GAMES = [
  { id: 'spyros-adventure', label: "Spyro's Adventure",
    rx: [/spyro.?s adventure/i, /\bssa\b/i, /skylanders 1\b/i] },
  { id: 'giants',           label: 'Giants',
    rx: [/\bgiants\b/i, /\bssg\b/i] },
  { id: 'swap-force',       label: 'Swap Force',
    rx: [/swap.?force/i, /\bssf\b/i] },
  { id: 'trap-team',        label: 'Trap Team',
    rx: [/trap.?team/i, /\bsstt\b/i] },
  { id: 'superchargers',    label: 'SuperChargers',
    rx: [/supercharger/i, /\bssc\b/i] },
  { id: 'imaginators',      label: 'Imaginators',
    rx: [/imaginator/i, /\bssi\b/i, /sensei/i, /creation crystal/i] },
  { id: 'academy',          label: 'Academy (show)',
    rx: [/\bacademy\b/i, /skylanders.*series/i] },
  { id: 'ring-of-heroes',   label: 'Ring of Heroes',
    rx: [/ring.?of.?heroes/i, /\broh\b/i] },
  { id: 'battlecast',       label: 'Battlecast',
    rx: [/battlecast/i] },
];

// ── Category derivation ────────────────────────────────────────────────────
// No predefined list — the category IS the parsed content description, slugified.

// ── Parsing helpers (keep in sync with archive-tumblr.mjs) ────────────────
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48);

function parseSubject(text) {
  const t = text.replace(/&rsquo;/gi,"'").replace(/&lsquo;/gi,"'").replace(/&#8217;/g,"'").replace(/&#39;/g,"'").replace(/&[a-z#][a-z0-9]*;/gi,' ');
  const fromRx = /^(.+?)\s+from\s+(?:skylanders[:\s]+)?([^(]+?)(?:\s*\(|$)/i;
  const m = fromRx.exec(t.trim());
  const subject   = m ? m[1].trim() : t.trim();
  const gameHint  = m ? m[2].trim() : null;
  // Possessive anywhere in subject: "Assets used for Gear Shift's Character page"
  const possRx = /\b((?:dr\.?\s+)?[A-Z][A-Za-z''\-\.]+(?:\s+[A-Z][A-Za-z\-]+)?)'s?\s+(.+)/;
  const pm = possRx.exec(subject);
  const contentDesc = pm ? pm[2].trim() : subject;
  return { subject, gameHint, contentDesc };
}

function detectGame(gameHint, text, tags) {
  for (const src of [gameHint, tags.join(' '), text].filter(Boolean)) {
    for (const g of GAMES) { if (g.rx.some(r => r.test(src))) return g.id; }
  }
  return 'misc';
}

function toCategory(desc) {
  if (!desc) return 'misc';
  const d = desc.replace(/&[a-z#][a-z0-9]*;/gi, ' ').replace(/\s+/g, ' ').trim();

  if (/\babilities\b/i.test(d))            return 'abilities';
  if (/\bequipment\b/i.test(d))            return 'equipment';
  if (/soul.?stone/i.test(d))              return 'soul-stone-icons';
  if (/collection.?render/i.test(d))       return 'collection-renders';
  if (/imaginator.?parts?\b/i.test(d))     return 'imaginator-parts';
  if (/\b(knight|smasher|sorcerer|sentinel|quickshot|ninja|brawler|bowslinger|bazooker|swashbuckler)\s+weapons?\b/i.test(d))
    return 'creation-weapons';

  if (/villain\s+polaroid/i.test(d))       return 'villain-polaroids';
  if (/villain\s+page/i.test(d))           return 'villain-pages';
  if (/character\s+page/i.test(d))         return 'character-pages';
  if (/game\s+page/i.test(d))              return 'game-pages';
  if (/\bblueprints?\b/i.test(d))          return 'blueprints';
  if (/\bpolaroids?\b/i.test(d))           return 'polaroids';
  if (/\btraps?\b.*skylanders/i.test(d))   return 'traps';
  if (/home\s+page\s+assets?/i.test(d))    return 'website-assets';

  if (/banner\s+assets?|event\s+banner/i.test(d))   return 'banners';
  if (/shop\s+icons?\b/i.test(d))          return 'shop-icons';
  if (/\btown\s+assets?\b/i.test(d))       return 'town-assets';
  if (/\bmap\s+assets?\b/i.test(d))        return 'map-assets';
  if (/element(?:al)?\s+assets?\b/i.test(d)) return 'element-assets';

  if (/\bmusic.+icons?\b/i.test(d))        return 'music-icons';
  if (/\bvoice.+icons?\b/i.test(d))        return 'voice-icons';
  if (/transp(?:a|e)rent\s+renders?\b/i.test(d)) return 'transparent-renders';

  if (/\b(doodle|drawing|sketch|fanart|fan.art|art.dump|scribble|commission)\b/i.test(d))
    return 'fan-art';
  if (/\bday[-\s]?\d+\b/i.test(d))         return 'fan-art';
  if (/skydonalds/i.test(d))               return 'fan-art';
  if (/^(?:hungry.?skeleton|junkyardisles|skyblue.?blazes|mightyart|blu3b1rd)\b/i.test(d))
    return 'fan-art';

  const clean = d
    .replace(/\s+(?:for|of|by|featuring)\s+[A-Z].+$/i, '')
    .replace(/\s+(?:from|in)\s+[A-Z][A-Za-z ]+$/i, '')
    .trim();
  const result = slugify(clean) || slugify(d) || 'misc';
  return result.length >= 20 ? 'fan-art' : result;
}

function extractExtraTags(subject, contentDesc) {
  const extra = [];
  const d = (contentDesc || '').replace(/&[a-z#][a-z0-9]*;/gi, "'").trim();
  const s = (subject     || '').replace(/&[a-z#][a-z0-9]*;/gi, "'").trim();
  const pm = /\b((?:dr\.?\s+)?[A-Z][A-Za-z''\-\.]+(?:\s+[A-Z][A-Za-z\-]+)?)'s?\b/.exec(s);
  if (pm) extra.push(pm[1].toLowerCase());
  const partM = /^(.+?)\s+imaginator\s+parts?\b/i.exec(d);
  if (partM) extra.push(partM[1].toLowerCase().trim());
  const classM = /^(knight|smasher|sorcerer|sentinel|quickshot|ninja|brawler|bowslinger|bazooker|swashbuckler)\s+weapons?\b/i.exec(d);
  if (classM) extra.push(classM[1].toLowerCase());
  return extra;
}

function hardLink(src, dest) {
  if (existsSync(dest)) return;
  mkdirSync(dest.replace(/\/[^/]+$/, ''), { recursive: true });
  try   { linkSync(src, dest); }
  catch { copyFileSync(src, dest); }
}

// ── Load manifest ──────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
console.log(`Loaded ${manifest.posts.length} posts from manifest.\n`);

// ── Build a ground-truth index of where each image currently lives ────────
// We can't trust post.game/post.category/img.path to tell us the *previous*
// classification: archive-server.mjs writes the new values straight into the
// manifest the instant you save (so the lightbox can repoint immediately),
// which means by the time this rebuild runs, the "old" values are already
// gone from the manifest. The filesystem is the only remaining record of
// where a file's link actually sits, so scan it once up front and treat that
// as ground truth for detecting and cleaning up stale links.
function walkFiles(dir, skipNames) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipNames.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, skipNames));
    else out.push(full);
  }
  return out;
}
const fileLocations = new Map(); // filename -> Set of all its current absolute link paths (outside _images)
for (const full of walkFiles(OUT, new Set(['_images']))) {
  const name = basename(full);
  if (!fileLocations.has(name)) fileLocations.set(name, new Set());
  fileLocations.get(name).add(full);
}

// ── Reclassify and relink only what changed ───────────────────────────────
// No global wipe: a full wipe-and-relink ran on *every* save (even tag/annotation
// edits that never touch game/category), leaving a window where every image on
// the page 404s while the archive is mid-rebuild. Instead, only the images whose
// physical location actually differs from where it should be get unlinked from
// their old spot and relinked into the new one — everything else stays untouched
// and always loadable.
const imgStore   = join(OUT, '_images');
let moved = 0, unchanged = 0, missing = 0, cleaned = 0;
const changes = [];
const touchedDirs = new Set();

for (const post of manifest.posts) {
  const { subject, gameHint, contentDesc } = parseSubject(post.text ?? '');
  const tags = (post.tags ?? []).map(t => t.toLowerCase());
  const newGame     = post._manual ? (post.game ?? 'misc') : detectGame(gameHint, post.text ?? '', post.tags ?? []);
  const newCategory = post._manual ? (post.category ?? 'misc') : (tags.includes('my art') ? 'fan-art' : toCategory(contentDesc));
  const extraTags   = extractExtraTags(subject, contentDesc);
  for (const t of extraTags) {
    if (!(post.tags ?? []).includes(t)) post.tags = [...(post.tags ?? []), t];
  }

  post.game     = newGame;
  post.category = newCategory;
  post.subject  = subject;

  for (const img of post.images ?? []) {
    if (img.error || !img.file) continue;
    const storeSrc = join(imgStore, img.file);
    if (!existsSync(storeSrc)) { missing++; continue; }

    img.game     = newGame;
    img.category = newCategory;
    img.path     = join(newGame, newCategory, img.file);

    const dest      = join(OUT, newGame, newCategory, img.file);
    const locations = fileLocations.get(img.file) ?? new Set();
    const stales    = [...locations].filter(loc => loc !== dest);
    hardLink(storeSrc, dest);

    if (stales.length) {
      moved++;
      changes.push({ id: post.id, subject: post.subject ?? subject,
        from: relative(OUT, dirname(stales[0])), to: `${newGame}/${newCategory}` });
      // Drop every stale link at old/duplicate locations instead of wiping everything.
      for (const stale of stales) {
        try { rmSync(stale, { force: true }); cleaned++; touchedDirs.add(dirname(stale)); } catch { /* skip */ }
      }
    } else {
      unchanged++;
    }
  }
}

// Remove directories left empty by the moves above (walking up toward OUT)
for (const dir of touchedDirs) {
  try {
    let d = dir;
    while (d !== OUT && d.startsWith(OUT + '/')) {
      if (readdirSync(d).length) break;
      rmSync(d, { recursive: true, force: true });
      d = dirname(d);
    }
  } catch { /* skip */ }
}
if (cleaned) console.log(`Cleaned up ${cleaned} stale link(s) from old locations.\n`);

// ── Save updated manifest ─────────────────────────────────────────────────
manifest.reclassified_at = new Date().toISOString();
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

// ── Print change report ───────────────────────────────────────────────────
console.log(`Images re-sorted:  ${moved} moved,  ${unchanged} unchanged,  ${missing} missing from _images\n`);

if (changes.length) {
  const shown = changes.slice(0, 40);
  console.log(`Classification changes (${changes.length} posts):`);
  for (const c of shown) {
    const subj = (c.subject || String(c.id)).slice(0, 50).padEnd(52);
    console.log(`  ${subj}  ${c.from.padEnd(36)} → ${c.to}`);
  }
  if (changes.length > 40) console.log(`  … and ${changes.length - 40} more\n`);
} else {
  console.log('No classification changes — everything was already correct.\n');
}

// ── Rebuild index.html ────────────────────────────────────────────────────
const gameMap = { misc: 'Misc', ...Object.fromEntries(GAMES.map(g => [g.id, g.label])) };

const tree = {};
for (const post of manifest.posts) {
  for (const img of post.images ?? []) {
    if (img.error || !img.path) continue;
    const g = img.game ?? post.game;
    const c = img.category ?? post.category;
    ((tree[g] ??= {})[c] ??= []).push({
      postId: post.id,
      imageFile: img.file,
      path: img.path, url: img.url,
      date: post.date, tags: post.tags, postUrl: post.url,
      subject: post.subject, text: post.text,
      game: g, category: c,
      skylanders: Array.isArray(img.skylanders) ? img.skylanders : (post.skylanders || []),
      annotations: post.annotations || [],
    });
  }
}

const gameOrder = [...GAMES.map(g => g.id), 'misc'].filter(id => tree[id]);
const catCounts = {};
gameOrder.forEach(g => Object.entries(tree[g] ?? {}).forEach(([c, imgs]) => {
  catCounts[c] = (catCounts[c] ?? 0) + imgs.length;
}));
const catOrder = Object.keys(catCounts).sort((a, b) => catCounts[b] - catCounts[a]);
const total = gameOrder.reduce((n, g) =>
  n + catOrder.reduce((m, c) => m + (tree[g]?.[c]?.length ?? 0), 0), 0);

// Summary table
const catLabel = c => c.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
const PAD = 24, W = 8;
const gameLabels = gameOrder.map(g => (gameMap[g] ?? g).slice(0, W-1).padStart(W));
console.log('  ' + ''.padEnd(PAD) + gameLabels.join(''));
console.log('  ' + '─'.repeat(PAD + W * gameOrder.length));
for (const cat of catOrder) {
  const lbl  = catLabel(cat).padEnd(PAD);
  const cols = gameOrder.map(g => ((tree[g]?.[cat]?.length ?? '') || '·').toString().padStart(W));
  console.log('  ' + lbl + cols.join(''));
}
console.log('  ' + '─'.repeat(PAD + W * gameOrder.length));
console.log('  ' + 'TOTAL'.padEnd(PAD) + gameOrder.map(g =>
  (catOrder.reduce((s, c) => s + (tree[g]?.[c]?.length ?? 0), 0) || '·').toString().padStart(W)
).join('') + '\n');

// ── Editing-only UI ────────────────────────────────────────────────────────
// Omitted entirely from --publish builds: the live site has no curation
// server to talk to, so none of this can function there — sorting/filtering/
// viewing stays, everything that calls EDIT_API or mutates the archive goes.
const tagModeBtnHTML = isPublish ? '' : `
  <button id="tag-mode-btn" onclick="toggleTagMode()" title="Enter tag mode to mass-assign Skylander characters">⊕ Tag</button>`;

const tagBarHTML = isPublish ? '' : `
<div id="tag-bar">
  <button class="tb-exit" onclick="exitTagMode()" title="Exit tag mode">✕</button>
  <div id="tag-current" title="No character selected — pick one from the list">
    <span id="tag-dot" class="tag-dot"></span>
    <span id="tag-current-name">Pick a character →</span>
  </div>
  <div class="tb-sep"></div>
  <input id="tag-search" type="search" placeholder="Filter…" autocomplete="off">
  <div id="tag-list"></div>
  <div class="tb-sep"></div>
  <button id="tag-save" onclick="batchSave()">Save&nbsp;<span id="tag-save-cnt">0</span></button>
</div>`;

const editBtnHTML = isPublish ? '' : `
    <button class="lb-btn" id="lb-edit-btn" onclick="toggleEdit()">&#9998; Edit</button>`;

const editPanelHTML = isPublish ? '' : `
  <div id="lb-edit">
    <div class="edit-group">
      <label>Game</label>
      <select id="edit-game" onchange="editUpdateCats()"></select>
    </div>
    <div class="edit-group">
      <label>Category</label>
      <select id="edit-cat"></select>
      <input type="text" id="edit-cat-new" placeholder="or new…" style="max-width:130px">
    </div>
    <div class="edit-group">
      <label>Skylander</label>
      <input type="text" id="edit-sky" list="edit-sky-list" placeholder="Character name…">
      <datalist id="edit-sky-list"></datalist>
    </div>
    <div class="edit-group" id="edit-sky-tags-row">
      <label>Tagged</label>
      <div id="edit-sky-tags"></div>
    </div>
    <div class="edit-group">
      <label>Annotate</label>
      <div class="edit-checks">
        <label class="edit-check"><input type="checkbox" id="edit-ann-bg"> Background</label>
        <label class="edit-check"><input type="checkbox" id="edit-ann-detail"> Detail</label>
      </div>
    </div>
    <div class="edit-actions">
      <button class="lb-btn" id="edit-apply-btn" onclick="applyEdit()">Apply</button>
      <button class="lb-btn" onclick="toggleEdit()" style="opacity:.55">Cancel</button>
      <span id="edit-status"></span>
    </div>
  </div>`;

const tagModeJS = isPublish ? '' : `
let tagModeOn   = false;
let tagSelected = null; // { name, element }
const tagPending = new Map(); // imageFile → { skylanders: Set, lbIdx }

function toggleTagMode() {
  if (tagModeOn) { exitTagMode(); return; }
  tagModeOn = true;
  document.getElementById('tag-bar').classList.add('open');
  document.getElementById('tag-mode-btn').classList.add('on');
  document.body.classList.add('tag-mode');
  buildTagList('');
}

function exitTagMode() {
  tagModeOn = false;
  document.getElementById('tag-bar').classList.remove('open');
  document.getElementById('tag-mode-btn').classList.remove('on');
  document.body.classList.remove('tag-mode');
}

function buildTagList(q) {
  const list = document.getElementById('tag-list');
  const lq   = q.toLowerCase();
  const matches = SKYLANDERS.filter(s => !lq || s.name.toLowerCase().includes(lq));
  list.innerHTML = '';
  matches.forEach(s => {
    const col  = EL_COL[s.element] || '#444';
    const chip = document.createElement('button');
    chip.className = 'tag-chip' + (tagSelected?.name === s.name ? ' active' : '');
    chip.textContent = s.name;
    chip.style.cssText = 'background:' + col + '22;border-color:' + col + '55;color:#eee';
    chip.addEventListener('click', () => selectChar(s));
    list.appendChild(chip);
  });
}

function selectChar(s) {
  tagSelected = s;
  const col = EL_COL[s.element] || '#888';
  document.getElementById('tag-dot').style.cssText = 'background:' + col + ';box-shadow:0 0 6px ' + col;
  document.getElementById('tag-current-name').textContent = s.name;
  buildTagList(document.getElementById('tag-search').value.toLowerCase().trim());
  refreshTagOverlays();
}

function refreshTagOverlays() {
  const selName = tagSelected?.name?.toLowerCase();
  document.querySelectorAll('.card[data-lb-idx]').forEach(card => {
    const idx = parseInt(card.dataset.lbIdx);
    if (isNaN(idx)) return;
    const img = lbImgs[idx];
    if (!img) return;
    // Get effective skylanders (pending overrides img)
    const pending = img.imageFile ? tagPending.get(img.imageFile) : null;
    const skyArr  = pending ? [...pending.skylanders] : (img.skylanders || []);
    card.classList.toggle('tagged-sel', !!(selName && skyArr.map(n=>n.toLowerCase()).includes(selName)));
  });
}

function updateCardStrip(card, skyArr) {
  let strip = card.querySelector('.card-sky-strip');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'card-sky-strip';
    card.insertBefore(strip, card.querySelector('.foot') || null);
  }
  strip.innerHTML = skyArr.map(n => {
    const sky = SKYLANDERS.find(s => s.name.toLowerCase() === n.toLowerCase());
    const col = (sky && EL_COL[sky.element]) || '#444';
    return '<span class="cst" style="background:' + col + '28;border:1px solid ' + col + '66;color:#ddd">' + n + '</span>';
  }).join('');
}

function handleTagClick(e, card, idx) {
  if (!tagSelected) {
    const tc = document.getElementById('tag-current');
    tc.style.borderColor = 'rgba(255,80,80,.7)';
    setTimeout(() => { tc.style.borderColor = ''; }, 700);
    return;
  }
  e.stopPropagation(); e.preventDefault();
  const img = lbImgs[idx];
  if (!img || !img.postId) return;

  const pendingKey = img.imageFile || String(idx);
  const pending = tagPending.get(pendingKey);
  const skySet  = pending ? pending.skylanders : new Set((img.skylanders || []).map(n => n.toLowerCase()));
  const name    = tagSelected.name.toLowerCase();

  if (skySet.has(name)) skySet.delete(name); else skySet.add(name);
  tagPending.set(pendingKey, { skylanders: skySet, lbIdx: idx });

  card.classList.toggle('tagged-sel', skySet.has(name));
  updateCardStrip(card, [...skySet]);

  const cnt = tagPending.size;
  document.getElementById('tag-save-cnt').textContent = cnt;
  document.getElementById('tag-save').classList.toggle('pending', cnt > 0);
}

async function batchSave() {
  if (!tagPending.size) return;
  const btn = document.getElementById('tag-save');
  btn.textContent = 'Saving\\u2026';

  const results = await Promise.all([...tagPending.entries()].map(([imageFile, { skylanders, lbIdx }]) => {
    const entry = lbImgs[lbIdx];
    if (!entry) return Promise.resolve(false);
    return fetch(EDIT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: entry.postId, imageFile, skylanders: [...skylanders] }),
    })
    .then(r => r.ok ? true : false)
    .catch(() => false);
  }));

  const failCount = results.filter(r => !r).length;
  if (failCount === 0) {
    for (const [, { skylanders, lbIdx }] of tagPending) {
      const entry = lbImgs[lbIdx];
      if (entry) entry.skylanders = [...skylanders];
    }
    tagPending.clear();
    btn.innerHTML = '\\u2713 Saved';
    btn.classList.remove('pending');
    setTimeout(() => { btn.innerHTML = 'Save <span id="tag-save-cnt">0</span>'; }, 2200);
  } else {
    btn.innerHTML = failCount + ' failed \\u2014 retry? <span id="tag-save-cnt">' + tagPending.size + '</span>';
    btn.classList.add('pending');
  }
}

document.getElementById('tag-search').addEventListener('input', e => {
  buildTagList(e.target.value.toLowerCase().trim());
});
`;

const editPanelJS = isPublish ? '' : `
${editPanelJS}

let _st;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(_st);
  _st = setTimeout(() => { query = e.target.value.toLowerCase().trim(); render(); }, 220);
});

render();
</script>
</body>
</html>`;

// Local standalone version — relative image paths (works via file:// or localhost:7373)
writeFileSync(join(OUT, 'index.html'), html.replace(/'__ARCHIVE_BASE__'/, "''"));

// Website version — absolute paths so it works when served from Eleventy at a different port
const websiteOutDir = join(__dir, '../src/pages/server/skylanders/archive');
if (existsSync(websiteOutDir) || (() => { mkdirSync(websiteOutDir, { recursive: true }); return true; })()) {
  writeFileSync(
    join(websiteOutDir, 'index.html'),
    html.replace(/'__ARCHIVE_BASE__'/, "'http://localhost:7373/'")
  );
}
console.log(`index.html rebuilt.\nDone.`);
