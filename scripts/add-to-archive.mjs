#!/usr/bin/env node
/**
 * Import images into the Skylanders archive.
 *
 * The archive has two real inputs:
 *   _images/        — flat file store (every image lives here)
 *   manifest.json   — metadata index (game, category, character tags)
 *
 * The game/category folders (superchargers/, giants/, ...) are OUTPUT —
 * rebuilt from scratch each publish run. Don't put files there directly;
 * use this script to properly ingest them.
 *
 * Usage:
 *   node scripts/add-to-archive.mjs --scan [--publish]
 *     Scan all game/category folders in the archive and import any images
 *     not yet tracked in manifest.json. Use this after dropping files
 *     directly into a game/category folder.
 *
 *   node scripts/add-to-archive.mjs img1.jpg img2.jpg --game superchargers --category comic-panels [--publish]
 *     Import specific files into the given game/category.
 *
 * Options:
 *   --game NAME       Game slug (superchargers, giants, swap-force, …)
 *   --category NAME   Category slug (comic-panels, official-renders, …)
 *   --skylanders X,Y  Comma-separated character names to tag on every image
 *   --publish         Run npm run publish-archive after importing
 *   --dry             Preview what would be imported, write nothing
 */
import fs   from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO  = path.resolve(__dir, '..');

const ARCHIVE       = path.join(REPO, 'skylanders-archive');
const IMAGES_DIR    = path.join(ARCHIVE, '_images');
const MANIFEST_PATH = path.join(ARCHIVE, 'manifest.json');

const KNOWN_GAMES = new Set([
  'spyros-adventure', 'giants', 'swap-force',
  'trap-team', 'superchargers', 'imaginators',
  'battlecast', 'ring-of-heroes', 'lost-islands', 'misc',
]);

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

const args       = process.argv.slice(2);
const SCAN       = args.includes('--scan');
const DRY        = args.includes('--dry');
const DO_PUBLISH = args.includes('--publish');

function argVal(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const gameArg        = argVal('--game');
const categoryArg    = argVal('--category');
const skylandersArg  = argVal('--skylanders');

function isImage(f) {
  return IMAGE_EXTS.has(path.extname(f).toLowerCase());
}

// ── Find images to import ─────────────────────────────────────────────────────

function findCandidates(manifest) {
  const tracked = new Set(
    manifest.posts.flatMap(p => (p.images ?? []).map(i => i.file))
  );

  const candidates = [];

  if (SCAN) {
    for (const gameDir of fs.readdirSync(ARCHIVE)) {
      if (!KNOWN_GAMES.has(gameDir)) continue;
      const gamePath = path.join(ARCHIVE, gameDir);
      if (!fs.statSync(gamePath).isDirectory()) continue;

      for (const catDir of fs.readdirSync(gamePath)) {
        const catPath = path.join(gamePath, catDir);
        let stat;
        try { stat = fs.statSync(catPath); } catch { continue; }
        if (!stat.isDirectory()) continue;

        for (const file of fs.readdirSync(catPath)) {
          if (!isImage(file)) continue;
          if (tracked.has(file)) { continue; }
          candidates.push({
            srcPath: path.join(catPath, file),
            file,
            game:     gameDir,
            category: catDir,
          });
        }
      }
    }
  } else {
    if (!gameArg || !categoryArg) {
      console.error('Error: --game and --category are required when not using --scan.');
      process.exit(1);
    }
    const filePaths = args.filter(a =>
      !a.startsWith('--') && a !== gameArg && a !== categoryArg &&
      a !== skylandersArg && isImage(a) && fs.existsSync(a)
    );
    if (filePaths.length === 0) {
      console.error('Error: no valid image paths found in arguments.');
      process.exit(1);
    }
    for (const srcPath of filePaths) {
      candidates.push({ srcPath, file: path.basename(srcPath), game: gameArg, category: categoryArg });
    }
  }

  return candidates;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const candidates = findCandidates(manifest);

  if (candidates.length === 0) {
    console.log('Nothing new to import.');
    return;
  }

  // Group by game/category for display and manifest insertion
  const groups = {};
  for (const c of candidates) {
    const key = `${c.game}/${c.category}`;
    (groups[key] ||= []).push(c);
  }

  console.log(`Importing ${candidates.length} image(s)${DRY ? '  [DRY RUN]' : ''}:\n`);
  for (const [key, items] of Object.entries(groups)) {
    console.log(`  ${key}  (${items.length})`);
    for (const item of items) console.log(`    ${item.file}`);
  }

  if (DRY) return;

  // Backup manifest before any writes
  fs.copyFileSync(MANIFEST_PATH, `${MANIFEST_PATH}.bak-${Date.now()}`);

  const skylanders = skylandersArg
    ? skylandersArg.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  let nextId = Math.max(
    0,
    ...manifest.posts
      .filter(p => typeof p.id === 'number' && p.id < 1_000_000)
      .map(p => p.id)
  ) + 1;

  const today = new Date().toISOString().slice(0, 10);

  for (const [key, items] of Object.entries(groups)) {
    const [game, category] = key.split('/');
    const imageEntries = [];

    for (const item of items) {
      const dest = path.join(IMAGES_DIR, item.file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(item.srcPath, dest);
        console.log(`  copied → _images/${item.file}`);
      }
      const entry = { file: item.file, game, category, path: `${game}/${category}/${item.file}` };
      if (skylanders.length) entry.skylanders = skylanders;
      imageEntries.push(entry);
    }

    const existing = manifest.posts.find(
      p => p._manual && p.game === game && p.category === category
    );

    if (existing) {
      existing.images = [...(existing.images ?? []), ...imageEntries];
      console.log(`\nAdded ${imageEntries.length} image(s) to existing '${key}' manifest post.`);
    } else {
      manifest.posts.push({
        id: nextId++,
        type: 'photo',
        date: today,
        game,
        category,
        _manual: true,
        subject: `${category} — ${game}`,
        tags: [],
        text: '',
        images: imageEntries,
      });
      console.log(`\nCreated new '${key}' manifest post with ${imageEntries.length} image(s).`);
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('\nmanifest.json updated.');

  if (DO_PUBLISH) {
    console.log('\nRunning publish-archive…\n');
    execSync('npm run publish-archive', { cwd: REPO, stdio: 'inherit' });
  } else {
    console.log('Run `npm run publish-archive` (or `npm run import-archive -- --publish`) to sync to the site.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
