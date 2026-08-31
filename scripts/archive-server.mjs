#!/usr/bin/env node
/**
 * Local curation server for the Skylanders archive.
 * Persists category reassignments and skylander tagging to manifest.json.
 *
 * Usage:
 *   node scripts/archive-server.mjs ./skylanders-archive
 *
 * Then open ./skylanders-archive/index.html in your browser.
 * Use the ✎ Edit button in the image lightbox to reassign categories or
 * tag images with a Skylander's name.
 *
 * After making changes, run reclassify-tumblr.mjs to rebuild file links
 * and regenerate index.html with the updated data.
 */
import http        from 'http';
import fs          from 'fs';
import path        from 'path';
import { spawn }   from 'child_process';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO  = path.join(__dir, '..');

const PORT = 7373;
const archiveDir = process.argv[2] ? path.resolve(process.argv[2]) : null;

if (!archiveDir) {
  console.error('Usage: node scripts/archive-server.mjs <archive-dir>');
  process.exit(1);
}
const manifestPath = path.join(archiveDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`No manifest.json found in ${archiveDir}`);
  process.exit(1);
}
const SKYLANDERS_PATH = path.join(__dir, '../src/_data/skylanders.json');
const MODELS_PATH = path.join(__dir, '../src/pages/server/skylanders/models/models.json');

// Serializes manifest reads/writes/rebuilds — reclassify-tumblr.mjs also rewrites
// manifest.json on every run, so overlapping saves + rebuilds can corrupt the file
// (two processes truncating/writing the same path at once). Chaining everything
// through one promise guarantees a save's read always sees a fully-written manifest,
// and a rebuild never starts while another write is in flight.
let manifestLock = Promise.resolve();
let skyJsonLock  = Promise.resolve();
let modelsJsonLock = Promise.resolve();
let rebuildTimer = null;

function runRebuild() {
  return new Promise(resolve => {
    const child = spawn('node', [path.join(__dir, 'reclassify-tumblr.mjs'), archiveDir], { stdio: 'ignore' });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

// Debounced — a burst of rapid saves (e.g. batch tagging) collapses into a single
// trailing rebuild instead of one per save. Chained onto manifestLock so it can
// only run once all currently-queued manifest writes have landed.
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    manifestLock = manifestLock.then(() => runRebuild());
  }, 600);
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.js':   'text/javascript; charset=utf-8',
  '.obj':  'text/plain; charset=utf-8',
};
const MIME_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/gif': '.gif', 'image/webp': '.webp',
};

// Filename → safe slug for the _images/ store (mirrors reclassify-tumblr.mjs's slugify)
function sanitizeBase(name) {
  const noExt = name.replace(/\.[^.]+$/, '');
  return noExt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 48) || 'image';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // Health check (lets the edit UI detect whether the server is running)
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Image index used by the NFC card creator
  // Returns { byCharacter: { name: [img] }, backgrounds: [img], details: [img] }
  if (url.pathname === '/api/skylanders-index') {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const byCharacter = {};
    const backgrounds = [];
    const details = [];

    for (const post of manifest.posts) {
      const postAnns = post.annotations || [];
      for (const img of (post.images || [])) {
        if (img.error || !img.file || !img.path) continue;
        const imgAnns = img.annotations?.length ? img.annotations : postAnns;
        const entry = {
          url:      `http://localhost:${PORT}/${img.path}`,
          anns:     imgAnns,
          game:     img.game || post.game,
          file:     img.file,
          postId:   String(post.id),
          featured: img.featured !== false,
        };

        // Background / detail buckets — include all annotated images regardless of character tag
        if (imgAnns.includes('background')) backgrounds.push(entry);
        if (imgAnns.includes('detail'))     details.push(entry);

        // Per-character art (any tagged image)
        const skyNames = Array.isArray(img.skylanders) ? img.skylanders : (post.skylanders || []);
        for (const name of skyNames) {
          const key = name.toLowerCase();
          (byCharacter[key] = byCharacter[key] || []).push(entry);
        }
      }
    }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ byCharacter, backgrounds, details }));
    return;
  }

  // Mutation endpoint
  if (url.pathname === '/api/update' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      manifestLock = manifestLock.then(() => new Promise(done => {
      try {
        const { postId, imageFile, game, category, skylanders, annotations, featured, source } = JSON.parse(body);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const post = manifest.posts.find(p => String(p.id) === String(postId));

        if (!post) {
          res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Post ${postId} not found` }));
          done();
          return;
        }

        let changed = false;

        // Category reassignment — sets _manual flag so reclassify preserves it
        if (game !== undefined || category !== undefined) {
          const images = (post.images ?? []).filter(i => !i.error && i.file);
          const targetImg = imageFile ? images.find(i => i.file === imageFile) : null;

          if (targetImg && images.length > 1) {
            // Multi-image post — reclassify only the edited image, leaving the
            // rest of the post (and its other images) where they are.
            targetImg.game     = game     ?? targetImg.game     ?? post.game;
            targetImg.category = category ?? targetImg.category ?? post.category;
            targetImg.path     = `${targetImg.game}/${targetImg.category}/${targetImg.file}`;
            targetImg._manual  = true;
            console.log(`Reclassified post ${postId} image ${imageFile} → ${targetImg.game}/${targetImg.category}`);
          } else {
            post.game      = game      ?? post.game;
            post.category  = category  ?? post.category;
            post._manual   = true;
            for (const img of images) {
              img.game     = post.game;
              img.category = post.category;
              img.path     = `${post.game}/${post.category}/${img.file}`;
              delete img._manual;
            }
            console.log(`Reclassified post ${postId} → ${post.game}/${post.category}`);
          }
          changed = true;
        }

        // Skylander name tagging — per-image when imageFile provided, else post-level
        if (skylanders !== undefined) {
          if (imageFile) {
            const imgEntry = (post.images ?? []).find(i => i.file === imageFile);
            if (imgEntry) {
              imgEntry.skylanders = skylanders;
              console.log(`Tagged post ${postId} image ${imageFile} skylanders: [${skylanders.join(', ')}]`);
            } else {
              console.warn(`Tagged post ${postId}: image ${imageFile} not found, falling back to post-level`);
              post.skylanders = skylanders;
            }
          } else {
            post.skylanders = skylanders;
            console.log(`Tagged post ${postId} skylanders: [${skylanders.join(', ')}]`);
          }
          changed = true;
        }

        // Annotations (background, detail, etc.)
        if (annotations !== undefined) {
          post.annotations = annotations;
          console.log(`Annotated post ${postId}: [${annotations.join(', ')}]`);
          changed = true;
        }

        // Featured flag — per-image, drives the NFC card art picker's default set
        if (featured !== undefined) {
          const imgEntry = (post.images ?? []).find(i => i.file === imageFile);
          if (imgEntry) {
            imgEntry.featured = featured;
            console.log(`Set post ${postId} image ${imageFile} featured: ${featured}`);
            changed = true;
          }
        }

        // Source URL — per-image, editable override for the lightbox's source link
        if (source !== undefined) {
          const imgEntry = (post.images ?? []).find(i => i.file === imageFile);
          if (imgEntry) {
            imgEntry.source = source;
            console.log(`Set post ${postId} image ${imageFile} source: ${source}`);
            changed = true;
          }
        }

        if (changed) {
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
          scheduleRebuild(); // refreshes index.html so a page reload shows fresh data
        }

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Update error:', e.message);
        try {
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {}
      } finally {
        done();
      }
      }));
    });
    return;
  }

  // Soft-delete endpoint — moves the image file into _removed/ and drops its
  // entry from the manifest, so it disappears from the archive UI but stays
  // recoverable on disk if removed by mistake.
  if (url.pathname === '/api/remove-image' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      manifestLock = manifestLock.then(() => new Promise(done => {
      try {
        const { postId, imageFile } = JSON.parse(body);
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const post = manifest.posts.find(p => String(p.id) === String(postId));

        if (!post) {
          res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Post ${postId} not found` }));
          done();
          return;
        }

        const idx = (post.images ?? []).findIndex(i => i.file === imageFile);
        if (idx === -1) {
          res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Image ${imageFile} not found on post ${postId}` }));
          done();
          return;
        }

        const [img] = post.images.splice(idx, 1);

        const src = path.join(archiveDir, img.path);
        if (fs.existsSync(src)) {
          const removedDir = path.join(archiveDir, '_removed');
          fs.mkdirSync(removedDir, { recursive: true });
          fs.renameSync(src, path.join(removedDir, `${postId}_${img.file}`));
        }

        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`Removed image ${imageFile} from post ${postId} (moved to _removed/)`);
        scheduleRebuild();

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Remove-image error:', e.message);
        try {
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {}
      } finally {
        done();
      }
      }));
    });
    return;
  }

  // Roster character edit endpoint — updates src/_data/skylanders.json
  if (url.pathname === '/api/update-character' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      skyJsonLock = skyJsonLock.then(() => new Promise(done => {
      try {
        const { name, element, species, gender, role, owned, level, favorite, extra, render, figures, abilityIcons, variants } = JSON.parse(body);
        const data = JSON.parse(fs.readFileSync(SKYLANDERS_PATH, 'utf8'));
        let found = null;
        for (const g of data) {
          found = (g.characters ?? []).find(c => c.name === name);
          if (found) break;
        }

        if (!found) {
          res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Character ${name} not found` }));
          done();
          return;
        }

        if (element  !== undefined) found.element  = element;
        if (species  !== undefined) found.species  = species;
        if (gender   !== undefined) found.gender   = gender;
        if (role     !== undefined) found.role     = role;
        if (owned    !== undefined) found.owned    = owned;
        if (level    !== undefined) found.level    = level;
        if (favorite !== undefined) found.favorite = favorite;
        if (extra    !== undefined) found.extra    = extra;
        if (render       !== undefined) found.render       = render;
        if (figures      !== undefined) found.figures      = figures;
        if (abilityIcons !== undefined) found.abilityIcons = abilityIcons;
        if (variants     !== undefined) found.variants     = variants;

        fs.writeFileSync(SKYLANDERS_PATH, JSON.stringify(data, null, 2));
        console.log(`Updated character ${name}`);
        scheduleRebuild(); // refreshes index.html so a page reload shows fresh data

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Update-character error:', e.message);
        try {
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {}
      } finally {
        done();
      }
      }));
    });
    return;
  }

  // Dashboard builder layout — persists the per-game block order (category
  // cards + custom link/text blocks) edited via the "Edit dashboard" UI.
  // An empty layout[] removes the saved override so the dashboard falls
  // back to its auto-generated default.
  if (url.pathname === '/api/dashboard-layout' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      manifestLock = manifestLock.then(() => new Promise(done => {
        try {
          const { game, layout } = JSON.parse(body);
          if (!game || !Array.isArray(layout)) throw new Error('game and layout[] required');
          const layoutPath = path.join(archiveDir, 'dashboard-layout.json');
          const all = fs.existsSync(layoutPath) ? JSON.parse(fs.readFileSync(layoutPath, 'utf8')) : {};
          if (layout.length) all[game] = layout; else delete all[game];
          fs.writeFileSync(layoutPath, JSON.stringify(all, null, 2));
          console.log(`Saved dashboard layout for ${game} (${layout.length} blocks)`);
          scheduleRebuild();
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('Dashboard layout update error:', e.message);
          try {
            res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          } catch {}
        } finally {
          done();
        }
      }));
    });
    return;
  }

  // Model icon/texture override endpoint — curation-only (omitted from the
  // --publish copy of the archive). Sets or clears the `icon`/`texture`
  // field on a single models.json entry, identified by its LI-M-### id.
  if (url.pathname === '/api/update-model' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      modelsJsonLock = modelsJsonLock.then(() => new Promise(done => {
      try {
        const { id, field, value } = JSON.parse(body);
        if (!id || (field !== 'icon' && field !== 'texture')) {
          res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id and field (icon|texture) are required' }));
          done();
          return;
        }

        const models = JSON.parse(fs.readFileSync(MODELS_PATH, 'utf8'));
        const entry = models.find(m => m.id === id);
        if (!entry) {
          res.writeHead(404, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Model ${id} not found` }));
          done();
          return;
        }

        if (value) entry[field] = value;
        else delete entry[field];

        fs.writeFileSync(MODELS_PATH, JSON.stringify(models, null, 1) + '\n');
        console.log(`Updated model ${id}: ${field} = ${value || '(cleared)'}`);

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        console.error('Update-model error:', e.message);
        try {
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {}
      } finally {
        done();
      }
      }));
    });
    return;
  }

  // Add-image endpoint — drops new file(s) into _images/ + game/category/,
  // and registers each as its own manual post in the manifest.
  if (url.pathname === '/api/add-image' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      manifestLock = manifestLock.then(() => new Promise(done => {
      try {
        const { game, category: rawCategory, files, skylanders } = JSON.parse(body);
        const category = String(rawCategory || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        if (!game || !category) {
          res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'game and category are required' }));
          done(); return;
        }
        if (!Array.isArray(files) || !files.length) {
          res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No files provided' }));
          done(); return;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const imgStore = path.join(archiveDir, '_images');
        const destDir  = path.join(archiveDir, game, category);
        fs.mkdirSync(imgStore, { recursive: true });
        fs.mkdirSync(destDir, { recursive: true });

        const date = new Date().toISOString().slice(0, 10);
        const added = [];

        files.forEach((f, i) => {
          const m = /^data:([^;]+);base64,(.+)$/.exec(f.dataUrl || '');
          if (!m) return;
          const buf  = Buffer.from(m[2], 'base64');
          const ext  = MIME_EXT[m[1]] || path.extname(f.name || '').toLowerCase() || '.png';
          const base = sanitizeBase(f.name || 'image');
          const ts   = Date.now();
          const filename = `manual-${ts}-${i}-${base}${ext}`;

          fs.writeFileSync(path.join(imgStore, filename), buf);
          try { fs.linkSync(path.join(imgStore, filename), path.join(destDir, filename)); }
          catch { fs.copyFileSync(path.join(imgStore, filename), path.join(destDir, filename)); }

          const subject = base.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          const postId  = `manual-${ts}-${i}`;
          const imgPath = `${game}/${category}/${filename}`;

          manifest.posts.push({
            id: postId, type: 'photo', date, game, category, subject,
            tags: [], text: '',
            images: [{
              file: filename, url: '', game, category, path: imgPath, featured: true,
              ...(Array.isArray(skylanders) && skylanders.length ? { skylanders } : {}),
            }],
            url: '', annotations: [], _manual: true,
          });

          added.push({ postId, imageFile: filename, path: imgPath, date, subject });
        });

        if (!added.length) {
          res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No valid images decoded' }));
          done(); return;
        }

        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        console.log(`Added ${added.length} image(s) to ${game}/${category}`);
        scheduleRebuild();

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, added }));
      } catch (e) {
        console.error('Add-image error:', e.message);
        try {
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } catch {}
      } finally {
        done();
      }
      }));
    });
    return;
  }

  // Publish endpoint — runs reclassify-tumblr.mjs --publish, which re-sorts the
  // archive, regenerates the site's archive page, and syncs images into
  // src/images/skylanders-archive/. Chained onto manifestLock so it waits for
  // any in-flight saves and a pending debounced rebuild doesn't run redundantly after it.
  if (url.pathname === '/api/publish' && req.method === 'POST') {
    clearTimeout(rebuildTimer);
    manifestLock = manifestLock.then(() => new Promise(done => {
      const child = spawn('node', [path.join(__dir, 'reclassify-tumblr.mjs'), archiveDir, '--publish'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', d => (output += d));
      child.stderr.on('data', d => (output += d));
      child.on('exit', code => {
        try {
          if (code === 0) {
            console.log('Publish complete.');
            res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } else {
            console.error('Publish failed:', output.slice(-2000));
            res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `Publish exited with code ${code}`, output: output.slice(-2000) }));
          }
        } catch {}
        done();
      });
      child.on('error', e => {
        try {
          res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        } catch {}
        done();
      });
    }));
    return;
  }

  // Static file serving (images, index.html, etc.)
  const safePath = decodeURIComponent(url.pathname);

  // The embedded 3D model viewer fetches its data/JS/assets from these two
  // absolute paths regardless of where the page is served from. On the
  // built site they're passthrough-copied to dist/, but this curation
  // server only serves files under archiveDir — so resolve them against the
  // repo's src/ instead rather than duplicating ~200MB of model data into
  // skylanders-archive/.
  let baseDir = archiveDir;
  let relPath = safePath === '/' ? 'index.html' : safePath;
  if (safePath.startsWith('/server/skylanders/models/')) {
    baseDir = path.join(REPO, 'src/pages/server/skylanders/models');
    relPath = safePath.slice('/server/skylanders/models/'.length);
  } else if (safePath.startsWith('/models/')) {
    baseDir = path.join(REPO, 'src/models');
    relPath = safePath.slice('/models/'.length);
  } else if (safePath.startsWith('/images/skylanders-archive/')) {
    // Texture thumbnails in the embedded model viewer reference this
    // absolute path, which on the built site is the published copy of
    // archiveDir under src/images/ — here it's just archiveDir itself.
    relPath = safePath.slice('/images/skylanders-archive/'.length);
  }
  const filePath = path.join(baseDir, relPath);

  if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) { res.writeHead(403); res.end('Directory listing disabled'); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { ...CORS, 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nSkylanders Archive Curation Server`);
  console.log(`───────────────────────────────────`);
  console.log(`Listening on  http://localhost:${PORT}`);
  console.log(`Archive dir:  ${archiveDir}\n`);
  console.log(`Open ${path.join(archiveDir, 'index.html')} in your browser.`);
  console.log(`Click ✎ Edit in the lightbox to reassign categories or tag Skylanders.`);
  console.log(`\nWhen done, run:`);
  console.log(`  node scripts/reclassify-tumblr.mjs ${archiveDir}`);
  console.log(`to rebuild the file structure and refresh index.html.\n`);
});
