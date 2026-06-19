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
 *   node scripts/reclassify-tumblr.mjs ./skylanders-archive
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
// Flavour/copy text for the archive SPA (dashboard taglines, hero card,
// model viewer hints, etc.) — kept out of the generator so it can be edited
// without touching this script.
const _vocabPath = join(__dir, '../src/_data/archive-vocab.json');
const VOCAB = existsSync(_vocabPath) ? JSON.parse(readFileSync(_vocabPath, 'utf8')) : {};

const _skyJsonPath = join(__dir, '../src/_data/skylanders.json');
const SKYLANDERS_LIST = existsSync(_skyJsonPath)
  ? JSON.parse(readFileSync(_skyJsonPath, 'utf8'))
      .flatMap(g => g.characters.map(c => ({
        name: c.name,
        game: g.game,
        element: c.element || '',
        species: c.species || '',
        gender: c.gender || '',
        role: c.role || '',
        owned: !!c.owned,
        level: c.level ?? null,
        favorite: !!c.favorite,
        image: c.image || '',
        extra: c.extra || {},
        render: c.render || null,
        figures: c.figures || [],
        abilityIcons: c.abilityIcons || [],
        variants: c.variants || [],
      })))
  : [];

// Load Lost Islands character models for fuzzy-matching into profile viewer
const _modelsJsonPath = join(__dir, '../src/pages/server/skylanders/models/models.json');
const _charModels = existsSync(_modelsJsonPath)
  ? JSON.parse(readFileSync(_modelsJsonPath, 'utf8'))
      .filter(m => m.dir && m.dir.includes('TFBModels/Characters'))
  : [];
{
  const normName = s => s.toLowerCase().replace(/[\s_\-]/g, '').replace(/wii$/, '');
  for (const c of SKYLANDERS_LIST) {
    const cn = normName(c.name);
    c.models = _charModels
      .filter(m => { const mn = normName(m.name); return mn.includes(cn) || cn.includes(mn); })
      .map(({ id, name, obj, json, texture }) => ({ id, name, obj, json, texture }));
  }
}

// Variant figures (e.g. "Super Shot Stealth Elf") map to their base character
// ("Stealth Elf") — detected by name suffix. Tag mode shows these as secondary
// chips under the base and tags images with both names.
const VARIANT_TO_BASE = {};
{
  const allNames = SKYLANDERS_LIST.map(s => s.name);
  const norm = n => n.replace(/-/g, ' ');
  for (const n of allNames) {
    for (const m of allNames) {
      if (n !== m && norm(n).endsWith(' ' + norm(m))) VARIANT_TO_BASE[n] = m;
    }
  }
}

if (!existsSync(OUT)) {
  console.error(`Archive not found: ${OUT}`); process.exit(1);
}
const manifestPath = join(OUT, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`No manifest.json in ${OUT}`); process.exit(1);
}

// Per-game dashboard layouts (category card order/visibility + custom link
// and text blocks), edited via the "Edit dashboard" builder in the archive UI.
const dashboardLayoutPath = join(OUT, 'dashboard-layout.json');
const DASHBOARD_LAYOUT = existsSync(dashboardLayoutPath)
  ? JSON.parse(readFileSync(dashboardLayoutPath, 'utf8'))
  : {};

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
  { id: 'lost-islands',     label: 'Lost Islands',
    rx: [/lost.?islands/i, /\bsli\b/i] },
  { id: 'ring-of-heroes',   label: 'Ring of Heroes',
    rx: [/ring.?of.?heroes/i, /\broh\b/i] },
  { id: 'battlecast',       label: 'Battlecast',
    rx: [/battlecast/i] },
];

// Escapes VOCAB strings for use as HTML text/attribute content in the
// templates below (server-side; the client has its own escAttr for data).
const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');

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
  post.subject  = post._manual ? (post.subject || subject) : subject;

  for (const img of post.images ?? []) {
    if (img.error || !img.file) continue;
    const storeSrc = join(imgStore, img.file);
    if (!existsSync(storeSrc)) { missing++; continue; }

    // Per-image manual overrides (set via the curation UI on multi-image
    // posts) win over the post's auto/manual classification.
    const imgGame     = img._manual ? (img.game ?? newGame) : newGame;
    const imgCategory = img._manual ? (img.category ?? newCategory) : newCategory;
    img.game     = imgGame;
    img.category = imgCategory;
    img.path     = join(imgGame, imgCategory, img.file);

    const dest      = join(OUT, imgGame, imgCategory, img.file);
    const locations = fileLocations.get(img.file) ?? new Set();
    const stales    = [...locations].filter(loc => loc !== dest);
    hardLink(storeSrc, dest);

    if (stales.length) {
      moved++;
      changes.push({ id: post.id, subject: post.subject ?? subject,
        from: relative(OUT, dirname(stales[0])), to: `${imgGame}/${imgCategory}` });
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
      source: img.source ?? post.url,
      subject: post.subject, text: post.text,
      game: g, category: c,
      skylanders: Array.isArray(img.skylanders) ? img.skylanders : (post.skylanders || []),
      annotations: post.annotations || [],
      featured: img.featured !== false,
    });
  }
}

const gameOrder = [...GAMES.map(g => g.id), 'misc'].filter(id => tree[id]);

// Short per-game prefixes for stable, human-referenceable image IDs (e.g.
// "GI-0042"), so any image in the archive can be pointed to in chat the same
// way the Lost Islands model/texture viewer uses LI-M-###/LI-T-####.
const GAME_CODE = {
  'spyros-adventure': 'SA', giants: 'GI', 'swap-force': 'SF', 'trap-team': 'TT',
  superchargers: 'SC', imaginators: 'IM', academy: 'AC', 'lost-islands': 'LI',
  'ring-of-heroes': 'RH', battlecast: 'BC', misc: 'MS',
};
for (const g of gameOrder) {
  const code = GAME_CODE[g] ?? g.slice(0, 2).toUpperCase();
  let n = 0;
  for (const imgs of Object.values(tree[g])) {
    for (const img of imgs) img.id = code + '-' + String(++n).padStart(4, '0');
  }
}

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
// Always built into `html` (the local curation copy at OUT/index.html needs
// it regardless of how this script was invoked). Stripped back out via
// string removal for the --publish website copy below — the live site has
// no curation server to talk to, so none of this can function there —
// sorting/filtering/viewing stays, everything that calls EDIT_API or mutates
// the archive goes.
const tagModeBtnHTML = `
  <button id="tag-mode-btn" onclick="toggleTagMode()" title="Enter tag mode to mass-assign Skylander characters">⊕ Tag</button>`;

const tagBarHTML = `
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

const editBtnHTML = `
    <button class="lb-btn" id="lb-edit-btn" onclick="toggleEdit()">&#9998; Edit</button>`;

const addImageBtnHTML = `
  <button id="add-image-btn" onclick="openAddModal()" title="Add new image(s) to the archive">+ Add Image</button>`;

const publishBtnHTML = `
  <button id="publish-btn" onclick="publishArchive()" title="Re-sort, regenerate the site's archive page, and sync images into src/images/skylanders-archive/">Publish</button>
  <span id="publish-status"></span>`;

const addModalHTML = `
<div id="add-modal">
  <div id="add-modal-box">
    <h2>Add Image</h2>
    <div id="add-drop">Drop images here, or click to choose…
      <input type="file" id="add-file-input" accept="image/*" multiple style="display:none">
    </div>
    <div id="add-preview"></div>
    <div class="edit-group">
      <label>Game</label>
      <select id="add-game" onchange="addUpdateCats()"></select>
    </div>
    <div class="edit-group">
      <label>Category</label>
      <select id="add-cat"></select>
      <input type="text" id="add-cat-new" placeholder="or new…" style="max-width:130px">
    </div>
    <div class="edit-group">
      <label>Skylander</label>
      <input type="text" id="add-sky" list="edit-sky-list" placeholder="Character name…">
      <button class="lb-btn" type="button" id="add-sky-btn" style="flex:0 0 auto;padding:5px 10px">+</button>
    </div>
    <div class="edit-group" id="add-sky-tags-row">
      <label>Tagged</label>
      <div id="add-sky-tags"></div>
    </div>
    <div class="edit-actions">
      <button class="lb-btn" id="add-submit-btn" onclick="submitAddImages()">Add</button>
      <button class="lb-btn" onclick="closeAddModal()" style="opacity:.55">Cancel</button>
      <span id="add-status"></span>
    </div>
  </div>
</div>`;

const aboutModalHTML = `
<div id="about-modal">
  <div id="about-modal-box">
    <h2>About this archive</h2>
    <h3>What this is</h3>
    <p>TODO: one or two sentences on what this archive is and who it's for.</p>
    <h3>What's here</h3>
    <p>TODO: the kinds of images collected (renders, icons, fan art, screenshots) and where they come from.</p>
    <h3>How it's organized</h3>
    <p>TODO: by game, then by category folder; "By Character" groups everything across games for one character.</p>
    <h3>Status</h3>
    <p>TODO: ongoing/hand-curated, may have gaps or misfiled items.</p>
    <button class="lb-btn about-close" onclick="closeAboutModal()">Close</button>
  </div>
</div>`;

const imagePickerModalHTML = `
<div id="img-picker-modal">
  <div id="img-picker-box">
    <h2 id="img-picker-title">Select image</h2>
    <input type="text" id="img-picker-search" placeholder="Filter…" autocomplete="off">
    <div id="img-picker-grid" class="grid"></div>
    <div class="edit-actions">
      <button class="lb-btn" id="img-picker-done" onclick="closeImagePicker(true)">Done</button>
      <button class="lb-btn" onclick="closeImagePicker(false)" style="opacity:.55">Cancel</button>
    </div>
  </div>
</div>`;

const editPanelHTML = `
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
    <div class="edit-group">
      <label>Visibility</label>
      <div class="edit-checks">
        <label class="edit-check"><input type="checkbox" id="edit-featured"> Featured (NFC card picker)</label>
      </div>
    </div>
    <div class="edit-group">
      <label>Source URL</label>
      <input type="text" id="edit-source" placeholder="https://…">
    </div>
    <div class="edit-actions">
      <button class="lb-btn" id="edit-apply-btn" onclick="applyEdit()">Apply</button>
      <button class="lb-btn" onclick="toggleEdit()" style="opacity:.55">Cancel</button>
      <span id="edit-status"></span>
    </div>
    <div class="edit-actions" style="border-top:1px solid rgba(255,255,255,.08);margin-top:7px;padding-top:9px">
      <button class="lb-btn danger" id="edit-remove-btn" onclick="removeImage()">&#128465; Remove Image</button>
    </div>
  </div>`;

const tagModeJS = `
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
  // Variant figures (e.g. "Super Shot Stealth Elf") render as secondary chips
  // under their base character instead of as their own top-level entry.
  const bases = SKYLANDERS.filter(s => !VARIANTS[s.name]);
  list.innerHTML = '';
  bases.forEach(s => {
    const variants      = SKYLANDERS.filter(v => VARIANTS[v.name] === s.name);
    const baseMatches   = !lq || s.name.toLowerCase().includes(lq);
    const shownVariants = baseMatches ? variants : variants.filter(v => v.name.toLowerCase().includes(lq));
    if (!baseMatches && !shownVariants.length) return;

    const col  = EL_COL[s.element] || '#444';
    const chip = document.createElement('button');
    chip.className = 'tag-chip' + (tagSelected?.name === s.name ? ' active' : '');
    chip.textContent = s.name;
    chip.style.cssText = 'background:' + col + '22;border-color:' + col + '55;color:#eee';
    chip.addEventListener('click', () => selectChar(s));
    list.appendChild(chip);

    shownVariants.forEach(v => {
      const vchip = document.createElement('button');
      vchip.className = 'tag-chip variant' + (tagSelected?.name === v.name ? ' active' : '');
      vchip.textContent = v.name;
      vchip.style.cssText = 'background:' + col + '14;border-color:' + col + '40;color:#bbb';
      vchip.addEventListener('click', () => selectChar(v, s.name));
      list.appendChild(vchip);
    });
  });
}

function selectChar(s, base) {
  tagSelected = base ? { name: s.name, element: s.element, base } : { name: s.name, element: s.element };
  const col = EL_COL[s.element] || '#888';
  document.getElementById('tag-dot').style.cssText = 'background:' + col + ';box-shadow:0 0 6px ' + col;
  document.getElementById('tag-current-name').textContent = base ? s.name + ' (' + base + ')' : s.name;
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
  // Variant chips tag the image with both the variant name and its base
  // character, so it shows up under both in "By Character".
  const names   = tagSelected.base ? [name, tagSelected.base.toLowerCase()] : [name];

  if (skySet.has(name)) names.forEach(n => skySet.delete(n));
  else names.forEach(n => skySet.add(n));
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

const editPanelJS = `
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
  document.getElementById('edit-featured').checked   = _editImg.featured !== false;
  document.getElementById('edit-source').value = _editImg.source || '';
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

  const newFeatured = document.getElementById('edit-featured').checked;
  const newSource = document.getElementById('edit-source').value.trim();

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
  if (newFeatured !== (img.featured !== false)) {
    payload.featured = newFeatured;
  }
  if (newSource !== (img.source || '')) {
    payload.source = newSource;
  }

  if (!payload.game && payload.skylanders === undefined && payload.annotations === undefined
      && payload.featured === undefined && payload.source === undefined) {
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
      // Move just the edited image into its new game/category bucket and
      // recompute its on-disk path — otherwise the lightbox keeps pointing at
      // the old (soon to be deleted) location and the image fails to load.
      // Other images from the same post stay where they are.
      const moved = [];
      for (const g of Object.keys(TREE)) {
        for (const c of Object.keys(TREE[g])) {
          const bucket = TREE[g][c];
          for (let i = bucket.length - 1; i >= 0; i--) {
            if (bucket[i].postId === img.postId && bucket[i].imageFile === img.imageFile) {
              moved.push(...bucket.splice(i, 1));
            }
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
    if (payload.featured !== undefined) {
      img.featured = newFeatured;
      // Featured/Not-Featured sections (character view) and card badges depend
      // on this — refresh, and keep the lightbox pointed at the same image.
      render();
      const newIdx = lbImgs.indexOf(img);
      if (newIdx !== -1) lbIdx = newIdx;
      else closeLb();
    }
    if (payload.source !== undefined) {
      img.source = newSource;
      const lbSrc = document.getElementById('lb-src');
      if (lbSrc) lbSrc.href = img.source || img.postUrl || '#';
    }
    statusEl.textContent = '\\u2713 Saved'; statusEl.className = 'ok';
    setTimeout(() => { if (statusEl.textContent === '\\u2713 Saved') statusEl.textContent = ''; }, 2500);
  } catch (e) {
    const msg = e.message || '';
    statusEl.className = 'err';
    statusEl.textContent = msg.includes('fetch') || msg.includes('Failed')
      ? 'Start the server: node scripts/archive-server.mjs ./skylanders-archive'
      : 'Error: ' + msg;
  } finally {
    if (applyBtn) applyBtn.disabled = false;
  }
}

async function removeImage() {
  const img = _editImg;
  if (!img) return;
  if (!confirm('Remove this image from the archive?\\n\\nThe file is moved to _removed/ in the archive folder (not permanently deleted) and disappears from this view.')) return;

  const statusEl = document.getElementById('edit-status');
  const removeBtn = document.getElementById('edit-remove-btn');
  statusEl.textContent = 'Removing\\u2026'; statusEl.className = '';
  if (removeBtn) removeBtn.disabled = true;
  try {
    const res = await fetch(EDIT_API.replace('/update', '/remove-image'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postId: img.postId, imageFile: img.imageFile }),
    });
    if (!res.ok) throw new Error('Server responded ' + res.status);

    const bucket = TREE[img.game]?.[img.category];
    if (bucket) {
      const i = bucket.indexOf(img);
      if (i !== -1) bucket.splice(i, 1);
    }
    closeLb();
    render();
  } catch (e) {
    const msg = e.message || '';
    statusEl.className = 'err';
    statusEl.textContent = msg.includes('fetch') || msg.includes('Failed')
      ? 'Start the server: node scripts/archive-server.mjs ./skylanders-archive'
      : 'Error: ' + msg;
    if (removeBtn) removeBtn.disabled = false;
  }
}
`;

const addModalJS = `
// ── Add Image modal ─────────────────────────────────────────────────────────
const ADD_API = EDIT_API.replace('/update', '/add-image');
let _addFiles = []; // { name, dataUrl }
let _addSkyTags = [];

function renderAddSkyTags() {
  const row = document.getElementById('add-sky-tags-row');
  const el  = document.getElementById('add-sky-tags');
  if (_addSkyTags.length === 0) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  el.innerHTML = _addSkyTags.map(t =>
    '<span class="edit-tag">' + t +
    ' <button class="rm-add-sky-tag" data-t="' + t.replace(/"/g, '&quot;') + '">' + '\\xd7' + '</button></span>'
  ).join('');
}

document.getElementById('add-sky-tags').addEventListener('click', e => {
  const btn = e.target.closest('.rm-add-sky-tag');
  if (btn) { _addSkyTags = _addSkyTags.filter(t => t !== btn.dataset.t); renderAddSkyTags(); }
});

function addSkyTagFromInput() {
  const input = document.getElementById('add-sky');
  const v = input.value.trim().toLowerCase();
  if (v && !_addSkyTags.includes(v)) _addSkyTags.push(v);
  input.value = '';
  renderAddSkyTags();
}

document.getElementById('add-sky-btn').addEventListener('click', addSkyTagFromInput);
document.getElementById('add-sky').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); addSkyTagFromInput(); }
});

function openAddModal() {
  const gameEl = document.getElementById('add-game');
  gameEl.innerHTML = GO.map(g => '<option value="' + g + '">' + (GAME_LBL[g] || g) + '</option>').join('');
  addUpdateCats();
  _addFiles = [];
  renderAddPreview();
  _addSkyTags = [];
  document.getElementById('add-sky').value = '';
  renderAddSkyTags();
  document.getElementById('add-cat-new').value = '';
  document.getElementById('add-status').textContent = '';
  document.getElementById('add-status').className = '';
  document.getElementById('add-modal').classList.add('open');
}

function closeAddModal() {
  document.getElementById('add-modal').classList.remove('open');
}

document.getElementById('add-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAddModal();
});

function addUpdateCats() {
  const g = document.getElementById('add-game').value;
  const cats = Object.keys(TREE[g] || {}).sort();
  const catEl = document.getElementById('add-cat');
  const prev = catEl.value;
  catEl.innerHTML = cats.map(c => '<option value="' + c + '">' + CAT_LBL(c) + '</option>').join('');
  if (cats.includes(prev)) catEl.value = prev;
}

function renderAddPreview() {
  const wrap = document.getElementById('add-preview');
  wrap.innerHTML = _addFiles.map((f, i) =>
    '<div class="add-thumb"><img src="' + f.dataUrl + '" alt="">'
    + '<button class="add-thumb-rm" type="button" data-i="' + i + '">\\u2715</button></div>'
  ).join('');
}

document.getElementById('add-preview').addEventListener('click', e => {
  const btn = e.target.closest('.add-thumb-rm');
  if (!btn) return;
  _addFiles.splice(parseInt(btn.dataset.i), 1);
  renderAddPreview();
});

function addFiles(fileList) {
  [...fileList].filter(f => f.type.startsWith('image/')).forEach(f => {
    const reader = new FileReader();
    reader.onload = () => {
      _addFiles.push({ name: f.name, dataUrl: reader.result });
      renderAddPreview();
    };
    reader.readAsDataURL(f);
  });
}

const _addDrop = document.getElementById('add-drop');
const _addFileInput = document.getElementById('add-file-input');
_addDrop.addEventListener('click', () => _addFileInput.click());
_addFileInput.addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach(ev => _addDrop.addEventListener(ev, e => {
  e.preventDefault(); _addDrop.classList.add('dragover');
}));
['dragleave', 'drop'].forEach(ev => _addDrop.addEventListener(ev, e => {
  e.preventDefault(); _addDrop.classList.remove('dragover');
}));
_addDrop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

async function submitAddImages() {
  const statusEl = document.getElementById('add-status');
  if (!_addFiles.length) { statusEl.className = 'err'; statusEl.textContent = 'Choose at least one image.'; return; }

  const game = document.getElementById('add-game').value;
  const catNewRaw = document.getElementById('add-cat-new').value.trim();
  const category = catNewRaw
    ? catNewRaw.toLowerCase().replace(/\\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    : document.getElementById('add-cat').value;

  if (!game || !category) { statusEl.className = 'err'; statusEl.textContent = 'Pick a game and category.'; return; }

  addSkyTagFromInput();
  const skylanders = [..._addSkyTags];

  const submitBtn = document.getElementById('add-submit-btn');
  submitBtn.disabled = true;
  statusEl.className = ''; statusEl.textContent = 'Adding\\u2026';

  try {
    const res = await fetch(ADD_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game, category, skylanders, files: _addFiles.map(f => ({ name: f.name, dataUrl: f.dataUrl })) }),
    });
    if (!res.ok) throw new Error('Server responded ' + res.status);
    const data = await res.json();

    const bucket = ((TREE[game] ??= {})[category] ??= []);
    for (const entry of data.added) {
      bucket.push({
        postId: entry.postId, imageFile: entry.imageFile, path: entry.path, url: '',
        date: entry.date, tags: [], postUrl: '', source: '', subject: entry.subject, text: '',
        game, category, skylanders: [...skylanders], annotations: [], featured: true,
      });
    }
    if (!GO.includes(game)) GO.push(game);

    statusEl.className = 'ok'; statusEl.textContent = '\\u2713 Added ' + data.added.length + ' image(s)';
    _addFiles = [];
    renderAddPreview();
    render();
    setTimeout(closeAddModal, 900);
  } catch (e) {
    const msg = e.message || '';
    statusEl.className = 'err';
    statusEl.textContent = msg.includes('fetch') || msg.includes('Failed')
      ? 'Start the server: node scripts/archive-server.mjs ./skylanders-archive'
      : 'Error: ' + msg;
  } finally {
    submitBtn.disabled = false;
  }
}
`;

const publishJS = `
// ── Publish ──────────────────────────────────────────────────────────────
const PUBLISH_API = EDIT_API.replace('/update', '/publish');

async function publishArchive() {
  const btn = document.getElementById('publish-btn');
  const statusEl = document.getElementById('publish-status');
  btn.disabled = true;
  statusEl.className = ''; statusEl.textContent = 'Publishing\\u2026';

  try {
    const res = await fetch(PUBLISH_API, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('Server responded ' + res.status));

    statusEl.className = 'ok'; statusEl.textContent = '\\u2713 Published';
    setTimeout(() => { if (statusEl.textContent === '\\u2713 Published') statusEl.textContent = ''; }, 4000);
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
`;

const charProfileJS = `
// ── Character Profile — image assignment ────────────────────────────────
const RENDER_CATS  = ['official-renders','transparent-renders','collection-renders','renders','character-art'];
const FIGURE_CATS  = ['packaging','polaroids','collection-renders'];
const ABILITY_CATS = ['ability-icons','battle-class-icons'];

function taggedImagesFor(lname) {
  const imgs = [];
  for (const g of GO) {
    for (const cat of Object.values(TREE[g] || {})) {
      for (const img of cat) {
        if ((img.skylanders||[]).map(s => s.toLowerCase()).includes(lname)) imgs.push(img);
      }
    }
  }
  return imgs;
}

function imagesByCategory(lname) {
  const byCat = {};
  for (const g of GO) {
    for (const [c, imgs] of Object.entries(TREE[g] || {})) {
      for (const img of imgs) {
        if ((img.skylanders||[]).map(s => s.toLowerCase()).includes(lname)) {
          (byCat[c] ??= []).push(img);
        }
      }
    }
  }
  for (const c of Object.keys(byCat)) {
    byCat[c].sort((a,b) => (b.featured !== false) - (a.featured !== false));
  }
  return byCat;
}

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

let _pickerState = null;

function openImagePicker(lname, target) {
  const sky = SKYLANDERS.find(s => s.name.toLowerCase() === lname);
  if (!sky) return;
  const isMulti = target.field === 'figures' || target.field === 'abilityIcons';
  _pickerState = { lname, sky, target, isMulti, selected: new Set(), imgs: taggedImagesFor(lname) };
  if (isMulti) (sky[target.field] || []).forEach(p => _pickerState.selected.add(p));

  const titles = {
    render: 'Select render',
    figures: 'Select figures',
    abilityIcons: 'Select ability icons',
    variants: target.slot === 'figure' ? 'Select variant figure' : 'Select variant render',
  };
  document.getElementById('img-picker-title').textContent = titles[target.field] || 'Select image';
  document.getElementById('img-picker-done').style.display = isMulti ? '' : 'none';
  document.getElementById('img-picker-search').value = '';
  renderImagePickerGrid('');
  document.getElementById('img-picker-modal').classList.add('open');
}

function renderImagePickerGrid(q) {
  const grid = document.getElementById('img-picker-grid');
  grid.innerHTML = '';
  const lq = q.toLowerCase();
  const matches = _pickerState.imgs.filter(img => !lq || searchMatch(img, lq));
  matches.forEach(img => {
    const item = document.createElement('div'); item.className = 'card prof-picker-item';
    if (_pickerState.isMulti && _pickerState.selected.has(img.path)) item.classList.add('selected');
    item.innerHTML = '<img src="' + ARCHIVE_BASE + img.path + '" loading="lazy" alt="">';
    item.addEventListener('click', () => {
      if (_pickerState.isMulti) {
        if (_pickerState.selected.has(img.path)) _pickerState.selected.delete(img.path);
        else _pickerState.selected.add(img.path);
        item.classList.toggle('selected');
      } else {
        pickImage(img.path);
      }
    });
    grid.appendChild(item);
  });
  if (!matches.length) {
    const empty = document.createElement('div'); empty.id = 'empty';
    empty.style.gridColumn = '1/-1';
    empty.textContent = _pickerState.imgs.length ? 'No images match.' : 'No tagged images yet — tag images with this character first.';
    grid.appendChild(empty);
  }
}

function pickImage(path) {
  const { sky, target } = _pickerState;
  if (target.field === 'variants') {
    const variants = (sky.variants || []).map((v, i) => i === target.variantIdx ? { ...v, [target.slot]: path } : v);
    saveCharField(sky.name, { variants });
  } else {
    saveCharField(sky.name, { [target.field]: path });
  }
  closeImagePicker(false);
}

function closeImagePicker(commit) {
  if (commit && _pickerState && _pickerState.isMulti) {
    saveCharField(_pickerState.sky.name, { [_pickerState.target.field]: [..._pickerState.selected] });
  }
  document.getElementById('img-picker-modal').classList.remove('open');
  _pickerState = null;
}

document.getElementById('img-picker-search').addEventListener('input', e => renderImagePickerGrid(e.target.value));
document.getElementById('img-picker-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeImagePicker(false);
});
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
  --txt:#ddd;--muted:rgba(255,255,255,.6);--gold:#ffcc00;--acc:#4f7aff;--sb:234px;--cp:280px}
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
#layout.has-panel{grid-template-columns:var(--sb) 1fr var(--cp)}
#sb{overflow-y:auto;background:var(--bg2);border-right:1px solid var(--bd);padding:6px 0}
.sb-all{display:flex;align-items:center;justify-content:space-between;
  padding:8px 14px;cursor:pointer;font-size:.72rem;color:var(--muted);
  border-bottom:1px solid var(--bd);margin-bottom:4px;transition:color .12s;gap:6px}
.sb-all:hover,.sb-all.on{color:#fff}
.sb-all.on{color:var(--gold);font-weight:600}
.sb-all .cnt{font-size:.62rem;flex-shrink:0}
.sb-section-hd{padding:10px 14px 4px;font-size:.6rem;text-transform:uppercase;
  letter-spacing:1.5px;color:rgba(255,255,255,.3);font-weight:700}
.sb-section-hd:first-of-type{padding-top:6px}
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
/* "By Character" overview — grid of render thumbnails, model-viewer style */
.sb-char-grid{display:none;flex-wrap:wrap;gap:4px;padding:6px 10px 8px 18px}
.sb-char-grid.open{display:flex}
.sb-char-section-hd{flex:1 0 100%;font-size:.62rem;color:var(--gold);text-transform:uppercase;
  letter-spacing:.5px;opacity:.75;padding:6px 2px 2px;margin-top:2px;
  border-top:1px solid rgba(255,255,255,.06)}
.sb-char-section-hd:first-child{margin-top:0;padding-top:0;border-top:none}
.sb-char-item{width:64px;cursor:pointer;border:2px solid transparent;border-radius:4px;
  padding:2px;text-align:center;box-sizing:border-box;color:var(--muted);
  transition:background .1s,color .12s,border-color .12s}
.sb-char-item:hover{border-color:rgba(255,255,255,.3)}
.sb-char-item.on{border-color:var(--acc);color:var(--acc);background:rgba(79,122,255,.15)}
.sb-char-thumb{width:58px;height:58px;object-fit:cover;background:var(--bg3);
  display:block;border-radius:3px;margin:0 auto}
.sb-char-label{display:block;font-size:.6rem;line-height:1.35;margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sb-char-cnt{display:block;font-size:.55rem;color:rgba(255,255,255,.35)}
.sb-char-item.on .sb-char-cnt{color:rgba(79,122,255,.6)}
#main{overflow-y:auto;padding:14px 18px}
/* Character profile panel ─────────────────────────────────────────────── */
#char-panel{display:none;overflow-y:auto;background:var(--bg2);
  border-left:1px solid var(--bd);padding:14px}
#layout.has-panel #char-panel{display:block}
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
.sec{margin-bottom:26px}
.sec-hd{font-size:.65rem;text-transform:uppercase;letter-spacing:1px;color:var(--gold);
  margin-bottom:8px;padding-bottom:5px;border-bottom:1px solid rgba(255,204,0,.15);
  display:flex;align-items:baseline;gap:7px}
.sec-hd .cnt{color:var(--muted);font-size:.6rem;font-weight:normal;letter-spacing:0;text-transform:none}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:5px}
.card{position:relative;background:rgba(255,255,255,.04);border-radius:5px;overflow:hidden;cursor:pointer;
  border:1px solid var(--bd);transition:transform .12s,border-color .12s,box-shadow .12s}
.card:hover{transform:translateY(-2px);border-color:rgba(255,204,0,.4);box-shadow:0 6px 18px rgba(0,0,0,.5)}
.card img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#1a1a2a}
.foot{padding:3px 6px;font-size:.6rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#empty{padding:60px 20px;text-align:center;color:var(--muted);font-size:.85rem}
/* Per-game dashboard ────────────────────────────────────────────────────── */
.dash-hd{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
.dash-hd h2{font-size:1.5rem;text-transform:uppercase;letter-spacing:1px;color:var(--gold)}
.dash-hd .cnt{font-size:.9rem;color:var(--muted);white-space:nowrap;flex-shrink:0;padding-top:4px}
.dash-tagline{font-size:1rem;color:var(--muted);line-height:1.6;margin-top:6px;max-width:680px}
/* Simple two-column grid — each card is wide enough for a 6-image preview
   and big, easy-to-read title/count text. */
.dash-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
@media (max-width:760px){.dash-grid{grid-template-columns:1fr}}
.dash-card{position:relative;background:rgba(255,255,255,.04);border:1px solid var(--bd);border-radius:8px;
  overflow:hidden;cursor:pointer;transition:transform .12s,border-color .12s,box-shadow .12s}
.dash-card:hover{transform:translateY(-2px);border-color:rgba(255,204,0,.4);box-shadow:0 6px 18px rgba(0,0,0,.5)}
.dash-card-preview{display:grid;gap:3px;background:#1a1a2a}
.dash-card-preview img{width:100%;aspect-ratio:1;object-fit:cover;display:block;background:#1a1a2a}
.dash-card-body{padding:14px 18px}
.dash-card-body .dash-card-title{font-size:1.25rem;color:#fff;letter-spacing:.3px}
.dash-card-body .cnt{font-size:.9rem;color:var(--muted);margin-top:4px;display:block}
/* Link & text dashboard blocks (added via the dashboard builder) ────────── */
.dash-card-link,.dash-card-text{display:flex;flex-direction:column;justify-content:center;
  min-height:160px;padding:20px;background:rgba(79,122,255,.08);border-color:rgba(79,122,255,.3)}
.dash-card-link:hover{background:rgba(79,122,255,.15);border-color:rgba(79,122,255,.55)}
.dash-card-link-icon{font-size:2.4rem;margin-bottom:10px}
.dash-card-link .dash-card-title,.dash-card-text-title{font-size:1.25rem;color:#fff;letter-spacing:.3px;
  display:block;margin-bottom:6px}
.dash-card-desc,.dash-card-text-body{font-size:.95rem;color:var(--muted);line-height:1.6;display:block}
.dash-card-text{cursor:default;background:rgba(255,255,255,.03)}
.dash-card-text:hover{transform:none;border-color:var(--bd);box-shadow:none}
/* Dashboard builder ───────────────────────────────────────────────────────── */
.dash-builder-bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
.dash-builder-bar button{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;padding:7px 14px;font-size:.85rem;font-family:inherit;cursor:pointer;transition:all .12s}
.dash-builder-bar button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.dash-builder-bar button.dash-builder-save{border-color:rgba(80,220,100,.4);color:#5fdc6f}
.dash-builder-bar button.dash-builder-save:hover{background:rgba(80,220,100,.12)}
.dash-block-controls{position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:2}
.dash-block-controls button{background:rgba(14,14,28,.8);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;width:28px;height:28px;line-height:1;font-size:.85rem;cursor:pointer;
  display:flex;align-items:center;justify-content:center;font-family:inherit}
.dash-block-controls button:hover{border-color:rgba(255,204,0,.5);color:var(--gold)}
.dash-hidden-tray{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px;
  padding:10px 12px;border:1px dashed var(--bd);border-radius:6px;font-size:.85rem;color:var(--muted)}
.dash-hidden-tray .dash-hidden-label{text-transform:uppercase;letter-spacing:1px;font-size:.8rem}
.dash-hidden-chip{background:rgba(255,255,255,.05);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;padding:5px 10px;font-size:.85rem;font-family:inherit;cursor:pointer}
.dash-hidden-chip:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.dash-add-form{margin-top:16px;padding:16px 18px;border:1px solid var(--bd);border-radius:6px;
  background:rgba(255,255,255,.03);max-width:460px}
.dash-add-form h4{font-size:.9rem;color:var(--gold);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px}
.dash-add-form label{display:block;font-size:.85rem;color:var(--muted);margin-bottom:10px}
.dash-add-form input,.dash-add-form select,.dash-add-form textarea{display:block;width:100%;margin-top:4px;
  padding:7px 10px;border-radius:4px;border:1px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.07);color:#fff;font-size:.9rem;font-family:inherit;box-sizing:border-box}
.dash-add-form textarea{resize:vertical}
.dash-add-form-actions{display:flex;gap:8px;margin-top:6px}
.dash-add-form-actions button{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;padding:7px 14px;font-size:.85rem;font-family:inherit;cursor:pointer}
.dash-add-form-actions button:first-child{border-color:rgba(80,220,100,.4);color:#5fdc6f}
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
.prof-gallery{margin-bottom:10px}
.prof-gallery-item{cursor:default}
.prof-gallery-item:hover{transform:none;box-shadow:none;border-color:var(--bd)}
.prof-gallery-rm{position:absolute;top:4px;right:4px;background:rgba(0,0,0,.65);color:#fff;
  border:none;width:24px;height:24px;line-height:24px;border-radius:4px;font-size:.9rem;
  cursor:pointer;font-family:inherit;padding:0}
.prof-gallery-rm:hover{background:rgba(255,80,80,.85)}
.prof-variants{display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.prof-variant{display:flex;align-items:center;gap:14px;padding:10px 14px;
  background:rgba(255,255,255,.03);border:1px solid var(--bd);border-radius:8px}
.prof-variant-name{font-size:1rem;color:#fff;flex:1;min-width:0}
.prof-variant-thumbs{display:flex;gap:10px}
.prof-variant-thumb{width:90px;text-align:center}
.prof-variant-thumb img{width:90px;height:90px;object-fit:contain;background:rgba(255,255,255,.04);
  border:1px solid var(--bd);border-radius:6px;display:block;margin-bottom:4px}
.prof-variant-thumb-empty{width:90px;height:90px;display:flex;align-items:center;justify-content:center;
  background:rgba(255,255,255,.04);border:1px dashed var(--bd);border-radius:6px;
  color:var(--muted);font-size:.7rem;margin-bottom:4px;box-sizing:border-box;text-align:center}
.prof-variant-thumb button{width:100%;background:rgba(255,255,255,.06);color:var(--txt);
  border:1px solid var(--bd);border-radius:4px;padding:4px 0;font-size:.75rem;
  font-family:inherit;cursor:pointer}
.prof-variant-thumb button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.prof-add-variant{display:flex;gap:8px}
.prof-add-variant input{flex:1;max-width:280px;background:rgba(255,255,255,.07);
  border:1px solid rgba(255,255,255,.18);color:#fff;padding:7px 10px;border-radius:4px;
  font-size:.85rem;font-family:inherit}
.prof-add-variant input:focus{outline:none;border-color:var(--acc)}
.prof-add-variant button{background:rgba(255,255,255,.06);color:var(--txt);border:1px solid var(--bd);
  border-radius:4px;padding:7px 14px;font-size:.85rem;font-family:inherit;cursor:pointer}
.prof-add-variant button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
/* Profile model viewer */
.prof-mv-wrap{margin-bottom:16px}
.prof-mv-canvas-wrap{width:100%;aspect-ratio:1/1;background:var(--bg3);
  border-radius:6px;overflow:hidden;border:1px solid var(--bd)}
.prof-mv-variants{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
.prof-mv-variant{background:rgba(255,255,255,.06);border:1px solid var(--bd);
  color:var(--muted);font-size:.72rem;padding:3px 8px;border-radius:4px;cursor:pointer}
.prof-mv-variant.on{border-color:var(--acc);color:var(--acc);background:rgba(79,122,255,.15)}
.prof-mv-actions{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.prof-mv-actions button{background:rgba(255,255,255,.06);color:var(--txt);
  border:1px solid var(--bd);font-size:.8rem;padding:4px 10px;border-radius:4px;cursor:pointer}
.prof-mv-actions button:hover{border-color:rgba(255,204,0,.4);color:var(--gold)}
.prof-mv-card-btn{border-color:rgba(255,204,0,.4)!important;color:var(--gold)!important}
.prof-mv-card-btn:hover{background:rgba(255,204,0,.1)!important}
.prof-mv-bone-ui{margin-top:8px;font-size:.75rem;color:var(--muted)}
.prof-mv-bone-ui select{background:var(--bg3);border:1px solid var(--bd);
  color:var(--txt);border-radius:3px;padding:2px 4px;width:100%;margin-bottom:5px}
.prof-mv-bone-ui .bone-row{display:flex;align-items:center;gap:5px;margin-bottom:3px}
.prof-mv-bone-ui .bone-row label{width:12px;color:var(--muted);font-size:.7rem}
.prof-mv-bone-ui .bone-row input[type=range]{flex:1}
.prof-mv-bone-ui .bone-row span{width:28px;text-align:right;font-size:.7rem}
.prof-mv-empty{color:var(--muted);font-size:.85rem;padding:12px 0}
/* Pose detail view (full-page bone posing) ──────────────────────────────── */
#pose-detail-root{display:none;height:100%;min-height:0;flex-direction:column}
.pose-detail-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 14px;
  border-bottom:1px solid var(--bd);background:var(--bg2)}
.pose-detail-back{flex-shrink:0;padding:4px 10px;background:rgba(255,204,0,.07);
  border:1.5px solid rgba(255,204,0,.22);color:var(--muted);border-radius:4px;cursor:pointer;
  font-size:.72rem;font-family:inherit;transition:all .12s}
.pose-detail-back:hover{background:rgba(255,204,0,.17);border-color:rgba(255,204,0,.5);color:var(--gold)}
.pose-detail-body{flex:1;display:flex;min-height:0}
.pose-detail-canvas-host{flex:1;min-width:0;background:var(--bg3)}
.pose-detail-canvas-host .prof-mv-canvas-wrap{width:100%;height:100%;aspect-ratio:auto;border-radius:0;border:none}
.pose-detail-side{flex-shrink:0;width:260px;border-left:1px solid var(--bd);
  background:var(--bg2);padding:14px;overflow-y:auto;box-sizing:border-box}
.pose-detail-side .prof-mv-variants{margin-bottom:14px}
.pose-detail-side .prof-mv-actions{flex-direction:column}
.pose-detail-side .prof-mv-actions button{width:100%}
/* Image picker modal ────────────────────────────────────────────────────── */
#img-picker-modal{display:none;position:fixed;inset:0;z-index:120;background:rgba(0,0,0,.85);
  align-items:center;justify-content:center}
#img-picker-modal.open{display:flex}
#img-picker-box{background:rgba(14,14,28,.98);border:1px solid rgba(255,204,0,.3);
  border-radius:8px;padding:18px 20px;width:640px;max-width:92vw;max-height:88vh;
  display:flex;flex-direction:column}
#img-picker-box h2{font-size:1rem;color:var(--gold);margin:0 0 12px;letter-spacing:.5px}
#img-picker-search{width:100%;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);
  color:#fff;padding:7px 10px;border-radius:4px;font-size:.85rem;font-family:inherit;
  margin-bottom:12px;box-sizing:border-box}
#img-picker-search:focus{outline:none;border-color:var(--acc)}
#img-picker-search::placeholder{color:var(--muted)}
#img-picker-grid{overflow-y:auto;flex:1;margin-bottom:12px;min-height:120px}
.prof-picker-item img{opacity:.85}
.prof-picker-item:hover img{opacity:1}
.prof-picker-item.selected{border-color:var(--acc);box-shadow:0 0 0 2px rgba(79,122,255,.4)}
/* Embedded 3D model viewer ──────────────────────────────────────────────── */
#mv-root{display:none;height:100%;min-height:0}
.mv-list-panel,.mv-tex-panel{flex-shrink:0;display:flex;flex-direction:column;background:var(--bg2);min-height:0}
.mv-list-panel{width:260px;border-right:1px solid var(--bd)}
.mv-tex-panel{width:240px;border-left:1px solid var(--bd)}
.mv-search{margin:8px;padding:5px 9px;border-radius:4px;border:1px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.07);color:#fff;font-size:.72rem;font-family:inherit}
.mv-search::placeholder{color:var(--muted)}
.mv-search:focus{outline:none;border-color:rgba(255,204,0,.5)}
.mv-list{flex:1;overflow-y:auto;padding:4px;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start}
.mv-item{width:74px;cursor:pointer;border:2px solid transparent;border-radius:4px;
  padding:2px;text-align:center;box-sizing:border-box;color:var(--muted)}
.mv-item:hover{border-color:rgba(255,255,255,.3)}
.mv-item.active{border-color:var(--acc);color:var(--acc)}
.mv-item-thumb{width:70px;height:70px;object-fit:cover;background:var(--bg3);display:block;border-radius:3px}
.mv-id{display:block;font-weight:700;color:var(--gold);font-size:.55rem;margin-top:2px}
.mv-item-label{display:block;font-size:.55rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mv-viewport-panel{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.mv-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:8px 14px;
  border-bottom:1px solid var(--bd);background:var(--bg2)}
.mv-back{flex-shrink:0;padding:4px 10px;background:rgba(255,204,0,.07);border:1.5px solid rgba(255,204,0,.22);
  color:var(--muted);border-radius:4px;cursor:pointer;font-size:.72rem;font-family:inherit;transition:all .12s}
.mv-back:hover{background:rgba(255,204,0,.17);border-color:rgba(255,204,0,.5);color:var(--gold)}
.mv-toolbar-title{font-size:.7rem;text-transform:uppercase;letter-spacing:1px;color:var(--gold)}
#mv-viewport{flex:1;position:relative;min-width:0;min-height:0;background:var(--bg3)}
#mv-viewport canvas{display:block}
.mv-info{position:absolute;top:8px;left:8px;color:var(--txt);background:rgba(14,14,28,.8);
  border:1px solid var(--bd);padding:8px 10px;border-radius:6px;font-size:.7rem;line-height:1.5;max-width:420px}
.mv-controls{position:absolute;top:8px;right:8px;color:var(--txt);background:rgba(14,14,28,.8);
  border:1px solid var(--bd);padding:8px 10px;border-radius:6px;font-size:.7rem;line-height:1.6;
  max-width:260px;box-sizing:border-box}
.mv-controls label{display:block;cursor:pointer}
.mv-controls hr{border-color:var(--bd);margin:6px 0}
.mv-controls select{max-width:160px;background:rgba(255,255,255,.07);color:#fff;
  border:1px solid rgba(255,255,255,.18);border-radius:3px}
.mv-controls select option{background:#1a1a2a;color:#fff}
.mv-controls input[type=range]{vertical-align:middle;width:110px}
.mv-controls button{margin-top:2px;background:rgba(255,255,255,.07);color:var(--txt);
  border:1px solid rgba(255,255,255,.18);border-radius:3px;cursor:pointer;font-family:inherit}
.mv-hint{color:var(--muted);font-size:.62rem;margin:4px 0;line-height:1.5}
.mv-tex-header{padding:4px 8px;font-size:.68rem;color:var(--muted)}
.mv-override-bar{padding:4px 8px;border-bottom:1px solid var(--bd);display:flex;flex-wrap:wrap;gap:4px}
.mv-override-bar button{background:rgba(255,255,255,.07);color:var(--txt);border:1px solid rgba(255,255,255,.18);
  border-radius:3px;cursor:pointer;font-family:inherit;font-size:.6rem;padding:3px 6px}
.mv-override-bar button:hover:not(:disabled){border-color:rgba(255,204,0,.5);color:var(--gold)}
.mv-override-bar button:disabled{opacity:.35;cursor:default}
.mv-override-status{width:100%;font-size:.58rem;color:var(--muted);line-height:1.5}
.mv-tex-grid{flex:1;overflow-y:auto;padding:4px;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start}
.mv-tex-item{width:64px;cursor:pointer;border:2px solid transparent;border-radius:4px;
  padding:2px;text-align:center;box-sizing:border-box}
.mv-tex-item:hover{border-color:rgba(255,255,255,.3)}
.mv-tex-item.active{border-color:var(--acc)}
.mv-tex-item img{width:60px;height:60px;object-fit:contain;background:var(--bg3);display:block}
.mv-tex-id{font-size:.55rem;color:var(--gold);font-weight:700;margin-top:2px}
.mv-tex-name{font-size:.55rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#lb{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.92);
  align-items:center;justify-content:center;flex-direction:column;gap:10px;
  overflow-y:auto;padding:16px 0}
#lb.open{display:flex}
#lb-img{max-width:88vw;max-height:76vh;object-fit:contain;border-radius:6px;flex-shrink:0}
#lb.editing #lb-img{max-height:40vh}
#lb-meta{text-align:center;font-size:.76rem;color:var(--muted);line-height:1.8;max-width:600px}
#lb-meta a{color:#99ccff}
.lb-id{font-weight:700;color:var(--gold);font-size:.65rem;letter-spacing:.5px}
.lb-x{position:fixed;top:12px;right:16px;font-size:1.4rem;cursor:pointer;color:var(--muted)}
.lb-x:hover{color:#fff}
.lb-row{display:flex;align-items:center;gap:8px}
.lb-btn{background:rgba(255,204,0,.1);border:1px solid rgba(255,204,0,.3);color:var(--gold);
  padding:5px 14px;border-radius:5px;cursor:pointer;font-size:.75rem;font-family:inherit;text-decoration:none}
.lb-btn:hover{background:rgba(255,204,0,.22)}
.lb-btn.danger{background:rgba(255,80,80,.1);border-color:rgba(255,80,80,.35);color:#ff8888}
.lb-btn.danger:hover{background:rgba(255,80,80,.22)}
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
/* ── Add Image modal ──────────────────────────────────────────────────────── */
#add-image-btn{flex-shrink:0;padding:4px 10px;background:rgba(255,204,0,.07);
  border:1.5px solid rgba(255,204,0,.22);color:var(--muted);border-radius:4px;
  cursor:pointer;font-size:.72rem;font-family:inherit;transition:all .12s;white-space:nowrap}
#add-image-btn:hover{background:rgba(255,204,0,.17);border-color:rgba(255,204,0,.5);color:var(--gold)}
#publish-btn{flex-shrink:0;padding:4px 10px;background:rgba(80,220,100,.08);
  border:1.5px solid rgba(80,220,100,.25);color:var(--muted);border-radius:4px;
  cursor:pointer;font-size:.72rem;font-family:inherit;transition:all .12s;white-space:nowrap}
#publish-btn:hover{background:rgba(80,220,100,.18);border-color:rgba(80,220,100,.5);color:#5fdc6f}
#publish-btn:disabled{opacity:.5;cursor:default}
#publish-status{flex-shrink:0;font-size:.68rem;color:var(--muted);white-space:nowrap}
#publish-status.ok{color:#66ee88}
#publish-status.err{color:#ff7766}
#add-modal{display:none;position:fixed;inset:0;z-index:110;background:rgba(0,0,0,.85);
  align-items:center;justify-content:center}
#add-modal.open{display:flex}
#add-modal-box{background:rgba(14,14,28,.98);border:1px solid rgba(255,204,0,.3);
  border-radius:8px;padding:18px 20px;width:440px;max-width:92vw;max-height:88vh;overflow-y:auto}
#add-modal-box h2{font-size:.9rem;color:var(--gold);margin:0 0 12px;letter-spacing:.5px}
#add-drop{border:2px dashed rgba(255,255,255,.18);border-radius:6px;padding:24px 12px;
  text-align:center;font-size:.78rem;color:var(--muted);cursor:pointer;margin-bottom:12px;
  transition:all .12s}
#add-drop:hover,#add-drop.dragover{border-color:var(--gold);color:#fff;background:rgba(255,204,0,.05)}
#add-preview{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
#add-preview:empty{display:none}
.add-thumb{position:relative;width:64px;height:64px;border-radius:4px;overflow:hidden;
  border:1px solid rgba(255,255,255,.15)}
.add-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.add-thumb-rm{position:absolute;top:0;right:0;background:rgba(0,0,0,.6);color:#fff;
  border:none;width:18px;height:18px;line-height:18px;font-size:.7rem;cursor:pointer}
.add-thumb-rm:hover{background:rgba(255,80,80,.8)}
#add-status{font-size:.68rem;color:var(--muted);flex:1}
#add-status.ok{color:#66ee88}
#add-status.err{color:#ff7766}
/* ── About overlay ───────────────────────────────────────────────────────── */
#about-btn{flex-shrink:0;padding:4px 10px;background:rgba(255,255,255,.05);
  border:1.5px solid rgba(255,255,255,.15);color:var(--muted);border-radius:4px;
  cursor:pointer;font-size:.72rem;font-family:inherit;transition:all .12s;white-space:nowrap}
#about-btn:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.3);color:#fff}
#about-modal{display:none;position:fixed;inset:0;z-index:110;background:rgba(0,0,0,.85);
  align-items:center;justify-content:center}
#about-modal.open{display:flex}
#about-modal-box{background:rgba(14,14,28,.98);border:1px solid var(--bd);
  border-radius:8px;padding:22px 26px;width:520px;max-width:92vw;max-height:84vh;overflow-y:auto}
#about-modal-box h2{font-size:1rem;color:var(--gold);margin:0 0 14px;letter-spacing:.5px}
#about-modal-box h3{font-size:.78rem;color:#fff;margin:16px 0 6px;letter-spacing:.3px}
#about-modal-box p{font-size:.78rem;color:var(--txt);line-height:1.65;margin-bottom:8px}
#about-modal-box p:last-child{margin-bottom:0}
.about-close{margin-top:18px}
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
.tag-chip.variant{font-size:.6rem;padding:2px 8px;font-weight:600;opacity:.8}
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
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.160.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.160.0/examples/jsm/",
    "fflate": "https://unpkg.com/fflate@0.8.2/esm/browser.js"
  }
}
</script>
</head>
<body>
<div id="hdr">
  <h1>Skylanders Archive</h1>
  <button id="about-btn" onclick="openAboutModal()">About</button>
  <input id="q" type="search" placeholder="Search…" autocomplete="off">${tagModeBtnHTML}${addImageBtnHTML}${publishBtnHTML}
</div>${tagBarHTML}
${aboutModalHTML}
<div id="layout">
  <aside id="sb"></aside>
  <main id="main"></main>
  <div id="mv-root">
    <aside class="mv-list-panel">
      <input id="mv-search" class="mv-search" type="text" placeholder="${escHtml(VOCAB.modelViewer?.searchModelsLabel)}">
      <div id="mv-list" class="mv-list"></div>
    </aside>
    <div class="mv-viewport-panel">
      <div class="mv-toolbar">
        <button class="mv-back" type="button">&#8249; ${escHtml(VOCAB.modelViewer?.backButton)}</button>
        <span class="mv-toolbar-title">3D Model Archive</span>
      </div>
      <div id="mv-viewport">
        <div id="mv-info" class="mv-info">${escHtml(VOCAB.modelViewer?.selectPrompt)}</div>
        <div id="mv-controls" class="mv-controls">
          <label><input type="radio" name="mv-shading" value="normal" checked> Shade by normal</label>
          <label><input type="radio" name="mv-shading" value="gray"> Lit gray</label>
          <label><input type="radio" name="mv-shading" value="texture"> Textured (UV)</label>
          <hr>
          <label><input type="checkbox" id="mv-wireframe"> Wireframe</label>
          <hr>
          <label><input type="checkbox" id="mv-show-grid" checked> Grid / axes</label>
          <div id="mv-repr-controls" style="display:none">
            <hr>
            <label><input type="radio" name="mv-repr" value="json" checked> Rigged (.json, skeleton + skin)</label>
            <label><input type="radio" name="mv-repr" value="obj"> Static mesh (.obj)</label>
          </div>
          <div id="mv-skeleton-controls" style="display:none">
            <hr>
            <label><input type="checkbox" id="mv-show-skeleton" checked> Show skeleton</label>
            <div class="mv-hint">${escHtml(VOCAB.modelViewer?.skeletonHint)}</div>
            <div id="mv-pose-controls">
              <label>Bone: <select id="mv-bone-select"></select></label>
              <label>X: <input type="range" id="mv-bone-rot-x" min="-180" max="180" value="0" step="1"> <span id="mv-bone-rot-x-val">0</span>&deg;</label>
              <label>Y: <input type="range" id="mv-bone-rot-y" min="-180" max="180" value="0" step="1"> <span id="mv-bone-rot-y-val">0</span>&deg;</label>
              <label>Z: <input type="range" id="mv-bone-rot-z" min="-180" max="180" value="0" step="1"> <span id="mv-bone-rot-z-val">0</span>&deg;</label>
              <label><button id="mv-reset-pose" type="button">Reset pose</button></label>
            </div>
          </div>
          <hr>
          <label><button id="mv-download-btn" type="button" disabled>Download model files (.zip)</button></label>
          <div class="mv-hint">${escHtml(VOCAB.modelViewer?.downloadHint)}</div>
        </div>
      </div>
    </div>
    <aside class="mv-tex-panel">
      <input id="mv-tex-search" class="mv-search" type="text" placeholder="${escHtml(VOCAB.modelViewer?.searchTexturesLabel)}">
      <div id="mv-tex-header" class="mv-tex-header">${escHtml(VOCAB.modelViewer?.textureHint)}</div>
      <div id="mv-tex-grid" class="mv-tex-grid"></div>
    </aside>
  </div>
  <div id="pose-detail-root"></div>
  <aside id="char-panel"></aside>
</div>
${addModalHTML}
${imagePickerModalHTML}

<div id="lb">
  <div class="lb-x" onclick="closeLb()">✕</div>
  <img id="lb-img" src="" alt="">
  <div id="lb-meta"></div>
  <div class="lb-row">
    <button class="lb-arr" onclick="stepLb(-1)">&#8249;</button>
    <a id="lb-dl"  class="lb-btn" download>&#8595; Save</a>
    <a id="lb-src" class="lb-btn" target="_blank">&#8599; Source</a>
    <button class="lb-arr" onclick="stepLb(1)">&#8250;</button>${editBtnHTML}
  </div>${editPanelHTML}
</div>

<script type="module" src="/server/skylanders/models/model-viewer.js"></script>
<script type="module" src="/server/skylanders/models/profile-model-viewer.js"></script>
<script>
const ARCHIVE_BASE = '__ARCHIVE_BASE__';
// When true, every editing affordance below is gated off — the live site has
// no curation server to save to, so this build is sort/filter/view only.
// (Always false here; the --publish website copy below flips this to true
// via string replacement after the editing UI blocks are stripped out.)
const PUBLISH    = false;
const TREE       = ${JSON.stringify(tree)};
const GAME_LBL   = ${JSON.stringify(gameMap)};
const GO         = ${JSON.stringify(gameOrder)};
const CAT_LBL    = c => c.replace(/-/g,' ').replace(/\\b\\w/g, l => l.toUpperCase());
const SKYLANDERS = ${JSON.stringify(SKYLANDERS_LIST)};
const VARIANTS   = ${JSON.stringify(VARIANT_TO_BASE)}; // variant name -> base character name
// Preferred categories for the "By Character" sidebar thumbnail when a
// character has no assigned profile render — same idea as RENDER_CATS but
// usable outside the curation-only charProfileJS block (published too).
const CHAR_THUMB_CATS = ['official-renders','transparent-renders','collection-renders','renders','character-art'];
const VOCAB      = ${JSON.stringify(VOCAB)}; // flavour/copy text — edit in src/_data/archive-vocab.json
const DASHBOARD_LAYOUT = ${JSON.stringify(DASHBOARD_LAYOUT)}; // per-game dashboard builder layout
const DASHBOARD_API    = 'http://localhost:7373/api/dashboard-layout';
// The embedded model viewer module loads after this script and reads its
// own copy text from here. It also reads these two globals to decide
// whether to show the icon/texture override controls (curation-only —
// --publish flips PUBLISH to true above, which hides them).
window.ARCHIVE_VOCAB = VOCAB.modelViewer || {};
window.SKYLANDER_PUBLISH = PUBLISH;
window.SKYLANDER_MODEL_API = 'http://localhost:7373/api/update-model';
const EL_COL = {
  fire:'#C83200',water:'#0055AA',earth:'#8F5A10',wind:'#005588',
  magic:'#9900CC',nature:'#2C7200',undead:'#4444AA',tech:'#9A7000',
};
const ELEMENTS = ['fire','water','earth','wind','magic','nature','undead','tech','light','dark'];
const escAttr = s => String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
// The six mainline console entries, grouped in the sidebar under
// VOCAB.sidebar.mainlineGroup — everything else in GO (spin-offs, apps,
// misc) falls under VOCAB.sidebar.spinoffGroup.
const MAINLINE_GAMES = new Set(['spyros-adventure','giants','swap-force','trap-team','superchargers','imaginators']);

let sel     = {game: null, cat: null, char: null};
let lastPanelChar = null; // tracks which character the #char-panel form was built for
let annFilter = null; // null | 'background' | 'detail' — cross-cutting annotation filter
// Per-game category lists start collapsed; clicking a game's title expands
// it (and shows its dashboard). Keeps the sidebar short with ~10 games.
const expanded = new Set();
let charExpanded = false; // "By Character" sidebar section
let lbImgs  = [], lbIdx = 0;
let query   = '';
// Declared here (not inside tagModeJS) because makeCard/render reference it
// unconditionally — in --publish builds it just stays false forever.
let tagModeOn = false;
// Embedded 3D model archive view (Lost Islands dashboard hero card)
let mvActive = false;
let poseDetailChar = null;     // Skylander name, or null — full-page bone-posing detail view
let lastPoseDetailChar = null; // tracks which character renderPoseDetail last built for (distinct from lastPanelChar)
// Dashboard builder — per-game edit-mode flag and working-copy layout draft
let dashEditMode = {};
let dashDraft    = {};

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
  allEl.className = 'sb-all' + (sel.game === null && sel.cat === null && !sel.char && !annFilter ? ' on' : '');
  allEl.innerHTML = '<span>All Images</span><span class="cnt">${total}</span>';
  allEl.addEventListener('click', () => { sel = {game:null, cat:null, char:null}; annFilter = null; mvActive = false; render(); });
  sb.appendChild(allEl);

  for (const [ann, label] of [['background', 'Backgrounds'], ['detail', 'Details']]) {
    const cnt = annCount(ann);
    if (cnt === 0 && query) continue;
    const annEl = document.createElement('div');
    annEl.className = 'sb-all sb-ann' + (annFilter === ann ? ' on' : '');
    annEl.innerHTML = '<span>' + label + '</span><span class="cnt">' + cnt + '</span>';
    annEl.addEventListener('click', () => {
      annFilter = (annFilter === ann ? null : ann);
      sel = {game: null, cat: null, char: null};
      mvActive = false;
      render();
    });
    sb.appendChild(annEl);
  }

  // ── By Character ────────────────────────────────────────────────────────
  // Cross-cutting view: every image tagged with a given Skylander, regardless
  // of which game/category it lives in — split into Featured / Not Featured
  // so curate-archive's picks can be reviewed and corrected per-character.
  {
    // Tags aren't always lowercased at the source (add-to-archive's --skylanders
    // arg, older manual edits) — normalize on lowercase so e.g. "Bash" and "bash"
    // count as one character and the sel.char filter (which also lowercases
    // img.skylanders) actually matches.
    const charCounts = {};
    const charThumbs = {}; // lname -> { cat, featured, any } candidate image paths
    const charGameCounts = {}; // lname -> { game: count } — used to pick a "home" game
    for (const g of GO) for (const [c, imgs] of Object.entries(TREE[g] ?? {}))
      for (const img of imgs) for (const s of (img.skylanders||[])) {
        const lname = s.toLowerCase();
        charCounts[lname] = (charCounts[lname]||0) + 1;
        const t = (charThumbs[lname] ??= {});
        if (!t.any) t.any = img.path;
        if (img.featured !== false) {
          if (!t.featured) t.featured = img.path;
          if (!t.cat && CHAR_THUMB_CATS.includes(c)) t.cat = img.path;
        }
        const gc = (charGameCounts[lname] ??= {});
        gc[g] = (gc[g]||0) + 1;
      }

    const dispName = lname => (SKYLANDERS.find(s => s.name.toLowerCase() === lname)?.name)
      || lname.replace(/\\b\\w/g, c => c.toUpperCase());
    const charNames = Object.keys(charCounts).sort((a,b) => dispName(a).localeCompare(dispName(b)));

    // Group each character under whichever game has the most tagged images
    // for them — their "home" game in the archive — so the grid reads like
    // a per-game roster instead of one long alphabetical list.
    const byGame = {};
    for (const lname of charNames) {
      const gc = charGameCounts[lname] || {};
      let bestG = GO[0], bestN = -1;
      for (const g of GO) {
        const n = gc[g] || 0;
        if (n > bestN) { bestN = n; bestG = g; }
      }
      (byGame[bestG] ??= []).push(lname);
    }

    const wrap = document.createElement('div'); wrap.className = 'sb-game';
    const ttl = document.createElement('div');
    ttl.className = 'sb-ttl' + (charExpanded ? ' open' : '') + (sel.char ? ' on' : '');
    ttl.innerHTML = '<span class="sb-arrow">&#9654;</span>'
      + '<span class="sb-gname">By Character</span>'
      + '<span class="sb-gcnt">' + charNames.length + '</span>';
    ttl.addEventListener('click', () => { charExpanded = !charExpanded; render(); });
    wrap.appendChild(ttl);

    const charsEl = document.createElement('div');
    charsEl.className = 'sb-char-grid' + (charExpanded ? ' open' : '');
    for (const g of GO) {
      const names = byGame[g];
      if (!names || !names.length) continue;

      const hd = document.createElement('div'); hd.className = 'sb-char-section-hd';
      hd.textContent = GAME_LBL[g] ?? g;
      charsEl.appendChild(hd);

      for (const lname of names) {
        const sky = SKYLANDERS.find(s => s.name.toLowerCase() === lname);
        const thumbs = charThumbs[lname] || {};
        const thumb = sky?.render || thumbs.cat || thumbs.featured || thumbs.any || null;

        const el = document.createElement('div');
        el.className = 'sb-char-item' + (sel.char === lname ? ' on' : '');
        el.innerHTML = (thumb
            ? '<img class="sb-char-thumb" src="' + ARCHIVE_BASE + thumb + '" loading="lazy" alt="">'
            : '<div class="sb-char-thumb"></div>')
          + '<span class="sb-char-label">' + dispName(lname) + '</span>'
          + '<span class="sb-char-cnt">' + charCounts[lname] + '</span>';
        el.addEventListener('click', e => {
          e.stopPropagation();
          sel = {game: null, cat: null, char: lname};
          annFilter = null;
          charExpanded = true;
          mvActive = false;
          render();
        });
        charsEl.appendChild(el);
      }
    }
    wrap.appendChild(charsEl);
    sb.appendChild(wrap);
  }

  const q = query;
  // Group the per-game sections so the sidebar reads as "the six mainline
  // console games" vs "everything else" instead of one long flat list.
  let sawMainline = false, sawSpinoff = false;
  for (const g of GO) {
    const gTotal = catsSorted(g).reduce((s,[,imgs]) => {
      return s + (q ? imgs.filter(i => searchMatch(i,q)).length : imgs.length);
    }, 0);
    if (gTotal === 0 && q) continue;

    if (MAINLINE_GAMES.has(g)) {
      if (!sawMainline) {
        const hd = document.createElement('div'); hd.className = 'sb-section-hd';
        hd.textContent = VOCAB.sidebar?.mainlineGroup || '';
        sb.appendChild(hd);
        sawMainline = true;
      }
    } else if (!sawSpinoff) {
      const hd = document.createElement('div'); hd.className = 'sb-section-hd';
      hd.textContent = VOCAB.sidebar?.spinoffGroup || '';
      sb.appendChild(hd);
      sawSpinoff = true;
    }

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
        sel = {game: g, cat: null, char: null};
        annFilter = null;
      }
      mvActive = false;
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
        sel = {game: g, cat: c, char: null};
        annFilter = null;
        expanded.add(g);
        mvActive = false;
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
  card.innerHTML = '<img src="' + ARCHIVE_BASE + img.path + '" loading="lazy" alt="" title="' + (img.id||'') + '">'
    + buildSkyStrip(img.skylanders || [])
    + '<div class="foot">' + label + '</div>';
  card.addEventListener('click', e => {
    if (tagModeOn) { handleTagClick(e, card, idx); return; }
    openLb(idx);
  });
  return card;
}

// ── Character Profile ───────────────────────────────────────────────────
function profBtn(label, onclick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', onclick);
  return b;
}

function profGallery(lname, sky, field, label) {
  const items = sky[field] || [];
  const sec = document.createElement('div'); sec.className = 'prof-section';

  const hd = document.createElement('div'); hd.className = 'prof-section-hd';
  hd.innerHTML = label + ' <span class="cnt">' + items.length + '</span>';
  sec.appendChild(hd);

  if (items.length) {
    const grid = document.createElement('div'); grid.className = 'grid prof-gallery';
    items.forEach(p => {
      const item = document.createElement('div'); item.className = 'card prof-gallery-item';
      item.innerHTML = '<img src="' + ARCHIVE_BASE + p + '" loading="lazy" alt="">';
      if (!PUBLISH) {
        const rm = profBtn('\\u00d7', () => {
          saveCharField(sky.name, { [field]: items.filter(x => x !== p) });
        }, 'prof-gallery-rm');
        rm.title = 'Remove';
        item.appendChild(rm);
      }
      grid.appendChild(item);
    });
    sec.appendChild(grid);
  } else {
    const empty = document.createElement('div'); empty.className = 'prof-empty';
    empty.textContent = 'None assigned yet.';
    sec.appendChild(empty);
  }

  if (!PUBLISH) {
    const actions = document.createElement('div'); actions.className = 'prof-actions';
    actions.appendChild(profBtn('+ Add', () => openImagePicker(lname, { field })));
    actions.appendChild(profBtn('Auto-fill', () => autoFillCharField(sky, field)));
    sec.appendChild(actions);
  }
  return sec;
}

function profVariants(lname, sky) {
  const variants = sky.variants || [];
  const sec = document.createElement('div'); sec.className = 'prof-section';

  const hd = document.createElement('div'); hd.className = 'prof-section-hd';
  hd.innerHTML = 'Variants <span class="cnt">' + variants.length + '</span>';
  sec.appendChild(hd);

  if (variants.length) {
    const list = document.createElement('div'); list.className = 'prof-variants';
    variants.forEach((v, vi) => {
      const row = document.createElement('div'); row.className = 'prof-variant';

      const nameEl = document.createElement('div'); nameEl.className = 'prof-variant-name';
      nameEl.textContent = v.name;
      row.appendChild(nameEl);

      const thumbs = document.createElement('div'); thumbs.className = 'prof-variant-thumbs';
      [['render','Render'], ['figure','Figure']].forEach(([slot, slotLabel]) => {
        const box = document.createElement('div'); box.className = 'prof-variant-thumb';
        if (v[slot]) {
          box.innerHTML = '<img src="' + ARCHIVE_BASE + v[slot] + '" loading="lazy" alt="">';
        } else {
          const ph = document.createElement('div'); ph.className = 'prof-variant-thumb-empty';
          ph.textContent = 'No ' + slotLabel.toLowerCase();
          box.appendChild(ph);
        }
        if (!PUBLISH) {
          box.appendChild(profBtn(v[slot] ? 'Change' : '+ ' + slotLabel, () =>
            openImagePicker(lname, { field: 'variants', variantIdx: vi, slot })));
        }
        thumbs.appendChild(box);
      });
      row.appendChild(thumbs);

      if (!PUBLISH) {
        row.appendChild(profBtn('Remove', () => {
          saveCharField(sky.name, { variants: variants.filter((_, i) => i !== vi) });
        }, 'prof-danger'));
      }
      list.appendChild(row);
    });
    sec.appendChild(list);
  }

  if (!PUBLISH) {
    const form = document.createElement('div'); form.className = 'prof-add-variant';
    const input = document.createElement('input');
    input.type = 'text'; input.placeholder = 'Variant name…';
    form.appendChild(input);
    form.appendChild(profBtn('+ Add variant', () => {
      const name = input.value.trim();
      if (!name) return;
      saveCharField(sky.name, { variants: [...variants, { name, render: null, figure: null }] });
    }));
    sec.appendChild(form);
  }
  return sec;
}

function renderCharProfile(lname, sky) {
  const main = document.getElementById('main');

  const header = document.createElement('div'); header.className = 'prof-header';
  const nameEl = document.createElement('h2'); nameEl.className = 'prof-name';
  nameEl.textContent = sky ? sky.name : lname.replace(/\\b\\w/g, c => c.toUpperCase());
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

  main.appendChild(profGallery(lname, sky, 'figures', 'Figures'));
  main.appendChild(profGallery(lname, sky, 'abilityIcons', 'Ability Icons'));
  main.appendChild(profVariants(lname, sky));
}

// ── Dashboard builder ───────────────────────────────────────────────────
// Each game's dashboard is an ordered list of "blocks": category cards
// (auto-populated from TREE, reorderable/hideable), plus custom link and
// text blocks added via the "Edit dashboard" builder below. Layouts persist
// to skylanders-archive/dashboard-layout.json via DASHBOARD_API.

// Categories not yet referenced by a saved layout are appended at the end
// in their default (most-images-first) order — newly classified categories
// show up automatically without needing a layout edit.
function defaultBlocks(g) {
  const blocks = [];
  if (g === 'lost-islands' && VOCAB.lostIslandsHero?.title) {
    const hero = VOCAB.lostIslandsHero;
    blocks.push({ type: 'link', title: hero.title || '', description: hero.description || '',
      icon: hero.icon || '', dest: { kind: 'model-viewer' } });
  }
  for (const [c] of catsSorted(g)) blocks.push({ type: 'category', cat: c });
  return blocks;
}

function dashBlocks(g) {
  const layout = dashDraft[g] ?? DASHBOARD_LAYOUT[g] ?? null;
  if (!layout) return defaultBlocks(g);

  const catMap = new Map(catsSorted(g));
  const seen = new Set();
  const blocks = [];
  for (const b of layout) {
    if (b.type === 'category') {
      if (!catMap.has(b.cat)) continue; // category no longer exists — drop it
      seen.add(b.cat);
    }
    blocks.push(b);
  }
  for (const [c] of catsSorted(g)) {
    if (!seen.has(c)) blocks.push({ type: 'category', cat: c });
  }
  return blocks;
}

function navigateToDest(dest) {
  if (!dest) return;
  if (dest.kind === 'model-viewer') {
    mvActive = true;
  } else if (dest.kind === 'category') {
    sel = {game: dest.game, cat: dest.cat, char: null};
    annFilter = null;
    expanded.add(dest.game);
    mvActive = false;
  } else if (dest.kind === 'character') {
    sel = {game: null, cat: null, char: dest.char};
    annFilter = null;
    charExpanded = true;
    mvActive = false;
  }
  render();
}

function toggleDashEdit(g) {
  if (dashEditMode[g]) {
    dashEditMode[g] = false;
    delete dashDraft[g];
  } else {
    dashEditMode[g] = true;
    dashDraft[g] = dashBlocks(g).map(b => ({ ...b, dest: b.dest ? {...b.dest} : undefined }));
  }
  render();
}

async function saveDashLayout(g) {
  const layout = dashDraft[g];
  try {
    const res = await fetch(DASHBOARD_API, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ game: g, layout }),
    });
    if (!res.ok) throw new Error('Server responded ' + res.status);
    DASHBOARD_LAYOUT[g] = layout;
    dashEditMode[g] = false;
    delete dashDraft[g];
    render();
  } catch (err) {
    alert('Failed to save dashboard layout: ' + err);
  }
}

function moveDashBlock(g, i, dir) {
  const arr = dashDraft[g];
  const j = i + dir;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  render();
}

function removeDashBlock(g, i) {
  dashDraft[g].splice(i, 1);
  render();
}

function toggleDashCategoryHidden(g, i) {
  dashDraft[g][i].hidden = !dashDraft[g][i].hidden;
  render();
}

// Inline "+ Add link" / "+ Add text block" form, appended below the grid.
function renderDashAddForm(g, type) {
  const host = document.getElementById('dash-add-form-host');
  if (!host) return;
  host.innerHTML = '';
  const form = document.createElement('div'); form.className = 'dash-add-form';

  if (type === 'text') {
    form.innerHTML = '<h4>Add text block</h4>'
      + '<label>Title<input id="dash-form-title" type="text"></label>'
      + '<label>Body<textarea id="dash-form-body" rows="3"></textarea></label>';
  } else {
    const gameOpts = GO.map(gg => '<option value="' + gg + '">' + escAttr(GAME_LBL[gg] ?? gg) + '</option>').join('');
    form.innerHTML = '<h4>Add link card</h4>'
      + '<label>Title<input id="dash-form-title" type="text"></label>'
      + '<label>Description<input id="dash-form-desc" type="text"></label>'
      + '<label>Icon (emoji)<input id="dash-form-icon" type="text" maxlength="4" style="max-width:60px"></label>'
      + '<label>Links to<select id="dash-form-dest-kind">'
      +   '<option value="model-viewer">3D Model Viewer</option>'
      +   '<option value="category">A category</option>'
      +   '<option value="character">A character</option>'
      + '</select></label>'
      + '<div id="dash-form-dest-extra"></div>';

    const destKindEl = form.querySelector('#dash-form-dest-kind');
    const extraEl = form.querySelector('#dash-form-dest-extra');
    const renderExtra = () => {
      const kind = destKindEl.value;
      if (kind === 'category') {
        extraEl.innerHTML = '<label>Game<select id="dash-form-dest-game">' + gameOpts + '</select></label>'
          + '<label>Category<select id="dash-form-dest-cat"></select></label>';
        const gameSel = extraEl.querySelector('#dash-form-dest-game');
        const catSel  = extraEl.querySelector('#dash-form-dest-cat');
        const fillCats = () => {
          catSel.innerHTML = catsSorted(gameSel.value)
            .map(([c]) => '<option value="' + c + '">' + escAttr(CAT_LBL(c)) + '</option>').join('');
        };
        gameSel.value = g;
        gameSel.addEventListener('change', fillCats);
        fillCats();
      } else if (kind === 'character') {
        const names = new Set();
        for (const gg of GO) for (const imgs of Object.values(TREE[gg] ?? {}))
          for (const img of imgs) for (const s of (img.skylanders || [])) names.add(s.toLowerCase());
        const dispName = lname => (SKYLANDERS.find(s => s.name.toLowerCase() === lname)?.name)
          || lname.replace(/\\b\\w/g, c => c.toUpperCase());
        const sorted = [...names].sort((a,b) => dispName(a).localeCompare(dispName(b)));
        extraEl.innerHTML = '<label>Character<select id="dash-form-dest-char">'
          + sorted.map(n => '<option value="' + n + '">' + escAttr(dispName(n)) + '</option>').join('')
          + '</select></label>';
      } else {
        extraEl.innerHTML = '';
      }
    };
    destKindEl.addEventListener('change', renderExtra);
    renderExtra();
  }

  const actions = document.createElement('div'); actions.className = 'dash-add-form-actions';
  const addBtn = document.createElement('button'); addBtn.textContent = 'Add';
  const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Cancel';
  actions.append(addBtn, cancelBtn);
  form.appendChild(actions);
  host.appendChild(form);

  cancelBtn.addEventListener('click', () => { host.innerHTML = ''; });
  addBtn.addEventListener('click', () => {
    const title = form.querySelector('#dash-form-title').value.trim();
    if (type === 'text') {
      const body = form.querySelector('#dash-form-body').value.trim();
      if (!title && !body) return;
      dashDraft[g].push({ type: 'text', title, body });
    } else {
      if (!title) return;
      const description = form.querySelector('#dash-form-desc').value.trim();
      const icon = form.querySelector('#dash-form-icon').value.trim();
      const kind = form.querySelector('#dash-form-dest-kind').value;
      let dest;
      if (kind === 'category') {
        dest = { kind: 'category', game: form.querySelector('#dash-form-dest-game').value,
          cat: form.querySelector('#dash-form-dest-cat').value };
      } else if (kind === 'character') {
        dest = { kind: 'character', char: form.querySelector('#dash-form-dest-char').value };
      } else {
        dest = { kind: 'model-viewer' };
      }
      dashDraft[g].push({ type: 'link', title, description, icon, dest });
    }
    host.innerHTML = '';
    render();
  });
}

// Per-game landing dashboard: a short tagline + a builder-configurable grid
// of category cards, link cards (e.g. to the 3D model archive), and text
// blocks. Editable in place via the "Edit dashboard" builder (curation only).
function renderDashboard(g) {
  const main = document.getElementById('main');
  main.innerHTML = '';
  lbImgs = [];

  const cats  = catsSorted(g);
  const total = cats.reduce((s,[,imgs]) => s + imgs.length, 0);
  const tagline = VOCAB.dashboards?.[g];
  const editing = !!dashEditMode[g];
  const blocks = dashBlocks(g);

  const hd = document.createElement('div'); hd.className = 'dash-hd';
  hd.innerHTML = '<div class="dash-hd-text"><h2>' + (GAME_LBL[g]??g) + '</h2>'
    + (tagline ? '<p class="dash-tagline">' + tagline + '</p>' : '') + '</div>'
    + '<span class="cnt">' + total + ' images across ' + cats.length + ' categories</span>';
  main.appendChild(hd);

  if (!PUBLISH) {
    const bar = document.createElement('div'); bar.className = 'dash-builder-bar';
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = editing ? 'Done editing' : 'Edit dashboard';
    toggleBtn.addEventListener('click', () => toggleDashEdit(g));
    bar.appendChild(toggleBtn);
    if (editing) {
      const saveBtn = document.createElement('button');
      saveBtn.className = 'dash-builder-save';
      saveBtn.textContent = 'Save layout';
      saveBtn.addEventListener('click', () => saveDashLayout(g));
      const addLinkBtn = document.createElement('button');
      addLinkBtn.textContent = '+ Add link';
      addLinkBtn.addEventListener('click', () => renderDashAddForm(g, 'link'));
      const addTextBtn = document.createElement('button');
      addTextBtn.textContent = '+ Add text block';
      addTextBtn.addEventListener('click', () => renderDashAddForm(g, 'text'));
      bar.append(saveBtn, addLinkBtn, addTextBtn);
    }
    main.appendChild(bar);
  }

  const grid = document.createElement('div'); grid.className = 'dash-grid';
  const hiddenCats = [];

  blocks.forEach((b, i) => {
    let card;
    if (b.type === 'category') {
      if (b.hidden) {
        if (editing) hiddenCats.push({ b, i });
        return;
      }
      const imgs = TREE[g]?.[b.cat] ?? [];
      const preview = imgs.slice(0, 6);
      card = document.createElement('div'); card.className = 'dash-card';
      card.innerHTML = (preview.length
          ? '<div class="dash-card-preview" style="grid-template-columns:repeat(' + Math.min(preview.length, 3) + ',1fr)">'
            + preview.map(im => '<img src="' + ARCHIVE_BASE + im.path + '" loading="lazy" alt="">').join('')
            + '</div>'
          : '')
        + '<div class="dash-card-body"><span class="dash-card-title">' + CAT_LBL(b.cat) + '</span>'
        + '<span class="cnt">' + imgs.length + ' image' + (imgs.length === 1 ? '' : 's') + '</span></div>';
      if (!editing) {
        card.addEventListener('click', () => {
          sel = {game: g, cat: b.cat, char: null};
          annFilter = null;
          expanded.add(g);
          render();
        });
      }
    } else if (b.type === 'link') {
      card = document.createElement('div'); card.className = 'dash-card dash-card-link';
      card.innerHTML = '<span class="dash-card-link-icon">' + escAttr(b.icon || '') + '</span>'
        + '<div class="dash-card-body"><span class="dash-card-title">' + escAttr(b.title || '') + '</span>'
        + (b.description ? '<span class="dash-card-desc">' + escAttr(b.description) + '</span>' : '') + '</div>';
      if (!editing) card.addEventListener('click', () => navigateToDest(b.dest));
    } else if (b.type === 'text') {
      card = document.createElement('div'); card.className = 'dash-card dash-card-text';
      card.innerHTML = (b.title ? '<span class="dash-card-text-title">' + escAttr(b.title) + '</span>' : '')
        + '<span class="dash-card-text-body">' + escAttr(b.body || '').replace(/\\n/g, '<br>') + '</span>';
    } else {
      return;
    }

    if (editing) {
      const controls = document.createElement('div'); controls.className = 'dash-block-controls';
      const upBtn = document.createElement('button'); upBtn.textContent = '\\u2191';
      upBtn.title = 'Move up'; upBtn.disabled = i === 0;
      upBtn.addEventListener('click', e => { e.stopPropagation(); moveDashBlock(g, i, -1); });
      const downBtn = document.createElement('button'); downBtn.textContent = '\\u2193';
      downBtn.title = 'Move down'; downBtn.disabled = i === blocks.length - 1;
      downBtn.addEventListener('click', e => { e.stopPropagation(); moveDashBlock(g, i, 1); });
      controls.append(upBtn, downBtn);
      if (b.type === 'category') {
        const hideBtn = document.createElement('button'); hideBtn.textContent = '\\u2715';
        hideBtn.title = 'Hide this category card';
        hideBtn.addEventListener('click', e => { e.stopPropagation(); toggleDashCategoryHidden(g, i); });
        controls.appendChild(hideBtn);
      } else {
        const rmBtn = document.createElement('button'); rmBtn.textContent = '\\u2715';
        rmBtn.title = 'Remove';
        rmBtn.addEventListener('click', e => { e.stopPropagation(); removeDashBlock(g, i); });
        controls.appendChild(rmBtn);
      }
      card.appendChild(controls);
    }

    grid.appendChild(card);
  });

  main.appendChild(grid);

  if (editing && hiddenCats.length) {
    const tray = document.createElement('div'); tray.className = 'dash-hidden-tray';
    const label = document.createElement('span'); label.className = 'dash-hidden-label';
    label.textContent = 'Hidden:';
    tray.appendChild(label);
    for (const { b, i } of hiddenCats) {
      const chip = document.createElement('button'); chip.className = 'dash-hidden-chip';
      chip.textContent = CAT_LBL(b.cat) + ' \\u21ba';
      chip.title = 'Show this category card again';
      chip.addEventListener('click', () => toggleDashCategoryHidden(g, i));
      tray.appendChild(chip);
    }
    main.appendChild(tray);
  }

  if (editing) {
    const formHost = document.createElement('div'); formHost.id = 'dash-add-form-host';
    main.appendChild(formHost);
  }
}

function renderGrid() {
  const main = document.getElementById('main');
  const mvRoot = document.getElementById('mv-root');
  const poseDetailRoot = document.getElementById('pose-detail-root');

  if (poseDetailChar) {
    // #layout is a CSS grid (\`var(--sb) 1fr\` / \`var(--sb) 1fr var(--cp)\` via
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
    return;
  }
  poseDetailRoot.style.display = 'none';

  if (mvActive) {
    main.style.display = 'none';
    mvRoot.style.display = 'flex';
    if (window.SkylanderModelViewer) window.SkylanderModelViewer.show();
    return;
  }
  mvRoot.style.display = 'none';
  main.style.display = '';
  if (window.SkylanderModelViewer) window.SkylanderModelViewer.hide();

  if (sel.game && sel.cat === null && !sel.char && !annFilter && !query) {
    renderDashboard(sel.game);
    return;
  }

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
    addSection(dispName + ' \\u2014 Featured', featured);
    addSection(dispName + ' \\u2014 Not Featured', hidden);
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
    m.textContent = query
      ? (VOCAB.empty?.noSearchResultsPrefix || 'No images match "') + query + (VOCAB.empty?.noSearchResultsSuffix || '".')
      : (VOCAB.empty?.noImages || 'No images here.');
    main.appendChild(m);
  }
}

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
    const dispName = sel.char.replace(/\\b\\w/g, c => c.toUpperCase());
    panel.innerHTML = '<div class="cp-name">' + escAttr(dispName) + '</div>'
      + '<div class="cp-sub">Not in roster</div>'
      + '<p style="font-size:.7rem;color:var(--muted);line-height:1.5">'
      + 'This character isn\\u2019t part of the tracked roster, so there\\u2019s nothing to edit here yet.</p>';
    return;
  }

  const hasExtra = Object.keys(sky.extra || {}).length > 0;
  const elLabel  = sky.element ? sky.element.charAt(0).toUpperCase() + sky.element.slice(1) : '\\u2014';

  // Published builds show metadata read-only — there's no server on the live
  // site to receive edits, so the editable form + Save button (which posts
  // to /api/update-character) only get built in curation mode.
  const metaHTML = PUBLISH
    ? '<div class="cp-field"><label>Element</label><div class="cp-ro">' + escAttr(elLabel) + '</div></div>'
      + '<div class="cp-field"><label>Species</label><div class="cp-ro">' + escAttr(sky.species || '\\u2014') + '</div></div>'
      + '<div class="cp-field"><label>Gender</label><div class="cp-ro">' + escAttr(sky.gender || '\\u2014') + '</div></div>'
      + '<div class="cp-field"><label>Role</label><div class="cp-ro">' + escAttr(sky.role || '\\u2014') + '</div></div>'
      + '<div class="cp-field cp-checks">'
        + '<span>' + (sky.owned ? '\\u2713 Owned' : '\\u2715 Not owned') + '</span>'
        + (sky.favorite ? '<span>\\u2605 Favorite</span>' : '')
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

  panel.innerHTML = '<div id="prof-model-panel"></div>'
    + '<div class="cp-name">' + escAttr(sky.name) + '</div>'
    + '<div class="cp-sub">' + escAttr(sky.game) + '</div>'
    + metaHTML;

  if (!PUBLISH) {
    const extraWrap = document.getElementById('cp-extra');
    function addExtraRow(key, val) {
      const row = document.createElement('div');
      row.className = 'cp-extra-row';
      row.innerHTML = '<input class="cp-extra-key" type="text" placeholder="Property name" value="' + escAttr(key || '') + '">'
        + '<input class="cp-extra-val" type="text" placeholder="Value" value="' + escAttr(val || '') + '">'
        + '<button class="cp-extra-rm" type="button" title="Remove">\\u2715</button>';
      row.querySelector('.cp-extra-rm').addEventListener('click', () => row.remove());
      extraWrap.appendChild(row);
    }
    Object.entries(sky.extra || {}).forEach(([k, v]) => addExtraRow(k, v));

    document.getElementById('cp-add-prop').addEventListener('click', () => addExtraRow('', ''));
    document.getElementById('cp-save').addEventListener('click', () => saveCharPanel(sky.name));
  }
  renderProfileModelViewer(sky);
}

async function saveCharPanel(name) {
  const status = document.getElementById('cp-status');
  status.className = ''; status.textContent = 'Saving…';

  const extra = {};
  document.querySelectorAll('#cp-extra .cp-extra-row').forEach(row => {
    const k = row.querySelector('.cp-extra-key').value.trim();
    const v = row.querySelector('.cp-extra-val').value.trim();
    if (k) extra[k] = v;
  });

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

  try {
    const res = await fetch('/api/update-character', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);

    // Reflect saved values in the in-memory roster so other views (and a
    // re-render of this panel) stay in sync without a full page reload.
    const sky = SKYLANDERS.find(s => s.name === name);
    if (sky) Object.assign(sky, payload);

    status.className = 'ok'; status.textContent = '\\u2713 Saved';
  } catch (e) {
    status.className = 'err'; status.textContent = 'Error: ' + e.message;
  }
}

// Not curation-only — captureFrame/mount are purely client-side (no server
// dependency), so this stays in the published build alongside the viewer.
function useAsCardArt(sky) {
  const dataUrl = window.ProfileModelViewer?.captureFrame();
  if (!dataUrl) return;
  try {
    sessionStorage.setItem('nfc-card-custom-art', dataUrl);
    sessionStorage.setItem('nfc-card-char-name', sky.name);
  } catch (e) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = sky.name.toLowerCase().replace(/\\s+/g, '-') + '-pose.png';
    a.click();
    return;
  }
  const win = window.open('/server/skylanders/nfc-card/', '_blank');
  if (!win) {
    alert('Popup blocked. Open /server/skylanders/nfc-card/ manually — the image is ready.');
  }
}

function renderProfileModelViewer(sky) {
  const panel = document.getElementById('prof-model-panel');
  if (!panel) return;
  const models = sky?.models || [];
  if (!models.length) {
    panel.innerHTML = '<div class="prof-mv-empty">No 3D model available for this character.</div>';
    return;
  }
  const wrap = document.createElement('div'); wrap.className = 'prof-mv-wrap';

  const canvasWrap = document.createElement('div'); canvasWrap.className = 'prof-mv-canvas-wrap';
  wrap.appendChild(canvasWrap);

  if (models.length > 1) {
    const variantsEl = document.createElement('div'); variantsEl.className = 'prof-mv-variants';
    models.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'prof-mv-variant' + (i === 0 ? ' on' : '');
      btn.textContent = m.name;
      btn.addEventListener('click', () => {
        variantsEl.querySelectorAll('.prof-mv-variant').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        window.ProfileModelViewer?.switchModel(i);
      });
      variantsEl.appendChild(btn);
    });
    wrap.appendChild(variantsEl);
  }

  const actions = document.createElement('div'); actions.className = 'prof-mv-actions';
  const poseBtn = document.createElement('button');
  poseBtn.className = 'prof-mv-card-btn';
  poseBtn.textContent = 'Pose & send to card \\u2192';
  poseBtn.addEventListener('click', () => openPoseDetail(sky));
  actions.appendChild(poseBtn);
  wrap.appendChild(actions);

  panel.appendChild(wrap);
  window.ProfileModelViewer?.mount(canvasWrap, models);
}

function openPoseDetail(sky) {
  poseDetailChar = sky.name;
  render();
}

function closePoseDetail() {
  window.ProfileModelViewer?.destroy();
  poseDetailChar = null;
  lastPoseDetailChar = null;
  lastPanelChar = null; // forces renderCharPanel to remount the small viewer it destroyed
  render();
}

function renderPoseDetail(charName) {
  const root = document.getElementById('pose-detail-root');
  if (charName === lastPoseDetailChar) return;
  window.ProfileModelViewer?.destroy();
  lastPoseDetailChar = charName;

  const sky = SKYLANDERS.find(s => s.name === charName);
  const models = sky?.models || [];

  root.innerHTML = '<div class="pose-detail-toolbar">'
    + '<button class="pose-detail-back" type="button">\\u2039 Back to ' + escAttr(charName) + '</button>'
    + '</div>'
    + '<div class="pose-detail-body">'
      + '<div class="pose-detail-canvas-host"></div>'
      + '<div class="pose-detail-side"></div>'
    + '</div>';

  root.querySelector('.pose-detail-back').addEventListener('click', closePoseDetail);

  const canvasHost = root.querySelector('.pose-detail-canvas-host');
  const sideEl     = root.querySelector('.pose-detail-side');

  if (!models.length) {
    canvasHost.innerHTML = '<div class="prof-mv-empty">No 3D model available for this character.</div>';
    return;
  }

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'prof-mv-canvas-wrap';
  canvasHost.appendChild(canvasWrap);

  if (models.length > 1) {
    const variantsEl = document.createElement('div'); variantsEl.className = 'prof-mv-variants';
    models.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'prof-mv-variant' + (i === 0 ? ' on' : '');
      btn.textContent = m.name;
      btn.addEventListener('click', () => {
        variantsEl.querySelectorAll('.prof-mv-variant').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        window.ProfileModelViewer?.switchModel(i);
      });
      variantsEl.appendChild(btn);
    });
    sideEl.appendChild(variantsEl);
  }

  const actions = document.createElement('div'); actions.className = 'prof-mv-actions';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset pose';
  resetBtn.addEventListener('click', () => window.ProfileModelViewer?.resetPose());
  actions.appendChild(resetBtn);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'prof-mv-card-btn';
  sendBtn.textContent = '\\u2197 Send to NFC';
  sendBtn.addEventListener('click', () => useAsCardArt(sky));
  actions.appendChild(sendBtn);
  sideEl.appendChild(actions);

  window.ProfileModelViewer?.mount(canvasWrap, models, { posable: true, boneUiHost: sideEl });
}

function render() { renderSidebar(); renderGrid(); renderCharPanel(); if (tagModeOn) refreshTagOverlays(); }

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
  document.getElementById('lb-src').href = img.source || img.postUrl || '#';
  const tags = (img.tags||[]).slice(0,8).join(', ');
  document.getElementById('lb-meta').innerHTML =
    '<span class="lb-id">' + (img.id||'') + '</span><br>' +
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

function openAboutModal()  { document.getElementById('about-modal').classList.add('open'); }
function closeAboutModal() { document.getElementById('about-modal').classList.remove('open'); }
document.getElementById('about-modal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeAboutModal();
});

document.addEventListener('keydown', e => {
  // #lb-edit / toggleEdit only exist when editing UI is built (--publish omits both)
  const editPanel = document.getElementById('lb-edit');
  const editOpen  = !!editPanel && editPanel.classList.contains('open');
  if (e.key === 'Escape') {
    if (document.getElementById('about-modal').classList.contains('open')) closeAboutModal();
    else if (editOpen) toggleEdit();
    else closeLb();
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

// ── Tag Mode ───────────────────────────────────────────────────────────────${tagModeJS}${editPanelJS}${addModalJS}${publishJS}${charProfileJS}
let _st;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(_st);
  _st = setTimeout(() => { query = e.target.value.toLowerCase().trim(); render(); }, 220);
});

// Embedded 3D model viewer wiring: a #model=/#texture= deep link opens the
// viewer on the Lost Islands dashboard, and the viewer's "Back" button exits it.
window.addEventListener('skylander-model-deeplink', () => {
  sel = {game: 'lost-islands', cat: null, char: null};
  annFilter = null;
  expanded.add('lost-islands');
  mvActive = true;
  render();
});
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
</script>
</body>
</html>`;

// Stripped-down, edit-free variant for the live site — the curation UI
// (`html` above) calls EDIT_API and mutates the archive, neither of which
// works without the local archive-server.mjs. Derived by removing the exact
// editing-only blocks that were interpolated into `html`.
const htmlPublish = html
  .replace(tagModeBtnHTML, '')
  .replace(tagBarHTML, '')
  .replace(editBtnHTML, '')
  .replace(editPanelHTML, '')
  .replace(addImageBtnHTML, '')
  .replace(addModalHTML, '')
  .replace(imagePickerModalHTML, '')
  .replace(publishBtnHTML, '')
  .replace(tagModeJS, '')
  .replace(editPanelJS, '')
  .replace(addModalJS, '')
  .replace(publishJS, '')
  .replace(charProfileJS, '')
  .replace('const PUBLISH    = false;', 'const PUBLISH    = true;');

// Local curation copy — always the full editing UI, regardless of how this
// script was invoked, so `archive-server.mjs` keeps working after a publish run.
writeFileSync(join(OUT, 'index.html'), html.replace(/'__ARCHIVE_BASE__'/, "''"));

// Website version — base path depends on build mode: the curation server's
// localhost URL for local iteration, or the statically-synced publish path
// for the live site (which has no server to talk to).
const PUBLISH_IMAGE_BASE = '/images/skylanders-archive/';
const websiteOutDir = join(__dir, '../src/pages/server/skylanders/archive');
mkdirSync(websiteOutDir, { recursive: true });
writeFileSync(
  join(websiteOutDir, 'index.html'),
  isPublish
    ? htmlPublish.replace(/'__ARCHIVE_BASE__'/, `'${PUBLISH_IMAGE_BASE}'`)
    : html.replace(/'__ARCHIVE_BASE__'/, "'http://localhost:7373/'")
);

if (isPublish) {
  // ── Sync image files into the website so the live site can serve them
  // statically — no curation server required to browse the archive.
  const publishImagesDir = join(__dir, '../src/images/skylanders-archive');
  mkdirSync(publishImagesDir, { recursive: true });
  console.log(`Syncing images to ${publishImagesDir} …`);
  const rsync = spawnSync('rsync', [
    '-a', '--delete',
    '--exclude=_images', '--exclude=_removed', '--exclude=*.json*', '--exclude=*.html', '--exclude=.DS_Store',
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
        url:      PUBLISH_IMAGE_BASE + img.path,
        anns:     imgAnns,
        game:     img.game || post.game,
        file:     img.file,
        postId:   String(post.id),
        featured: img.featured !== false, // default true; false only when explicitly set
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

