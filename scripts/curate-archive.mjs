#!/usr/bin/env node
/**
 * Analyses every image in the Skylanders archive and writes a `featured` flag
 * to each manifest entry. Featured images are shown by default in the NFC card
 * art picker; non-featured ones are still accessible via "show all".
 *
 * Rules applied (in order):
 *   1. Official renders (official-renders/, character-art-* filenames) → featured
 *   2. Ability icons (ability-icons/) → not featured (they serve the attack panel)
 *   3. Any image whose shortest side < MIN_PX → not featured (low-res thumbnail)
 *   4. Near-duplicate of an official render for the same character → not featured
 *      (catches "wider crop of same art" pattern common in character-page posts)
 *   5. Everything else → featured
 *
 * Usage:
 *   node scripts/curate-archive.mjs [--dry] [--force] [--char Drobot,Spyro]
 *
 *   --dry      Preview changes without writing
 *   --force    Re-evaluate images that already have a featured flag
 *   --char X   Only process these characters (comma-separated names)
 */
import sharp  from 'sharp';
import fs     from 'fs';
import path   from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO  = path.resolve(__dir, '..');

const ARCHIVE      = path.join(REPO, 'skylanders-archive');
const IMAGES_DIR   = path.join(ARCHIVE, '_images');
const MANIFEST     = path.join(ARCHIVE, 'manifest.json');
const OUT_IMG      = path.join(REPO, 'src/images/skylanders-archive');

const MIN_PX       = 280;   // shortest side threshold for low-res skip
const HASH_SIZE    = 16;    // hash grid (16×16 = 256 bits)
const DEDUP_THRESH = 18;    // hamming distance — lower = stricter (out of 256)

const args    = process.argv.slice(2);
const DRY     = args.includes('--dry');
const FORCE   = args.includes('--force');
const CHARS   = (() => {
  const i = args.indexOf('--char');
  return i >= 0 ? new Set(args[i+1].split(',').map(s => s.trim().toLowerCase())) : null;
})();

// ── Perceptual hash ───────────────────────────────────────────────────────────
// Average hash: trim whitespace → resize to HASH_SIZE² → grayscale → above-mean = 1

async function aHash(imgPath) {
  let pipe = sharp(imgPath).trim({ background: '#ffffff', threshold: 25 });
  const { data } = await pipe
    .resize(HASH_SIZE, HASH_SIZE, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const avg = data.reduce((s, v) => s + v, 0) / data.length;
  const bits = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) bits[i] = data[i] >= avg ? 1 : 0;
  return bits;
}

function hammingDist(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// ── Image path resolution ─────────────────────────────────────────────────────
// Images land in OUT_IMG after publish; _images/ is the flat store pre-publish.

function resolveImg(file) {
  // Try the published tree first (faster path for most runs after publish)
  // Fall back to _images/ flat store
  const flat = path.join(IMAGES_DIR, file);
  if (fs.existsSync(flat)) return flat;
  return null;
}

// ── Classify a single image entry ────────────────────────────────────────────

async function classify(entry, officialHashes) {
  const { file, category, game } = entry;

  // Already evaluated — skip unless --force
  if (!FORCE && typeof entry.featured === 'boolean') return null; // null = no change

  // Ability icons are not card illustrations
  if (category === 'ability-icons') return false;

  // Official renders are always featured
  if (
    category === 'official-renders' ||
    category === 'character-art'    ||
    /^character-art-/.test(file)
  ) return true;

  const imgPath = resolveImg(file);
  if (!imgPath) return false; // file missing

  let meta;
  try { meta = await sharp(imgPath).metadata(); }
  catch { return false; }

  const shortest = Math.min(meta.width ?? 0, meta.height ?? 0);

  // Low-res thumbnail
  if (shortest < MIN_PX) return false;

  // Near-duplicate of an official render for this character
  if (officialHashes.length > 0) {
    let hash;
    try { hash = await aHash(imgPath); }
    catch { return true; } // if hashing fails, err on the side of including
    for (const ref of officialHashes) {
      if (hammingDist(hash, ref) <= DEDUP_THRESH) return false;
    }
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  // Build: charName (lowercase) → [official render image paths]
  // Each image is assigned only to the characters listed in img.skylanders,
  // not to every character that appears anywhere in the same post.
  const officialPaths = {};
  for (const post of manifest.posts) {
    if (!['official-renders', 'character-art'].includes(post.category)) continue;
    for (const img of post.images ?? []) {
      const p = resolveImg(img.file);
      if (!p) continue;
      const imgChars = (img.skylanders ?? post.skylanders ?? []).map(s => s.toLowerCase());
      for (const char of imgChars) {
        (officialPaths[char] ||= []).push(p);
      }
    }
  }

  // Pre-compute hashes for official renders (cached per character)
  console.log('Pre-computing official render hashes…');
  const officialHashes = {};
  for (const [char, paths] of Object.entries(officialPaths)) {
    if (CHARS && !CHARS.has(char)) continue;
    const hashes = [];
    for (const p of paths) {
      try { hashes.push(await aHash(p)); } catch { /* skip */ }
    }
    officialHashes[char] = hashes;
  }
  console.log(`Hashed ${Object.keys(officialHashes).length} characters' official renders.\n`);

  let changed = 0, skipped = 0, total = 0;

  for (const post of manifest.posts) {
    if (!post.images?.length) continue;

    // Collect characters for this post (for dedup lookup)
    const chars = [
      ...new Set(
        post.images.flatMap(i => (i.skylanders ?? []).map(s => s.toLowerCase()))
      )
    ];

    if (CHARS && !chars.some(c => CHARS.has(c))) continue;

    // Gather official hashes for all characters in this post
    const refHashes = chars.flatMap(c => officialHashes[c] ?? []);

    for (const img of post.images) {
      total++;
      const result = await classify(img, refHashes);
      if (result === null) { skipped++; continue; }

      const prev = img.featured;
      if (!DRY) img.featured = result;
      if (result !== prev) {
        changed++;
        if (DRY) {
          const status = result ? '✓ featured' : '✗ skip';
          console.log(`  ${status}  ${img.file}`);
        }
      }
    }
  }

  if (!DRY && changed > 0) {
    fs.copyFileSync(MANIFEST, `${MANIFEST}.bak-${Date.now()}`);
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(`Updated ${changed} entries (${total - skipped} evaluated, ${skipped} already set).`);
    console.log('\nRun `npm run publish-archive` to propagate featured flags to the site.');
  } else if (DRY) {
    console.log(`\n[DRY RUN] Would update ${changed} of ${total} entries.`);
  } else {
    console.log(`Nothing changed (${skipped} already evaluated, use --force to re-run).`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
