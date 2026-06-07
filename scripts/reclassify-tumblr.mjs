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
// ── Edit panel ─────────────────────────────────────────────────────────────
const EDIT_API = 'http://localhost:7373/api/update';
let _editImg = null;
let _editSkyTags = [];

// Populate skylander datalist from all known tags
const _allTags = new Set();
for (const g of GO) for (const imgs of Object.values(TREE[g] ?? {}))
  for (const img of imgs) (img.tags || []).forEach(t => _allTags.add(t));
const _skyListEl = document.getElementById('edit-sky-list');
[..._allTags].sort().forEach(t => {
  const o = document.createElement('option'); o.value = t; _skyListEl.appendChild(o);
});

function fillEditPanel(img) {
  _editImg = img;
  if (!_editImg) return;
  _editSkyTags = [...(_editImg.skylanders || [])];
  // Populate game select
  const gameEl = document.getElementById('edit-game');
  gameEl.innerHTML = GO.map(g =>
    '<option value="' + g + '"' + (g === _editImg.game ? ' selected' : '') + '>' + (GAME_LBL[g] || g) + '</option>'
  ).join('');
  editUpdateCats();
  // Set current category
  const catEl = document.getElementById('edit-cat');
  if ([...catEl.options].some(o => o.value === _editImg.category)) catEl.value = _editImg.category;
  document.getElementById('edit-cat-new').value = '';
  document.getElementById('edit-sky').value = '';
  document.getElementById('edit-status').textContent = '';
  document.getElementById('edit-status').className = '';
  // Annotation checkboxes
  const anns = _editImg.annotations || [];
  document.getElementById('edit-ann-bg').checked     = anns.includes('background');
  document.getElementById('edit-ann-detail').checked = anns.includes('detail');
  renderEditSkyTags();
}

function toggleEdit() {
  const panel = document.getElementById('lb-edit');
  const lb    = document.getElementById('lb');
  const open  = panel.classList.contains('open');
  if (open) {
    panel.classList.remove('open');
    lb.classList.remove('editing');
  } else {
    if (!lbImgs[lbIdx]) return;
    panel.classList.add('open');
    lb.classList.add('editing');
    fillEditPanel(lbImgs[lbIdx]);
  }
}

function editUpdateCats() {
  const g = document.getElementById('edit-game').value;
  const cats = Object.keys(TREE[g] || {}).sort();
  const catEl = document.getElementById('edit-cat');
  const prev = catEl.value;
  catEl.innerHTML = cats.map(c => '<option value="' + c + '">' + CAT_LBL(c) + '</option>').join('');
  if (cats.includes(prev)) catEl.value = prev;
}

function renderEditSkyTags() {
  const row = document.getElementById('edit-sky-tags-row');
  const el  = document.getElementById('edit-sky-tags');
  if (_editSkyTags.length === 0) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  el.innerHTML = _editSkyTags.map(t =>
    '<span class="edit-tag">' + t +
    ' <button class="rm-sky-tag" data-t="' + t.replace(/"/g, '&quot;') + '">' + '\\xd7' + '</button></span>'
  ).join('');
}

document.getElementById('edit-sky-tags').addEventListener('click', e => {
  const btn = e.target.closest('.rm-sky-tag');
  if (btn) { _editSkyTags = _editSkyTags.filter(t => t !== btn.dataset.t); renderEditSkyTags(); }
});

async function applyEdit() {
  const img = _editImg;
  if (!img) return;
  const statusEl = document.getElementById('edit-status');

  const newGame    = document.getElementById('edit-game').value;
  const catNewRaw  = document.getElementById('edit-cat-new').value.trim();
  const newCategory = catNewRaw
    ? catNewRaw.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    : document.getElementById('edit-cat').value;
  const skyInput = document.getElementById('edit-sky').value.trim().toLowerCase();
  if (skyInput && !_editSkyTags.includes(skyInput)) _editSkyTags.push(skyInput);

  const newAnns = [];
  if (document.getElementById('edit-ann-bg').checked)     newAnns.push('background');
  if (document.getElementById('edit-ann-detail').checked) newAnns.push('detail');

  const payload = { postId: img.postId, imageFile: img.imageFile };
  if (newGame !== img.game || newCategory !== img.category) {
    payload.game = newGame;
    payload.category = newCategory;
  }
  const origSky = (img.skylanders || []).slice().sort().join(',');
  if (_editSkyTags.slice().sort().join(',') !== origSky) {
    payload.skylanders = [..._editSkyTags];
  }
  const origAnns = (img.annotations || []).slice().sort().join(',');
  if (newAnns.slice().sort().join(',') !== origAnns) {
    payload.annotations = newAnns;
  }

  if (!payload.game && payload.skylanders === undefined && payload.annotations === undefined) {
    statusEl.textContent = 'No changes.'; statusEl.className = ''; return;
  }

  const applyBtn = document.getElementById('edit-apply-btn');
  statusEl.textContent = 'Saving\\u2026'; statusEl.className = '';
  if (applyBtn) applyBtn.disabled = true;
  try {
    const res = await fetch(EDIT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Server responded ' + res.status);

    if (payload.game) {
      // Move every image of this post into its new game/category bucket and
      // recompute its on-disk path — otherwise the lightbox keeps pointing at
      // the old (soon to be deleted) location and the image fails to load.
      const moved = [];
      for (const g of Object.keys(TREE)) {
        for (const c of Object.keys(TREE[g])) {
          const bucket = TREE[g][c];
          for (let i = bucket.length - 1; i >= 0; i--) {
            if (bucket[i].postId === img.postId) moved.push(...bucket.splice(i, 1));
          }
        }
      }
      for (const entry of moved) {
        entry.game     = newGame;
        entry.category = newCategory;
        if (entry.imageFile) entry.path = newGame + '/' + newCategory + '/' + entry.imageFile;
      }
      const destBucket = ((TREE[newGame] ??= {})[newCategory] ??= []);
      destBucket.push(...moved);
      closeLb();
      render();
    }
    if (payload.skylanders !== undefined) {
      const newSky = [..._editSkyTags];
      img.skylanders = newSky;
      const card = document.querySelector('[data-lb-idx="' + lbIdx + '"]');
      if (card) updateCardStrip(card, newSky);
      document.getElementById('edit-sky').value = '';
      renderEditSkyTags();
    }
    if (payload.annotations !== undefined) {
      img.annotations = newAnns;
      // Refresh the grid/sidebar (annotation filter counts + filtered lists depend on this)
      // and keep the lightbox pointed at the same image if it's still in view.
      render();
      const newIdx = lbImgs.indexOf(img);
      if (newIdx !== -1) lbIdx = newIdx;
      else closeLb();
    }
    statusEl.textContent = '\\u2713 Saved'; statusEl.className = 'ok';
    setTimeout(() => { if (statusEl.textContent === '\\u2713 Saved') statusEl.textContent = ''; }, 2500);
  } catch (e) {
    const msg = e.message || '';
    statusEl.className = 'err';
    statusEl.textContent = msg.includes('fetch') || msg.includes('Failed')
      ? 'Start the server: node scripts/archive-server.mjs ~/Desktop/skylanders-archive'
      : 'Error: ' + msg;
  } finally {
    if (applyBtn) applyBtn.disabled = false;
  }
}
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Skylanders Archive</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0e0e14;--bg2:#14142a;--bg3:#111120;--bd:rgba(255,255,255,.08);
  --txt:#ddd;--muted:rgba(255,255,255,.38);--gold:#ffcc00;--acc:#4f7aff;--sb:234px}
html,body{height:100%;overflow:hidden}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--txt);
  display:flex;flex-direction:column}
#hdr{flex:0 0 50px;background:var(--bg2);border-bottom:2px solid var(--gold);
  display:flex;align-items:center;gap:12px;padding:0 18px;min-width:0}
#hdr h1{color:var(--gold);font-size:.85rem;text-transform:uppercase;letter-spacing:1.5px;white-space:nowrap}
#hdr p{font-size:.68rem;color:var(--muted);white-space:nowrap;flex-shrink:0}
#q{margin-left:auto;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);
  color:#fff;padding:5px 11px;border-radius:4px;font-size:.78rem;font-family:inherit;width:200px;flex-shrink:0}
#q::placeholder{color:var(--muted)}
#q:focus{outline:none;border-color:rgba(255,204,0,.5)}
#layout{flex:1 1 0;min-height:0;display:grid;grid-template-columns:var(--sb) 1fr}
#sb{overflow-y:auto;background:var(--bg2);border-right:1px solid var(--bd);padding:6px 0}
.sb-all{display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;cursor:pointer;font-size:.72rem;color:var(--muted);
  border-bottom:1px solid var(--bd);margin-bottom:4px;transition:color .12s;gap:6px}
.sb-all:hover,.sb-all.on{color:#fff}
.sb-all.on{color:var(--gold);font-weight:600}
.sb-all .cnt{font-size:.62rem;flex-shrink:0}
.sb-game{border-bottom:1px solid rgba(255,255,255,.04)}
.sb-ttl{padding:6px 14px 6px 10px;cursor:pointer;display:flex;align-items:center;gap:5px;
  font-size:.7rem;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);
  transition:background .1s,color .12s;user-select:none}
.sb-ttl:hover{background:rgba(255,255,255,.04);color:#fff}
.sb-ttl.on{color:var(--gold)}
.sb-arrow{font-size:.55rem;transition:transform .15s;flex-shrink:0;opacity:.5}
.sb-ttl.open .sb-arrow{transform:rotate(90deg)}
.sb-gname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-gcnt{font-size:.6rem;flex-shrink:0;color:var(--muted)}
.sb-ttl.on .sb-gcnt{color:rgba(255,204,0,.6)}
.sb-cats{display:none}
.sb-cats.open{display:block}
.sb-cat{display:flex;align-items:flex-start;gap:5px;padding:4px 12px 4px 22px;cursor:pointer;
  font-size:.68rem;color:var(--muted);border-radius:3px;margin:1px 5px;
  transition:background .1s,color .12s}
.sb-cat:hover{background:rgba(255,255,255,.05);color:#ccc}
.sb-cat.on{background:rgba(79,122,255,.2);color:var(--acc)}
.sb-cat span{flex:1;min-width:0;line-height:1.35}
.sb-cat .cnt{font-size:.58rem;flex:0 0 2.5ch;text-align:right}
.sb-cat.on .cnt{color:rgba(79,122,255,.7)}
#main{overflow-y:auto;padding:14px 18px}
.sec{margin-bottom:26px}
.sec-hd{font-size:.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--gold);
  margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid rgba(255,204,0,.15);
  display:flex;align-items:baseline;gap:7px}
.sec-hd .cnt{color:var(--muted);font-size:.6rem;font-weight:normal;letter-spacing:0;text-transform:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:5px}
.card{background:rgba(255,255,255,.04);border-radius:5px;overflow:hidden;cursor:pointer;
  border:1px solid var(--bd);transition:transform .12s,border-color .12s,box-shadow .12s}
.card:hover{transform:translateY(-2px);border-color:rgba(255,204,0,.4);box-shadow:0 6px 18px rgba(0,0,0,.5)}
.card img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#1a1a2a}
.foot{padding:3px 6px;font-size:.6rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#empty{padding:60px 20px;text-align:center;color:var(--muted);font-size:.85rem}
#lb{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.92);
  align-items:center;justify-content:center;flex-direction:column;gap:10px;
  overflow-y:auto;padding:16px 0}
#lb.open{display:flex}
#lb-img{max-width:88vw;max-height:76vh;object-fit:contain;border-radius:6px;flex-shrink:0}
#lb.editing #lb-img{max-height:40vh}
#lb-meta{text-align:center;font-size:.76rem;color:var(--muted);line-height:1.8;max-width:600px}
#lb-meta a{color:#99ccff}
.lb-x{position:fixed;top:12px;right:16px;font-size:1.4rem;cursor:pointer;color:var(--muted)}
.lb-x:hover{color:#fff}
.lb-row{display:flex;align-items:center;gap:8px}
.lb-btn{background:rgba(255,204,0,.1);border:1px solid rgba(255,204,0,.3);color:var(--gold);
  padding:5px 14px;border-radius:5px;cursor:pointer;font-size:.75rem;font-family:inherit;text-decoration:none}
.lb-btn:hover{background:rgba(255,204,0,.22)}
.lb-arr{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#ddd;
  padding:5px 13px;border-radius:5px;cursor:pointer;font-size:1rem;font-family:inherit}
.lb-arr:hover{background:rgba(255,255,255,.16);color:#fff}
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,204,0,.25);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,204,0,.5)}
#lb-edit{display:none;background:rgba(14,14,28,.97);border:1px solid rgba(79,122,255,.35);
  border-radius:8px;padding:14px 18px;width:400px;max-width:90vw;margin-top:4px}
#lb-edit.open{display:block}
.edit-group{display:flex;align-items:center;gap:8px;margin-bottom:9px;font-size:.74rem}
.edit-group label{width:76px;flex-shrink:0;color:var(--muted);text-align:right}
.edit-group select,.edit-group input[type=text]{flex:1;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.18);color:#fff;padding:5px 9px;
  border-radius:4px;font-size:.74rem;font-family:inherit;min-width:0}
.edit-group select:focus,.edit-group input[type=text]:focus{outline:none;border-color:var(--acc)}
.edit-group select option{background:#1a1a2a;color:#fff}
#edit-sky-tags-row{display:none}
#edit-sky-tags{display:flex;flex-wrap:wrap;gap:4px;flex:1}
.edit-tag{background:rgba(79,122,255,.18);border:1px solid rgba(79,122,255,.3);
  color:#aab8e8;border-radius:3px;padding:2px 7px;font-size:.65rem;
  display:inline-flex;gap:4px;align-items:center}
.edit-tag button{background:none;border:none;color:#8899cc;cursor:pointer;
  padding:0;font-size:.8rem;line-height:1;font-family:inherit}
.edit-tag button:hover{color:#fff}
.edit-checks{display:flex;gap:14px;flex:1}
.edit-check{display:flex;align-items:center;gap:5px;cursor:pointer;font-size:.74rem;color:#ccc;
  user-select:none}
.edit-check input[type=checkbox]{accent-color:var(--acc);width:13px;height:13px;cursor:pointer}
.edit-actions{display:flex;align-items:center;gap:9px;margin-top:2px;padding-top:2px}
#edit-status{font-size:.68rem;color:var(--muted);flex:1}
#edit-status.ok{color:#66ee88}
#edit-status.err{color:#ff7766}
/* ── Tag Mode bar ─────────────────────────────────────────────────────────── */
#tag-bar{display:none;flex:0 0 auto;align-items:center;gap:8px;
  background:rgba(10,12,28,.96);border-bottom:2px solid rgba(255,204,0,.2);
  padding:0 14px;height:48px;min-width:0;overflow:hidden}
#tag-bar.open{display:flex}
#tag-mode-btn{flex-shrink:0;padding:4px 10px;background:rgba(255,204,0,.07);
  border:1.5px solid rgba(255,204,0,.22);color:var(--muted);border-radius:4px;
  cursor:pointer;font-size:.72rem;font-family:inherit;transition:all .12s;white-space:nowrap}
#tag-mode-btn:hover,#tag-mode-btn.on{background:rgba(255,204,0,.17);
  border-color:rgba(255,204,0,.5);color:var(--gold)}
#tag-current{flex-shrink:0;display:flex;align-items:center;gap:6px;padding:4px 12px;
  border-radius:20px;border:1.5px solid rgba(255,255,255,.14);font-size:.73rem;
  font-weight:700;background:rgba(255,255,255,.05);min-width:130px;white-space:nowrap}
.tag-dot{width:9px;height:9px;border-radius:50%;background:var(--muted);flex-shrink:0;
  transition:background .2s;box-shadow:0 0 6px currentColor}
#tag-search{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);
  color:#fff;padding:4px 10px;border-radius:4px;font-size:.73rem;font-family:inherit;
  width:130px;flex-shrink:0}
#tag-search:focus{outline:none;border-color:var(--acc)}
#tag-search::placeholder{color:var(--muted)}
#tag-list{display:flex;gap:5px;overflow-x:auto;flex:1;
  scrollbar-width:thin;scrollbar-color:rgba(255,204,0,.2) transparent;padding:6px 2px}
.tag-chip{flex-shrink:0;padding:3px 10px;border-radius:20px;font-size:.67rem;font-weight:700;
  cursor:pointer;border:1.5px solid;transition:filter .1s,transform .08s;
  white-space:nowrap;letter-spacing:.2px}
.tag-chip:hover{filter:brightness(1.35)}
.tag-chip:active{transform:scale(.95)}
.tag-chip.active{outline:2px solid var(--gold);outline-offset:1px;filter:brightness(1.3)}
#tag-save{flex-shrink:0;padding:5px 14px;background:rgba(80,220,100,.13);
  border:1.5px solid rgba(80,220,100,.4);color:#5fdc6f;border-radius:5px;cursor:pointer;
  font-size:.72rem;font-weight:700;font-family:inherit;display:none;white-space:nowrap}
#tag-save.pending{display:block}
#tag-save:hover{background:rgba(80,220,100,.23)}
.tb-exit{flex-shrink:0;background:none;border:none;color:var(--muted);font-size:1.1rem;
  cursor:pointer;padding:4px 6px;line-height:1;font-family:inherit}
.tb-exit:hover{color:#fff}
.tb-sep{flex-shrink:0;width:1px;height:24px;background:rgba(255,255,255,.1)}
/* Card tag state */
.card{position:relative}
.card-sky-strip{padding:3px 5px 2px;background:rgba(0,0,0,.55);
  display:flex;flex-wrap:wrap;gap:3px;min-height:0}
.card-sky-strip:empty{display:none}
.cst{font-size:.55rem;font-weight:700;padding:1px 6px;border-radius:10px;
  letter-spacing:.2px;white-space:nowrap}
body.tag-mode .card{cursor:crosshair}
body.tag-mode .card:hover{transform:none;box-shadow:inset 0 0 0 2px rgba(255,204,0,.4)}
body.tag-mode .card.tagged-sel{border-color:var(--gold);
  box-shadow:0 0 0 1px var(--gold),0 0 14px rgba(255,204,0,.3)}
body.tag-mode .card.tagged-sel::after{content:'\\2713';position:absolute;
  top:5px;right:6px;font-size:.9rem;color:var(--gold);
  text-shadow:0 1px 5px rgba(0,0,0,.9);pointer-events:none}

</style>
</head>
<body>
<div id="hdr">
  <h1>Skylanders Archive</h1>
  <p>${manifest.blog} &nbsp;·&nbsp; ${manifest.posts.length} posts &nbsp;·&nbsp; ${total} images &nbsp;·&nbsp; reclassified ${new Date().toISOString().slice(0,10)}</p>
  <input id="q" type="search" placeholder="Search…" autocomplete="off">${tagModeBtnHTML}
</div>${tagBarHTML}
<div id="layout">
  <aside id="sb"></aside>
  <main id="main"></main>
</div>

<div id="lb">
  <div class="lb-x" onclick="closeLb()">✕</div>
  <img id="lb-img" src="" alt="">
  <div id="lb-meta"></div>
  <div class="lb-row">
    <button class="lb-arr" onclick="stepLb(-1)">&#8249;</button>
    <a id="lb-dl"  class="lb-btn" download>&#8595; Save</a>
    <a id="lb-src" class="lb-btn" target="_blank">&#8599; Post</a>
    <button class="lb-arr" onclick="stepLb(1)">&#8250;</button>${editBtnHTML}
  </div>${editPanelHTML}
</div>

<script>
const ARCHIVE_BASE = '__ARCHIVE_BASE__';
// When true, every editing affordance below is gated off — the live site has
// no curation server to save to, so this build is sort/filter/view only.
const PUBLISH    = ${isPublish};
const TREE       = ${JSON.stringify(tree)};
const GAME_LBL   = ${JSON.stringify(gameMap)};
const GO         = ${JSON.stringify(gameOrder)};
const CAT_LBL    = c => c.replace(/-/g,' ').replace(/\\b\\w/g, l => l.toUpperCase());
const SKYLANDERS = ${JSON.stringify(SKYLANDERS_LIST)};
const EL_COL = {
  fire:'#C83200',water:'#0055AA',earth:'#8F5A10',wind:'#005588',
  magic:'#9900CC',nature:'#2C7200',undead:'#4444AA',tech:'#9A7000',
};

let sel     = {game: null, cat: null};
let annFilter = null; // null | 'background' | 'detail' — cross-cutting annotation filter
const expanded = new Set(GO);
let lbImgs  = [], lbIdx = 0;
let query   = '';
// Declared here (not inside tagModeJS) because makeCard/render reference it
// unconditionally — in --publish builds it just stays false forever.
let tagModeOn = false;

function searchMatch(img, q) {
  return [(img.subject||''), (img.tags||[]).join(' '), (img.text||'')].join(' ').toLowerCase().includes(q);
}

function catsSorted(g) {
  return Object.entries(TREE[g] ?? {}).sort((a,b) => b[1].length - a[1].length);
}

function annCount(ann) {
  let n = 0;
  for (const g of GO) {
    for (const [, imgs] of catsSorted(g)) {
      for (const img of imgs) {
        if ((img.annotations||[]).includes(ann) && (!query || searchMatch(img, query))) n++;
      }
    }
  }
  return n;
}

function renderSidebar() {
  const sb = document.getElementById('sb');
  sb.innerHTML = '';

  const allEl = document.createElement('div');
  allEl.className = 'sb-all' + (sel.game === null && sel.cat === null && !annFilter ? ' on' : '');
  allEl.innerHTML = '<span>All Images</span><span class="cnt">${total}</span>';
  allEl.addEventListener('click', () => { sel = {game:null, cat:null}; annFilter = null; render(); });
  sb.appendChild(allEl);

  for (const [ann, label] of [['background', 'Backgrounds'], ['detail', 'Details']]) {
    const cnt = annCount(ann);
    if (cnt === 0 && query) continue;
    const annEl = document.createElement('div');
    annEl.className = 'sb-all sb-ann' + (annFilter === ann ? ' on' : '');
    annEl.innerHTML = '<span>' + label + '</span><span class="cnt">' + cnt + '</span>';
    annEl.addEventListener('click', () => {
      annFilter = (annFilter === ann ? null : ann);
      sel = {game: null, cat: null};
      render();
    });
    sb.appendChild(annEl);
  }

  const q = query;
  for (const g of GO) {
    const gTotal = catsSorted(g).reduce((s,[,imgs]) => {
      return s + (q ? imgs.filter(i => searchMatch(i,q)).length : imgs.length);
    }, 0);
    if (gTotal === 0 && q) continue;

    const isOpen   = expanded.has(g);
    const isOnGame = sel.game === g && sel.cat === null;

    const gameEl = document.createElement('div');
    gameEl.className = 'sb-game';

    const ttl = document.createElement('div');
    ttl.className = 'sb-ttl' + (isOpen ? ' open' : '') + (isOnGame ? ' on' : '');
    ttl.innerHTML = '<span class="sb-arrow">&#9654;</span>'
      + '<span class="sb-gname">' + (GAME_LBL[g]??g) + '</span>'
      + '<span class="sb-gcnt">' + gTotal + '</span>';
    ttl.addEventListener('click', () => {
      if (sel.game === g && sel.cat === null && expanded.has(g) && !annFilter) {
        expanded.delete(g);
      } else {
        expanded.add(g);
        sel = {game: g, cat: null};
        annFilter = null;
      }
      render();
    });
    gameEl.appendChild(ttl);

    const catsEl = document.createElement('div');
    catsEl.className = 'sb-cats' + (isOpen ? ' open' : '');

    for (const [c, imgs] of catsSorted(g)) {
      const cnt = q ? imgs.filter(i => searchMatch(i,q)).length : imgs.length;
      if (cnt === 0 && q) continue;
      const isOnCat = sel.game === g && sel.cat === c;
      const catEl = document.createElement('div');
      catEl.className = 'sb-cat' + (isOnCat ? ' on' : '');
      catEl.innerHTML = '<span>' + CAT_LBL(c) + '</span><span class="cnt">' + cnt + '</span>';
      catEl.addEventListener('click', e => {
        e.stopPropagation();
        sel = {game: g, cat: c};
        annFilter = null;
        expanded.add(g);
        render();
      });
      catsEl.appendChild(catEl);
    }
    gameEl.appendChild(catsEl);
    sb.appendChild(gameEl);
  }
}

function makeCard(img, idx) {
  const card  = document.createElement('div');
  card.className = 'card';
  const label = img.subject || (img.tags||[]).slice(0,2).join(', ') || '';
  card.dataset.postId = img.postId || '';
  card.dataset.lbIdx  = idx;
  card.innerHTML = '<img src="' + ARCHIVE_BASE + img.path + '" loading="lazy" alt="">'
    + buildSkyStrip(img.skylanders || [])
    + '<div class="foot">' + label + '</div>';
  card.addEventListener('click', e => {
    if (tagModeOn) { handleTagClick(e, card, idx); return; }
    openLb(idx);
  });
  return card;
}

function renderGrid() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  lbImgs = [];
  let shown = 0;

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

  if (!shown) {
    const m = document.createElement('div'); m.id = 'empty';
    m.textContent = query ? 'No images match "' + query + '".' : 'No images here.';
    main.appendChild(m);
  }
}

function render() { renderSidebar(); renderGrid(); if (tagModeOn) refreshTagOverlays(); }

function openLb(idx) {
  lbIdx = Math.max(0, Math.min(idx, lbImgs.length - 1));
  const img = lbImgs[lbIdx];
  if (!img) return;
  // Keep the edit panel open across navigation — just refresh it for the new image
  // (#lb-edit / fillEditPanel only exist when editing UI is built — --publish omits both)
  const editPanel = document.getElementById('lb-edit');
  if (editPanel) {
    if (editPanel.classList.contains('open')) {
      fillEditPanel(img);
    } else {
      editPanel.classList.remove('open');
      document.getElementById('lb').classList.remove('editing');
    }
  }
  document.getElementById('lb-img').src  = ARCHIVE_BASE + img.path;
  document.getElementById('lb-dl').href  = ARCHIVE_BASE + img.path;
  document.getElementById('lb-src').href = img.postUrl || '#';
  const tags = (img.tags||[]).slice(0,8).join(', ');
  document.getElementById('lb-meta').innerHTML =
    (img.subject ? '<strong style="color:#fff">' + img.subject + '</strong><br>' : '') +
    (img.date ? img.date + '&nbsp;&#183;&nbsp;' : '') + tags;
  document.getElementById('lb').classList.add('open');
}
function stepLb(d) { openLb((lbIdx + d + lbImgs.length) % lbImgs.length); }
function closeLb() {
  const lb = document.getElementById('lb');
  lb.classList.remove('open', 'editing');
  document.getElementById('lb-edit')?.classList.remove('open');
}

document.getElementById('lb').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLb();
});
document.addEventListener('keydown', e => {
  // #lb-edit / toggleEdit only exist when editing UI is built (--publish omits both)
  const editPanel = document.getElementById('lb-edit');
  const editOpen  = !!editPanel && editPanel.classList.contains('open');
  if (e.key === 'Escape') {
    if (editOpen) toggleEdit(); else closeLb();
  } else if (!editOpen) {
    if      (e.key === 'ArrowLeft')  stepLb(-1);
    else if (e.key === 'ArrowRight') stepLb(1);
  }
});

function buildSkyStrip(arr) {
  if (!arr || !arr.length) return '<div class="card-sky-strip"></div>';
  const chips = arr.map(n => {
    const sky = SKYLANDERS.find(s => s.name.toLowerCase() === n.toLowerCase());
    const col = sky ? (EL_COL[sky.element] || '#444') : '#444';
    return '<span class="cst" style="background:' + col + '28;border:1px solid '
      + col + '66;color:#ddd">' + n + '</span>';
  }).join('');
  return '<div class="card-sky-strip">' + chips + '</div>';
}

// ── Tag Mode ───────────────────────────────────────────────────────────────${tagModeJS}${editPanelJS}
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

// Website version — base path depends on build mode: the curation server's
// localhost URL for local iteration, or the statically-synced publish path
// for the live site (which has no server to talk to).
const PUBLISH_IMAGE_BASE = '/images/skylanders-archive/';
const websiteOutDir = join(__dir, '../src/pages/server/skylanders/archive');
mkdirSync(websiteOutDir, { recursive: true });
writeFileSync(
  join(websiteOutDir, 'index.html'),
  html.replace(/'__ARCHIVE_BASE__'/, `'${isPublish ? PUBLISH_IMAGE_BASE : 'http://localhost:7373/'}'`)
);

if (isPublish) {
  // ── Sync image files into the website so the live site can serve them
  // statically — no curation server required to browse the archive.
  const publishImagesDir = join(__dir, '../src/images/skylanders-archive');
  mkdirSync(publishImagesDir, { recursive: true });
  console.log(`Syncing images to ${publishImagesDir} …`);
  const rsync = spawnSync('rsync', [
    '-a', '--delete',
    '--exclude=_images', '--exclude=*.json*', '--exclude=*.html', '--exclude=.DS_Store',
    OUT + '/', publishImagesDir + '/',
  ], { stdio: 'inherit' });
  if (rsync.status !== 0) {
    console.error('rsync failed — aborting publish.');
    process.exit(1);
  }

  // ── Static Skylander image index — the published equivalent of the
  // curation server's /api/skylanders-index endpoint, so the NFC card
  // maker's archive art pickers work on the live site without a server.
  const byCharacter = {};
  const backgrounds = [];
  const details = [];
  for (const post of manifest.posts) {
    const postAnns = post.annotations || [];
    for (const img of (post.images || [])) {
      if (img.error || !img.file || !img.path) continue;
      const imgAnns = img.annotations?.length ? img.annotations : postAnns;
      const entry = {
        url:    PUBLISH_IMAGE_BASE + img.path,
        anns:   imgAnns,
        game:   img.game || post.game,
        file:   img.file,
        postId: String(post.id),
      };
      if (imgAnns.includes('background')) backgrounds.push(entry);
      if (imgAnns.includes('detail'))     details.push(entry);
      const skyNames = Array.isArray(img.skylanders) ? img.skylanders : (post.skylanders || []);
      for (const name of skyNames) {
        const key = name.toLowerCase();
        (byCharacter[key] = byCharacter[key] || []).push(entry);
      }
    }
  }
  writeFileSync(
    join(publishImagesDir, 'skylanders-index.json'),
    JSON.stringify({ byCharacter, backgrounds, details })
  );
  console.log(`Published ${total} images + skylanders-index.json to ${publishImagesDir}`);
}

console.log(`index.html rebuilt.\nDone.`);

