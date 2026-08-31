#!/usr/bin/env node
/**
 * Visits each Skylander's wiki page once and harvests two things from it:
 *
 *   1. Characteristics (species / gender / role) from the page's infobox —
 *      written directly into src/_data/skylanders.json so the NFC card tool
 *      can use them.
 *   2. Ability & upgrade icon images (primary/secondary power, Soul Gem,
 *      Wow Pow, basic/path upgrades, Hero Abilities) from the "Abilities"
 *      section — downloaded into the local archive under a new
 *      "ability-icons" category, mirroring how character-art was added.
 *
 * The wiki sits behind Cloudflare's JS challenge — a bare fetch() gets a
 * "Just a moment..." page. A real browser context with a multi-second wait
 * clears it; rapid-fire requests on one context get re-challenged, so each
 * character gets a fresh context plus a politeness pause.
 *
 * Usage:
 *   node scripts/scrape-character-data.mjs [--dry] [--limit N] [--start N]
 *
 *   --dry     Scrape and report, but write nothing (no JSON edits, no downloads)
 *   --limit N Only process N characters (for testing)
 *   --start N Skip the first N characters (for resuming a partial run)
 */
import { chromium } from '/private/tmp/node_modules/playwright/index.mjs';
import sharp from 'sharp';
import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO  = path.resolve(__dir, '..');

const ARCHIVE        = path.join(REPO, 'skylanders-archive');
const IMAGES_DIR     = path.join(ARCHIVE, '_images');
const MANIFEST_PATH  = path.join(ARCHIVE, 'manifest.json');
const SKYLANDERS_PATH = path.join(REPO, 'src/_data/skylanders.json');

const args  = process.argv.slice(2);
const DRY   = args.includes('--dry');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : Infinity; })();
const START = (() => { const i = args.indexOf('--start'); return i >= 0 ? parseInt(args[i + 1], 10) : 0; })();
const NAMES = (() => {
  const i = args.indexOf('--names');
  if (i < 0) return null;
  return new Set(args[i + 1].split(',').map(s => s.trim().toLowerCase()));
})();

// A few characters' wiki page titles don't match their in-game display name
// (verified by hand after the initial run 404'd on the derived slug).
const URL_OVERRIDES = {
  'jet vac': 'Jet-Vac',
  'riptide': 'Rip Tide',
};

// The wiki labels elements "Air"/"Life"; the site's badge sprites and filters
// use "wind"/"nature" — map wiki labels onto the site's element slugs.
const ELEMENT_MAP = {
  fire: 'fire', water: 'water', earth: 'earth', air: 'wind',
  magic: 'magic', life: 'nature', undead: 'undead', tech: 'tech',
  light: 'light', dark: 'dark',
};

const GAME_IDS = {
  "Skylanders Spyro's Adventure": 'spyros-adventure',
  "Skylanders Giants":            'giants',
  "Skylanders Swap Force":        'swap-force',
  "Skylanders Trap Team":         'trap-team',
  "Skylanders Superchargers":     'superchargers',
  "Skylanders Imaginators":       'imaginators',
};

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const wikiUrl = name => {
  const title = URL_OVERRIDES[name.toLowerCase()] || name;
  return `https://skylanders.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
};

// "Drobotprimarypower.png" + "Drobot" → "primarypower"; falls back to the
// full normalised name if the character-name prefix isn't there verbatim.
function abilityKind(dataImageName, charName) {
  const base = dataImageName.replace(/\.(png|jpe?g|gif|webp)$/i, '');
  const baseNorm = base.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nameNorm = charName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const rest = baseNorm.startsWith(nameNorm) ? baseNorm.slice(nameNorm.length) : baseNorm;
  return rest || 'icon';
}

async function fetchImage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept': 'image/png,image/webp,image/*;q=0.8',
      'Referer': 'https://skylanders.fandom.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Loads one character's page in a fresh context, waits out Cloudflare's
// challenge, then pulls characteristics + Abilities-section image links.
async function scrapeCharacterPage(browser, name) {
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();
  try {
    const resp = await page.goto(wikiUrl(name), { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (resp && resp.status() >= 400) throw new Error(`HTTP ${resp.status()}`);

    await page.waitForTimeout(8000);
    for (let tries = 0; tries < 3; tries++) {
      const title = await page.title();
      if (!/Just a moment|Attention Required|Checking your browser/i.test(title)) break;
      await page.waitForTimeout(6000);
    }

    return await page.evaluate(() => {
      const out = { characteristics: {}, abilityImages: [] };

      const infobox = document.querySelector('.portable-infobox');
      if (infobox) {
        for (const key of ['species', 'gender', 'role']) {
          const el = infobox.querySelector(`[data-source="${key}"] .pi-data-value`);
          if (el) out.characteristics[key] = el.textContent.trim();
        }
        // Element is rendered as a symbol — its name lives in the link/image,
        // not the visible text (which is just the "Element:" label).
        const elVal = infobox.querySelector('[data-source="element"] .pi-data-value');
        if (elVal) {
          const link = elVal.querySelector('a[title]');
          const img  = elVal.querySelector('img[alt]');
          const name = (link && link.title) || (img && img.alt);
          if (name) out.characteristics.element = name.trim();
        }
      }

      const headings = Array.from(document.querySelectorAll('h2, h3'));
      // Some pages misspell the heading ("Abilties" — missing the "i" before
      // "ties"), so a strict "Abilit" prefix match isn't enough. Match
      // "Abil" + optional letters + "t" instead, which covers both spellings.
      const abilitiesHeading = headings.find(h =>
        /^abil\w*t/i.test(h.textContent.trim().replace(/\[edit\]/i, '').trim()));
      if (abilitiesHeading) {
        let cur = abilitiesHeading;
        while (cur && !['H2', 'H3'].includes(cur.tagName)) cur = cur.parentElement;
        let node = cur ? cur.nextElementSibling : null;
        const seen = new Set();
        let guard = 0;
        while (node && guard++ < 80) {
          if (['H2', 'H3'].includes(node.tagName)) break;
          node.querySelectorAll('img').forEach(img => {
            const dataName = img.getAttribute('data-image-name');
            if (!dataName || seen.has(dataName)) return;
            seen.add(dataName);
            // The <a> wrapper points at the full-resolution image; the <img>
            // itself is often a small `scale-to-width-down` thumbnail.
            const a = img.closest('a');
            out.abilityImages.push({
              name: dataName,
              url: (a && a.href) || img.getAttribute('data-src') || img.src,
            });
          });
          node = node.nextElementSibling;
        }
      }
      return out;
    });
  } finally {
    await context.close();
  }
}

async function main() {
  const skylanders = JSON.parse(fs.readFileSync(SKYLANDERS_PATH, 'utf8'));
  const manifest   = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

  const entries = [];
  for (const group of skylanders) {
    const gameId = GAME_IDS[group.game];
    if (!gameId) { console.warn(`! Unknown game "${group.game}" — skipping its characters`); continue; }
    for (const char of group.characters) entries.push({ char, game: group.game, gameId, idx: entries.length });
  }

  let slice = entries.slice(START, LIMIT === Infinity ? undefined : START + LIMIT);
  if (NAMES) slice = slice.filter(({ char }) => NAMES.has(char.name.toLowerCase()));
  console.log(`Scraping ${slice.length} of ${entries.length} characters (start=${START})${NAMES ? ` [filtered to ${NAMES.size} named character(s)]` : ''}${DRY ? '  [DRY RUN — nothing will be written]' : ''}\n`);

  const browser = await chromium.launch();
  const failed  = [];
  const missing = [];
  const newImagesByGame = {};
  let downloaded = 0, skippedExisting = 0;

  for (let i = 0; i < slice.length; i++) {
    const { char, gameId, idx } = slice[i];
    process.stdout.write(`[${idx + 1}/${entries.length}] ${char.name}... `);

    let scraped;
    try {
      scraped = await scrapeCharacterPage(browser, char.name);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      failed.push({ name: char.name, error: e.message });
      await sleep(4000);
      continue;
    }

    const got = [];
    for (const key of ['species', 'gender', 'role']) {
      const val = scraped.characteristics[key];
      if (val) { char[key] = val; got.push(key); }
    }
    const elRaw = scraped.characteristics.element;
    const elMapped = elRaw && ELEMENT_MAP[elRaw.toLowerCase()];
    if (elMapped) { char.element = elMapped; got.push('element'); }
    else if (elRaw) { console.log(`\n   ! unknown element "${elRaw}" for ${char.name} — please map it manually`); }

    const lacking = ['species', 'gender', 'role', 'element'].filter(k => !(k === 'element' ? elMapped : scraped.characteristics[k]));
    if (lacking.length) missing.push({ name: char.name, missing: lacking });

    const slug = slugify(char.name);
    let savedForChar = 0;
    for (const img of scraped.abilityImages) {
      const kind = abilityKind(img.name, char.name);
      const file = `ability-${slug}-${kind}.png`;
      const dest = path.join(IMAGES_DIR, file);

      if (!fs.existsSync(dest)) {
        if (!DRY) {
          try {
            const buf = await fetchImage(img.url);
            const png = await sharp(buf).png({ compressionLevel: 9 }).toBuffer();
            fs.writeFileSync(dest, png);
            await sleep(180);
          } catch (e) {
            console.log(`\n   ! ${file} failed: ${e.message}`);
            continue;
          }
        }
        downloaded++;
      } else {
        skippedExisting++;
      }
      savedForChar++;
      (newImagesByGame[gameId] ||= []).push({
        file, url: img.url, game: gameId, category: 'ability-icons',
        path: `${gameId}/ability-icons/${file}`,
        skylanders: [char.name.toLowerCase()],
      });
    }

    console.log(`${got.length ? got.join('/') : 'no characteristics'}, ${savedForChar} ability icons`);
    await sleep(4000);
  }

  await browser.close();

  if (!DRY) {
    fs.copyFileSync(SKYLANDERS_PATH, `${SKYLANDERS_PATH}.bak-${Date.now()}`);
    fs.writeFileSync(SKYLANDERS_PATH, `${JSON.stringify(skylanders, null, 2)}\n`);
  }

  if (!DRY && Object.keys(newImagesByGame).length) {
    fs.copyFileSync(MANIFEST_PATH, `${MANIFEST_PATH}.bak-${Date.now()}`);
    let nextId = Math.max(0, ...manifest.posts.filter(p => typeof p.id === 'number' && p.id < 1000).map(p => p.id)) + 1;
    const today = new Date().toISOString().slice(0, 10);
    for (const [gameId, images] of Object.entries(newImagesByGame)) {
      const gameName = Object.keys(GAME_IDS).find(k => GAME_IDS[k] === gameId);
      const text = `Official ability & upgrade icons (primary/secondary powers, Soul Gem, Wow Pow, upgrade paths, Hero Abilities) sourced from each Skylander's wiki page, for ${gameName}.`;
      manifest.posts.push({
        id: nextId++, type: 'photo', date: today, game: gameId, category: 'ability-icons',
        _manual: true, subject: text.slice(0, 60), tags: ['ability-icons'],
        annotations: ['attack'], text, images,
      });
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done. ${downloaded} new ability icon(s) downloaded, ${skippedExisting} already present.`);

  if (failed.length) {
    console.log(`\n${failed.length} page(s) failed to load — check these manually:`);
    failed.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
  }
  if (missing.length) {
    console.log(`\n${missing.length} character(s) missing characteristic field(s) — please check & fill in manually:`);
    missing.forEach(m => console.log(`  - ${m.name}: missing ${m.missing.join(', ')}`));
  }
  if (DRY) console.log('\n[DRY RUN] No files were written.');
}

main();
