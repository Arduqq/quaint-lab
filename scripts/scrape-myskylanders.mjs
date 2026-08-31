#!/usr/bin/env node
/**
 * Scrapes official character artwork from myskylanders.wordpress.com and
 * weaves it into the local archive / manifest so it appears automatically
 * in the NFC card maker's art picker and the collection page tooltips.
 *
 * The site has 86 character pages covering SpA → Swap Force, each hosting
 * several image types:
 *   *-artwork.png       — primary official render (1268–1480 px wide)
 *   s2-*-artwork.png    — Series 2 re-release
 *   legendary-*-artwork — Legendary / special edition
 *   dark-*-artwork      — Dark variant (Dark Spyro etc.)
 *   granite-*-artwork   — Granite variant (Granite Crusher etc.)
 *   *-figur.*           — toy photograph  ← SKIPPED (low res)
 *   gameplay-*          — in-game screen  ← SKIPPED
 *
 * Each downloaded file is saved as:
 *   character-art-{charslug}-{variant}.png
 * This 'character-art-' prefix matches the detection in nfc-card.njk's
 * loadCharImg() and loadArchivePickers(), so images appear in the art
 * picker without any further code changes.
 *
 * Usage:
 *   node scripts/scrape-myskylanders.mjs [--dry] [--names Spyro,Ignitor] [--limit N]
 *
 *   --dry          Fetch & report but write nothing (no downloads, no manifest edits)
 *   --names X,Y    Only process named characters (comma-separated)
 *   --limit N      Stop after N characters (for testing)
 */
import sharp from 'sharp';
import fs    from 'fs';
import path  from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO  = path.resolve(__dir, '..');

const ARCHIVE        = path.join(REPO, 'skylanders-archive');
const IMAGES_DIR     = path.join(ARCHIVE, '_images');
const MANIFEST_PATH  = path.join(ARCHIVE, 'manifest.json');
const SKYLANDERS_PATH = path.join(REPO, 'src/_data/skylanders.json');
const BASE_URL       = 'https://myskylanders.wordpress.com';

const args  = process.argv.slice(2);
const DRY   = args.includes('--dry');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i+1], 10) : Infinity; })();
const NAMES = (() => {
  const i = args.indexOf('--names');
  if (i < 0) return null;
  return new Set(args[i+1].split(',').map(s => s.trim().toLowerCase()));
})();

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Slug helpers ──────────────────────────────────────────────────────────────

function charToSlug(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents (Déjà → deja)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// The site sometimes uses different slugs than what charToSlug() produces.
const SLUG_OVERRIDES = {
  'jet-vac':      'jet-vac',  // our name is "Jet Vac" → "jet-vac" ✓ (same)
};

// ── Variant extraction ────────────────────────────────────────────────────────
// Given a filename like "s2-ignitor-artwork.png" and charSlug "ignitor",
// returns a short variant tag: "s2", "legendary", "dark", "official", etc.

function extractVariant(rawFilename, charSlug) {
  const base = rawFilename
    .replace(/\.(png|jpe?g|gif|webp)$/i, '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-artwork$/, '');
  // Remove the character slug (and neighbouring dashes) to get the descriptor
  const descriptor = base.replace(new RegExp(`(^|-)${charSlug.replace(/-/g, '[-_]')}([-]|$)`, 'g'), '-').replace(/^-+|-+$/g, '');
  return descriptor || 'official';
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchBinary(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'image/*', 'Referer': BASE_URL + '/' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── Image classification ──────────────────────────────────────────────────────
// Returns true for images we want to keep (official renders, not photos or screenshots).

function isWantedImage(filename, width, height) {
  const f = filename.toLowerCase();
  // Exclude figure photos, gameplay screenshots, promo thumbnails, headers
  if (/figur|gameplay|screen|promo|header|cropped|_thumb|megaramspyro/.test(f)) return false;
  // Must contain 'artwork' OR be large enough to be an official render (≥ 800px)
  const hasArtwork = f.includes('artwork');
  const isLarge = width >= 800 || height >= 800;
  return hasArtwork || isLarge;
}

// ── Page scrapers ─────────────────────────────────────────────────────────────

async function getCharacterPageSlugs() {
  const html = await fetchText(`${BASE_URL}/charaktere/`);
  const slugs = new Set();
  const re = /href="https:\/\/myskylanders\.wordpress\.com\/charaktere\/([a-z0-9][a-z0-9-]*)\/"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const s = m[1];
    // Skip index pages and non-character pages
    if (/^(skylanders-element|element-|adventure|battle|277)/.test(s)) continue;
    slugs.add(s);
  }
  return [...slugs].sort();
}

async function scrapeCharacterPage(siteSlug) {
  const html = await fetchText(`${BASE_URL}/charaktere/${siteSlug}/`);

  // Extract all gallery images using the data attributes WordPress injects
  const images = [];
  const re = /data-orig-file="([^"]+)"[^>]*data-orig-size="(\d+),(\d+)"[^>]*data-image-title="([^"]*)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const [, url, wStr, hStr, title] = m;
    if (seen.has(url)) continue;
    seen.add(url);
    const filename = path.basename(new URL(url).pathname);
    const width = parseInt(wStr, 10), height = parseInt(hStr, 10);
    if (isWantedImage(filename, width, height)) {
      images.push({ url, filename, width, height, title });
    }
  }
  return images;
}

// ── GAME IDs (mirrors skylanders.json game names → archive game slugs) ────────

const GAME_IDS = {
  "Skylanders Spyro's Adventure": 'spyros-adventure',
  "Skylanders Giants":            'giants',
  "Skylanders Swap Force":        'swap-force',
  "Skylanders Trap Team":         'trap-team',
  "Skylanders Superchargers":     'superchargers',
  "Skylanders Imaginators":       'imaginators',
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const skylanders = JSON.parse(fs.readFileSync(SKYLANDERS_PATH, 'utf8'));
  const manifest   = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  // Build: charSlug → { name, gameId } for lookup
  const charMap = new Map();
  for (const group of skylanders) {
    const gameId = GAME_IDS[group.game];
    if (!gameId) continue;
    for (const char of group.characters) {
      const slug = SLUG_OVERRIDES[charToSlug(char.name)] || charToSlug(char.name);
      charMap.set(slug, { name: char.name, gameId });
    }
  }

  // Get all character page slugs from the site
  console.log('Fetching character list from myskylanders.wordpress.com…');
  const siteSlugs = await getCharacterPageSlugs();
  console.log(`Found ${siteSlugs.length} character pages on site.\n`);

  // Match site slugs → our character names
  let matched = siteSlugs
    .map(siteSlug => ({ siteSlug, char: charMap.get(siteSlug) || null }))
    .filter(({ char }) => char !== null);

  if (NAMES) matched = matched.filter(({ char }) => NAMES.has(char.name.toLowerCase()));
  if (LIMIT < Infinity) matched = matched.slice(0, LIMIT);

  console.log(`Processing ${matched.length} matched characters${DRY ? '  [DRY RUN]' : ''}.\n`);

  // Track newly discovered images per game for the manifest
  const newImagesByGame = {};
  let downloaded = 0, skipped = 0, failed = 0;

  for (let i = 0; i < matched.length; i++) {
    const { siteSlug, char } = matched[i];
    process.stdout.write(`[${i+1}/${matched.length}] ${char.name}… `);

    let images;
    try {
      images = await scrapeCharacterPage(siteSlug);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      failed++;
      await sleep(1000);
      continue;
    }

    const charSlug = charToSlug(char.name);
    let savedCount = 0;

    for (const img of images) {
      const variant = extractVariant(img.filename, siteSlug);
      const outFile = `character-art-${charSlug}-${variant}.png`;
      const destPath = path.join(IMAGES_DIR, outFile);

      if (fs.existsSync(destPath)) {
        skipped++;
      } else {
        if (!DRY) {
          try {
            const buf = await fetchBinary(img.url);
            const png = await sharp(buf).png({ compressionLevel: 9 }).toBuffer();
            fs.writeFileSync(destPath, png);
            await sleep(200);
          } catch (e) {
            console.log(`\n   ! ${outFile} failed: ${e.message}`);
            continue;
          }
        }
        downloaded++;
      }

      savedCount++;
      (newImagesByGame[char.gameId] ||= []).push({
        file: outFile,
        url:  img.url,
        game: char.gameId,
        category: 'official-renders',
        path: `${char.gameId}/official-renders/${outFile}`,
        skylanders: [char.name],
      });
    }

    console.log(`${images.length} artwork image(s) found, ${savedCount} tracked`);
    await sleep(600);
  }

  // ── Write manifest ──────────────────────────────────────────────────────────
  if (!DRY && Object.keys(newImagesByGame).length) {
    fs.copyFileSync(MANIFEST_PATH, `${MANIFEST_PATH}.bak-${Date.now()}`);
    let nextId = Math.max(0, ...manifest.posts.filter(p => typeof p.id === 'number' && p.id < 1000).map(p => p.id)) + 1;
    const today = new Date().toISOString().slice(0, 10);

    // Remove any existing myskylanders posts so a re-run replaces rather than duplicates
    manifest.posts = manifest.posts.filter(p => p._source !== 'myskylanders.wordpress.com');

    for (const [gameId, images] of Object.entries(newImagesByGame)) {
      const gameName = Object.keys(GAME_IDS).find(k => GAME_IDS[k] === gameId);
      manifest.posts.push({
        id: nextId++,
        type: 'photo',
        date: today,
        game: gameId,
        category: 'official-renders',
        _manual: true,
        _source: 'myskylanders.wordpress.com',
        subject: `Official character artwork for ${gameName} from myskylanders.wordpress.com`,
        tags: ['character-art', 'official'],
        text: `Official character renders sourced from myskylanders.wordpress.com — includes primary artwork plus variant editions (S2, Legendary, Dark, etc.) for ${gameName}.`,
        images,
      });
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`\nManifest updated (${Object.keys(newImagesByGame).length} game sections added/refreshed).`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done.`);
  console.log(`  Downloaded : ${downloaded} new image(s)`);
  console.log(`  Skipped    : ${skipped} already present`);
  if (failed) console.log(`  Failed     : ${failed} page(s)`);
  if (DRY) console.log('\n[DRY RUN] No files written.');
  if (!DRY && downloaded > 0) {
    console.log('\nNext step: npm run publish-archive');
    console.log('  → rebuilds skylanders-index.json so new artwork appears in the NFC card maker.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
