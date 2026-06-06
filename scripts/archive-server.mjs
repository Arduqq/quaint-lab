#!/usr/bin/env node
/**
 * Local curation server for the Skylanders archive.
 * Persists category reassignments and skylander tagging to manifest.json.
 *
 * Usage:
 *   node scripts/archive-server.mjs ~/Desktop/skylanders-archive
 *
 * Then open ~/Desktop/skylanders-archive/index.html in your browser.
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

// Serializes manifest reads/writes/rebuilds — reclassify-tumblr.mjs also rewrites
// manifest.json on every run, so overlapping saves + rebuilds can corrupt the file
// (two processes truncating/writing the same path at once). Chaining everything
// through one promise guarantees a save's read always sees a fully-written manifest,
// and a rebuild never starts while another write is in flight.
let manifestLock = Promise.resolve();
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
};

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
          url:    `http://localhost:${PORT}/${img.path}`,
          anns:   imgAnns,
          game:   img.game || post.game,
          file:   img.file,
          postId: String(post.id),
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
        const { postId, imageFile, game, category, skylanders, annotations } = JSON.parse(body);
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
          post.game      = game      ?? post.game;
          post.category  = category  ?? post.category;
          post._manual   = true;
          for (const img of (post.images ?? [])) {
            if (img.error || !img.file) continue;
            img.game     = post.game;
            img.category = post.category;
            img.path     = `${post.game}/${post.category}/${img.file}`;
          }
          console.log(`Reclassified post ${postId} → ${post.game}/${post.category}`);
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

  // Static file serving (images, index.html, etc.)
  const safePath = decodeURIComponent(url.pathname);
  const filePath = path.join(archiveDir, safePath === '/' ? 'index.html' : safePath);

  if (!filePath.startsWith(archiveDir + path.sep) && filePath !== archiveDir) {
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
