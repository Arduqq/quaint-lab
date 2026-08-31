#!/usr/bin/env node
/**
 * Skylanders Tumblr Archive
 * ─────────────────────────
 * Downloads posts from a Tumblr blog and sorts images into:
 *   <output>/<game>/<category>/<subject-slug>_<post-id>_<n>.ext
 *
 * Classification uses the structured post format:
 *   "Zook's abilities from Skylanders: Ring of Heroes (…, 2018)"
 *    └─ subject ──┘      └──── game name (explicit) ────┘
 *
 * Game   → parsed from "from Skylanders: X" first, then tags/text fallback
 * Category → matched against the subject description (before "from"), then tags, then full text
 * Character → extracted from possessives in subject ("Zook's …" → "zook")
 * Filename → <subject-slug>_<postid>_<n>.ext  (immediately readable)
 *
 * Setup:
 *   1. https://www.tumblr.com/oauth/apps → Register app → copy Consumer Key
 *   2. TUMBLR_API_KEY=<key> node scripts/archive-tumblr.mjs [output-dir]
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync, linkSync, copyFileSync } from 'fs';
import { join, extname } from 'path';

const API_KEY  = process.env.TUMBLR_API_KEY;
const BLOG     = 'yourlocaltoad.tumblr.com';
const TAG      = 'skylanders';
const OUT      = process.argv[2] ?? './skylanders-archive';
const DELAY_MS = 400;

if (!API_KEY) {
  console.error(`
  Missing Tumblr API key.

  1. Go to https://www.tumblr.com/oauth/apps
  2. Click "Register application" — any name/URL works for personal use
  3. Copy the Consumer Key (API Key) from the app page
  4. Run:

     TUMBLR_API_KEY=your_key  caffeinate -i  node scripts/archive-tumblr.mjs  ./skylanders-archive
`);
  process.exit(1);
}

// ── Games ──────────────────────────────────────────────────────────────────
// `rx` is matched against the explicit game name parsed from post text first,
// then as a fallback against tags + full text.
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
// No predefined list — the category IS the parsed content description,
// slugified. "Loading screens", "Character page", "abilities" etc. come
// straight from the post text rather than being forced into fixed buckets.
//
// The only cleanup: strip trailing character names after prepositions so
// "Concept art for Gill Grunt" → "concept-art", not "concept-art-for-gill-grunt".

// ── Post parsing ───────────────────────────────────────────────────────────

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48);

/**
 * Derive a folder-friendly category slug directly from the parsed description.
 * Strips trailing character names / qualifiers after prepositions so
 * "Concept art for Gill Grunt" → "concept-art" rather than the full phrase.
 */
function toCategory(desc) {
  if (!desc) return 'misc';
  const d = desc.replace(/&[a-z#][a-z0-9]*;/gi, ' ').replace(/\s+/g, ' ').trim();

  // Per-character RoH content → generic buckets (character name preserved via tags)
  if (/\babilities\b/i.test(d))            return 'abilities';
  if (/\bequipment\b/i.test(d))            return 'equipment';
  if (/soul.?stone/i.test(d))              return 'soul-stone-icons';
  if (/collection.?render/i.test(d))       return 'collection-renders';

  // Imaginators customisation
  if (/imaginator.?parts?\b/i.test(d))     return 'imaginator-parts';
  if (/\b(knight|smasher|sorcerer|sentinel|quickshot|ninja|brawler|bowslinger|bazooker|swashbuckler)\s+weapons?\b/i.test(d))
    return 'creation-weapons';

  // Official website asset types — specific before general
  if (/villain\s+polaroid/i.test(d))       return 'villain-polaroids';
  if (/villain\s+page/i.test(d))           return 'villain-pages';
  if (/character\s+page/i.test(d))         return 'character-pages';
  if (/game\s+page/i.test(d))              return 'game-pages';
  if (/\bblueprints?\b/i.test(d))          return 'blueprints';
  if (/\bpolaroids?\b/i.test(d))           return 'polaroids';
  if (/\btraps?\b.*skylanders/i.test(d))   return 'traps';
  if (/home\s+page\s+assets?/i.test(d))    return 'website-assets';

  // RoH asset subtypes
  if (/banner\s+assets?|event\s+banner/i.test(d))   return 'banners';
  if (/shop\s+icons?\b/i.test(d))          return 'shop-icons';
  if (/\btown\s+assets?\b/i.test(d))       return 'town-assets';
  if (/\bmap\s+assets?\b/i.test(d))        return 'map-assets';
  if (/element(?:al)?\s+assets?\b/i.test(d)) return 'element-assets';

  // Imaginators icon / render cleanup
  if (/\bmusic.+icons?\b/i.test(d))        return 'music-icons';
  if (/\bvoice.+icons?\b/i.test(d))        return 'voice-icons';
  if (/transp(?:a|e)rent\s+renders?\b/i.test(d)) return 'transparent-renders';

  // Fan art / community drawings
  if (/\b(doodle|drawing|sketch|fanart|fan.art|art.dump|scribble|commission)\b/i.test(d))
    return 'fan-art';
  if (/\bday[-\s]?\d+\b/i.test(d))         return 'fan-art'; // skytober / challenge art
  if (/skydonalds/i.test(d))               return 'fan-art';
  // Short community blog-handle slugs (reblogged fan content)
  if (/^(?:hungry.?skeleton|junkyardisles|skyblue.?blazes|mightyart|blu3b1rd)\b/i.test(d))
    return 'fan-art';

  const clean = d
    .replace(/\s+(?:for|of|by|featuring)\s+[A-Z].+$/i, '')
    .replace(/\s+(?:from|in)\s+[A-Z][A-Za-z ]+$/i, '')
    .trim();
  const result = slugify(clean) || slugify(d) || 'misc';
  // All valid category slugs are ≤19 chars; anything longer is a raw blog caption
  return result.length >= 20 ? 'fan-art' : result;
}

/** Extract extra tags: character name from possessive, imaginator part, creation class. */
function extractExtraTags(subject, contentDesc) {
  const extra = [];
  const d = (contentDesc || '').replace(/&[a-z#][a-z0-9]*;/gi, "'").trim();
  const s = (subject     || '').replace(/&[a-z#][a-z0-9]*;/gi, "'").trim();

  // Character name from possessive anywhere in subject
  const pm = /\b((?:dr\.?\s+)?[A-Z][A-Za-z''\-\.]+(?:\s+[A-Z][A-Za-z\-]+)?)'s?\b/.exec(s);
  if (pm) extra.push(pm[1].toLowerCase());

  // Imaginator body part: "Head Imaginator Parts" → "head"
  const partM = /^(.+?)\s+imaginator\s+parts?\b/i.exec(d);
  if (partM) extra.push(partM[1].toLowerCase().trim());

  // Creation weapon class: "Knight weapons" → "knight"
  const classM = /^(knight|smasher|sorcerer|sentinel|quickshot|ninja|brawler|bowslinger|bazooker|swashbuckler)\s+weapons?\b/i.exec(d);
  if (classM) extra.push(classM[1].toLowerCase());

  return extra;
}

/**
 * Parse the structured post format:
 *   "Zook's abilities from Skylanders: Ring of Heroes (Skylanders: Ring of Heroes, 2018)"
 *
 * Returns { subject, gameHint, contentDesc }
 *   subject     — full text before "from Skylanders" (e.g. "Zook's abilities")
 *   gameHint    — raw game name string after "from Skylanders:" (e.g. "Ring of Heroes")
 *   contentDesc — content part after possessive (e.g. "abilities"), or full subject
 */
function parseSubject(text) {
  // Decode curly apostrophes/quotes so possessive regex works on stored manifest text
  const t = text.replace(/&rsquo;/gi,"'").replace(/&lsquo;/gi,"'").replace(/&#8217;/g,"'").replace(/&#39;/g,"'").replace(/&[a-z#][a-z0-9]*;/gi,' ');
  // Match "X from Skylanders: Y" or "X from Y (Y, year)"
  const fromRx = /^(.+?)\s+from\s+(?:skylanders[:\s]+)?([^(]+?)(?:\s*\(|$)/i;
  const m = fromRx.exec(t.trim());

  const subject  = m ? m[1].trim() : t.trim();
  const gameHint = m ? m[2].trim() : null;

  // Extract content description from possessive found ANYWHERE in subject.
  // "Zook's abilities" → "abilities"
  // "Assets used for Gear Shift's Character page" → "Character page"
  // Also handles "Dr. Krankcase's X", "Ka-Boom's X", "Tri-Tip's X"
  const possRx = /\b((?:dr\.?\s+)?[A-Z][A-Za-z''\-\.]+(?:\s+[A-Z][A-Za-z\-]+)?)'s?\s+(.+)/;
  const pm = possRx.exec(subject);

  const contentDesc = pm ? pm[2].trim() : subject;

  return { subject, gameHint, contentDesc };
}

/** Detect game: explicit gameHint first, then tags, then full text. */
function detectGame(gameHint, text, tags) {
  const sources = [gameHint, tags.join(' '), text].filter(Boolean);
  for (const src of sources) {
    for (const g of GAMES) {
      if (g.rx.some(r => r.test(src))) return g.id;
    }
  }
  return 'misc';
}


/** Build filename: <subject-slug>_<postId>_<n>.ext — human-readable at a glance. */
function makeFilename(subject, postId, idx, ext) {
  const prefix = slugify(subject);
  return prefix ? `${prefix}_${postId}_${idx}${ext}` : `${postId}_${idx}${ext}`;
}

// ── Utilities ──────────────────────────────────────────────────────────────
const sleep     = ms  => new Promise(r => setTimeout(r, ms));
const mkdir     = p   => mkdirSync(p, { recursive: true });
const stripHtml = s   => (s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function hardLink(src, dest) {
  if (existsSync(dest)) return;
  try   { linkSync(src, dest); }
  catch { copyFileSync(src, dest); }
}

async function downloadImage(url, dest) {
  if (existsSync(dest)) return;
  const res = await fetch(url, { headers: { 'User-Agent': 'tumblr-archive/1.0 (personal)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ── Image URL extraction ───────────────────────────────────────────────────
function extractImages(post) {
  const seen = new Set(), out = [];
  const add  = u => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };

  if (post.photos) {
    for (const ph of post.photos) add(ph.original_size?.url ?? ph.alt_sizes?.[0]?.url);
  }
  if (post.content) {
    for (const block of post.content) {
      if (block.type === 'image' && block.media?.length) {
        const best = block.media.reduce((a, b) => (b.width > (a?.width ?? 0) ? b : a), null);
        add(best?.url);
      }
    }
  }
  const html = post.caption ?? post.body ?? '';
  for (const [, u] of html.matchAll(/src="(https:\/\/\d+\.media\.tumblr\.com\/[^"]+)"/g)) add(u);
  return out;
}

// ── Tumblr API ─────────────────────────────────────────────────────────────
async function fetchPage(offset) {
  const url = new URL(`https://api.tumblr.com/v2/blog/${BLOG}/posts`);
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('tag',     TAG);
  url.searchParams.set('limit',   '20');
  url.searchParams.set('offset',  String(offset));

  const res  = await fetch(url.toString());
  const json = await res.json();
  if (json.meta?.status !== 200)
    throw new Error(`Tumblr API ${json.meta?.status}: ${json.meta?.msg}`);
  return json.response;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const imgStore = join(OUT, '_images');
  mkdir(imgStore);

  const manifestPath = join(OUT, 'manifest.json');
  let manifest = { blog: BLOG, tag: TAG, fetched_at: new Date().toISOString(), total: 0, posts: [] };
  const seenIds = new Set();

  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.posts.forEach(p => seenIds.add(String(p.id)));
      console.log(`↩  Resuming — ${seenIds.size} posts already archived.\n`);
    } catch { console.warn('Could not parse existing manifest, starting fresh.\n'); }
  }

  let offset = 0, total = Infinity, newPosts = 0, newImgs = 0;

  while (offset < total) {
    process.stdout.write(`  Fetching posts ${offset}–${offset + 19}…`);
    const page = await fetchPage(offset);
    total = page.total_posts;
    const posts = page.posts ?? [];
    console.log(` of ${total}`);
    if (!posts.length) break;

    for (const post of posts) {
      if (seenIds.has(String(post.id))) continue;

      const rawText = stripHtml(post.caption ?? post.body ?? post.summary ?? '');
      const tags    = post.tags ?? [];

      // ── Classify ──
      const { subject, gameHint, contentDesc } = parseSubject(rawText);
      const game     = detectGame(gameHint, rawText, tags);
      const category = tags.map(t => t.toLowerCase()).includes('my art') ? 'fan-art' : toCategory(contentDesc);
      const allTags  = [...tags, ...extractExtraTags(subject, contentDesc).filter(t => !tags.includes(t))];

      const imgUrls = extractImages(post);
      const saved   = [];

      for (let i = 0; i < imgUrls.length; i++) {
        const url  = imgUrls[i];
        let   ext  = extname(new URL(url).pathname).split('?')[0] || '.jpg';
        if (ext === '.gifv') ext = '.gif';

        const fname     = makeFilename(subject, post.id, i, ext);
        const storeDest = join(imgStore, fname);

        // 1. Download to flat store
        try {
          await downloadImage(url, storeDest);
        } catch (e) {
          saved.push({ file: fname, url, game, category, error: e.message });
          process.stdout.write('!');
          continue;
        }

        // 2. Hard-link into <game>/<category>/
        const catDir  = join(OUT, game, category);
        mkdir(catDir);
        hardLink(storeDest, join(catDir, fname));

        saved.push({ file: fname, url, game, category, path: join(game, category, fname) });
        newImgs++;
        process.stdout.write('.');
      }
      if (saved.length) process.stdout.write('\n');

      manifest.posts.push({
        id: post.id, type: post.type, date: post.date?.slice(0, 10) ?? '',
        game, category, subject,
        tags: allTags, text: rawText.slice(0, 400),
        images: saved, url: post.post_url,
      });
      seenIds.add(String(post.id));
      newPosts++;
    }

    manifest.total      = total;
    manifest.fetched_at = new Date().toISOString();
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    offset += posts.length;
    if (offset < total) await sleep(DELAY_MS);
  }

  console.log(`\n✓  ${newPosts} new posts, ${newImgs} images.`);
  console.log(`   Sorted into: ${OUT}/<game>/<category>/`);
  buildIndex(manifest, OUT);
  console.log(`   Browser:     ${join(OUT, 'index.html')}\n`);
  printSummary(manifest);
}

// ── Summary table ──────────────────────────────────────────────────────────
function printSummary(manifest) {
  const counts = {};
  for (const post of manifest.posts) {
    for (const img of post.images) {
      if (img.error) continue;
      const key = `${img.game ?? post.game}|||${img.category ?? post.category}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }

  const gameIds = [...new Set(Object.keys(counts).map(k => k.split('|||')[0]))].sort((a, b) => {
    const o = GAMES.map(g => g.id); return (o.indexOf(a) + 1 || 99) - (o.indexOf(b) + 1 || 99);
  });
  // Sort categories by total image count descending
  const catIds = [...new Set(Object.keys(counts).map(k => k.split('|||')[1]))]
    .sort((a, b) => {
      const na = gameIds.reduce((s, g) => s + (counts[`${g}|||${a}`] ?? 0), 0);
      const nb = gameIds.reduce((s, g) => s + (counts[`${g}|||${b}`] ?? 0), 0);
      return nb - na;
    });

  const PAD = 24, W = 8;
  const gameLabels = gameIds.map(g => (GAMES.find(x => x.id === g)?.label ?? g).slice(0, W - 1).padStart(W));
  console.log('\n  ' + ''.padEnd(PAD) + gameLabels.join(''));
  console.log('  ' + '─'.repeat(PAD + W * gameIds.length));

  for (const cat of catIds) {
    const lbl  = cat.padEnd(PAD);
    const cols = gameIds.map(g => ((counts[`${g}|||${cat}`] ?? '') || '·').toString().padStart(W));
    console.log('  ' + lbl + cols.join(''));
  }

  const totals = 'TOTAL'.padEnd(PAD) + gameIds.map(g => {
    const n = catIds.reduce((s, c) => s + (counts[`${g}|||${c}`] ?? 0), 0);
    return (n || '·').toString().padStart(W);
  }).join('');
  console.log('  ' + '─'.repeat(PAD + W * gameIds.length));
  console.log('  ' + totals + '\n');
}

// ── Offline HTML browser ───────────────────────────────────────────────────
function buildIndex(manifest, outDir) {
  const gameMap = { misc: 'Misc', ...Object.fromEntries(GAMES.map(g => [g.id, g.label])) };

  // tree[game][category] = [{path, url, date, tags, postUrl, subject, text}]
  const tree = {};
  for (const post of manifest.posts) {
    for (const img of post.images) {
      if (img.error || !img.path) continue;
      const g = img.game ?? post.game;
      const c = img.category ?? post.category;
      ((tree[g] ??= {})[c] ??= []).push({
        path: img.path, url: img.url,
        date: post.date, tags: post.tags, postUrl: post.url,
        subject: post.subject, text: post.text,
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

  const html = buildHTML(manifest, tree, gameMap, gameOrder, total);
  writeFileSync(join(outDir, 'index.html'), html);
}

function buildHTML(manifest, tree, gameMap, gameOrder, total) {
  return `<!DOCTYPE html>
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
/* ── header ── */
#hdr{flex:0 0 50px;background:var(--bg2);border-bottom:2px solid var(--gold);
  display:flex;align-items:center;gap:12px;padding:0 18px;min-width:0}
#hdr h1{color:var(--gold);font-size:.85rem;text-transform:uppercase;letter-spacing:1.5px;white-space:nowrap}
#hdr p{font-size:.68rem;color:var(--muted);white-space:nowrap;flex-shrink:0}
#q{margin-left:auto;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);
  color:#fff;padding:5px 11px;border-radius:4px;font-size:.78rem;font-family:inherit;width:200px;flex-shrink:0}
#q::placeholder{color:var(--muted)}
#q:focus{outline:none;border-color:rgba(255,204,0,.5)}
/* ── layout ── */
#layout{flex:1 1 0;min-height:0;display:grid;grid-template-columns:var(--sb) 1fr}
/* ── sidebar ── */
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
/* ── main ── */
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
/* ── lightbox ── */
#lb{display:none;position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.92);
  align-items:center;justify-content:center;flex-direction:column;gap:12px}
#lb.open{display:flex}
#lb-img{max-width:88vw;max-height:76vh;object-fit:contain;border-radius:6px}
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
/* ── scrollbar ── */
::-webkit-scrollbar{width:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(255,204,0,.25);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:rgba(255,204,0,.5)}
</style>
</head>
<body>
<div id="hdr">
  <h1>Skylanders Archive</h1>
  <p>${manifest.blog} &nbsp;·&nbsp; ${manifest.posts.length} posts &nbsp;·&nbsp; ${total} images &nbsp;·&nbsp; ${manifest.fetched_at.slice(0,10)}</p>
  <input id="q" type="search" placeholder="Search…" autocomplete="off">
</div>
<div id="layout">
  <aside id="sb"></aside>
  <main id="main"></main>
</div>

<div id="lb">
  <div class="lb-x" onclick="closeLb()">✕</div>
  <img id="lb-img" src="" alt="">
  <div id="lb-meta"></div>
  <div class="lb-row">
    <button class="lb-arr" onclick="stepLb(-1)">‹</button>
    <a id="lb-dl"  class="lb-btn" download>↓ Save</a>
    <a id="lb-src" class="lb-btn" target="_blank">↗ Post</a>
    <button class="lb-arr" onclick="stepLb(1)">›</button>
  </div>
</div>

<script>
const TREE     = ${JSON.stringify(tree)};
const GAME_LBL = ${JSON.stringify(gameMap)};
const GO       = ${JSON.stringify(gameOrder)};
const CAT_LBL  = c => c.replace(/-/g,' ').replace(/\\b\\w/g, l => l.toUpperCase());

let sel     = {game: null, cat: null};
const expanded = new Set(GO);  // start with all games expanded
let lbImgs  = [], lbIdx = 0;
let query   = '';

// ── helpers ────────────────────────────────────────────────────────────────
function searchMatch(img, q) {
  return [(img.subject||''), (img.tags||[]).join(' '), (img.text||'')].join(' ').toLowerCase().includes(q);
}

function catsSorted(g) {
  return Object.entries(TREE[g] ?? {}).sort((a,b) => b[1].length - a[1].length);
}

// ── sidebar ────────────────────────────────────────────────────────────────
function renderSidebar() {
  const sb = document.getElementById('sb');
  sb.innerHTML = '';

  // "All" row
  const allEl = document.createElement('div');
  allEl.className = 'sb-all' + (sel.game === null && sel.cat === null ? ' on' : '');
  allEl.innerHTML = '<span>All Images</span><span class="cnt">${total}</span>';
  allEl.addEventListener('click', () => { sel = {game:null, cat:null}; render(); });
  sb.appendChild(allEl);

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
      if (sel.game === g && sel.cat === null && expanded.has(g)) {
        expanded.delete(g);
      } else {
        expanded.add(g);
        sel = {game: g, cat: null};
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
        expanded.add(g);
        render();
      });
      catsEl.appendChild(catEl);
    }
    gameEl.appendChild(catsEl);
    sb.appendChild(gameEl);
  }
}

// ── grid ───────────────────────────────────────────────────────────────────
function renderGrid() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  lbImgs = [];

  const games = sel.game ? [sel.game] : GO;
  let shown = 0;

  for (const g of games) {
    if (!TREE[g]) continue;
    const cats = sel.cat
      ? (TREE[g][sel.cat] ? [[sel.cat, TREE[g][sel.cat]]] : [])
      : catsSorted(g);

    for (const [c, rawImgs] of cats) {
      const imgs = query ? rawImgs.filter(i => searchMatch(i, query)) : rawImgs;
      if (!imgs.length) continue;

      const startIdx = lbImgs.length;
      imgs.forEach(i => lbImgs.push(i));
      shown += imgs.length;

      const sec  = document.createElement('div'); sec.className = 'sec';
      const hd   = document.createElement('div'); hd.className = 'sec-hd';
      const title = sel.game ? CAT_LBL(c) : (GAME_LBL[g]??g) + ' / ' + CAT_LBL(c);
      hd.innerHTML = title + ' <span class="cnt">' + imgs.length + '</span>';
      sec.appendChild(hd);

      const grid = document.createElement('div'); grid.className = 'grid';
      imgs.forEach((img, li) => {
        const card  = document.createElement('div'); card.className = 'card';
        const label = img.subject || (img.tags||[]).slice(0,2).join(', ') || '';
        card.innerHTML = '<img src="' + img.path + '" loading="lazy" alt="">'
          + '<div class="foot">' + label + '</div>';
        const idx = startIdx + li;
        card.addEventListener('click', () => openLb(idx));
        grid.appendChild(card);
      });
      sec.appendChild(grid);
      main.appendChild(sec);
    }
  }

  if (!shown) {
    const m = document.createElement('div'); m.id = 'empty';
    m.textContent = query ? 'No images match "' + query + '".' : 'No images here.';
    main.appendChild(m);
  }
}

function render() { renderSidebar(); renderGrid(); }

// ── lightbox ───────────────────────────────────────────────────────────────
function openLb(idx) {
  lbIdx = Math.max(0, Math.min(idx, lbImgs.length - 1));
  const img = lbImgs[lbIdx];
  if (!img) return;
  document.getElementById('lb-img').src  = img.path;
  document.getElementById('lb-dl').href  = img.path;
  document.getElementById('lb-src').href = img.postUrl || '#';
  const tags = (img.tags||[]).slice(0,8).join(', ');
  document.getElementById('lb-meta').innerHTML =
    (img.subject ? '<strong style="color:#fff">' + img.subject + '</strong><br>' : '') +
    (img.date ? img.date + '&nbsp;·&nbsp;' : '') + tags;
  document.getElementById('lb').classList.add('open');
}
function stepLb(d) { openLb((lbIdx + d + lbImgs.length) % lbImgs.length); }
function closeLb() { document.getElementById('lb').classList.remove('open'); }

document.getElementById('lb').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeLb();
});
document.addEventListener('keydown', e => {
  if      (e.key === 'Escape')      closeLb();
  else if (e.key === 'ArrowLeft')   stepLb(-1);
  else if (e.key === 'ArrowRight')  stepLb(1);
});

// ── search ─────────────────────────────────────────────────────────────────
let _st;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(_st);
  _st = setTimeout(() => { query = e.target.value.toLowerCase().trim(); render(); }, 220);
});

render();
</script>
</body>
</html>`;
}

main().catch(e => { console.error('\n  Error:', e.message, '\n'); process.exit(1); });
