#!/usr/bin/env node
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT   = path.resolve(__dirname, '..');
const PUBLIC = path.join(__dirname, 'public');
const PORT   = 3001;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function send(res, status, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const ct   = typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
  res.writeHead(status, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(body);
}

function parseBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try   { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
  });
}

function safeAbs(rel) {
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error('Path traversal blocked');
  return abs;
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

function parseFM(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)/);
  if (!m) return { data: {}, body: raw };
  const data = {};
  let arrKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^  - /.test(line)) {
      if (arrKey) data[arrKey].push(line.replace(/^  - /, '').trim());
      continue;
    }
    arrKey = null;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const k   = line.slice(0, ci).trim();
    const raw2 = line.slice(ci + 1).trim();
    if (!raw2) {
      arrKey = k; data[k] = [];
    } else if (raw2.startsWith('[') && raw2.endsWith(']')) {
      data[k] = raw2.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else if (raw2 === 'true')  { data[k] = true;  }
    else if (raw2 === 'false') { data[k] = false; }
    else if (raw2 !== '' && !isNaN(raw2)) { data[k] = Number(raw2); }
    else { data[k] = raw2.replace(/^["']|["']$/g, ''); }
  }
  return { data, body: (m[2] || '').trim() };
}

function dumpFM(data) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean')     { if (v) lines.push(`${k}: true`); }
    else if (typeof v === 'number') { lines.push(`${k}: ${v}`); }
    else if (Array.isArray(v)) {
      if (!v.length) continue;
      if (v.length === 1) {
        lines.push(`${k}: ${v[0]}`);
      } else {
        lines.push(`${k}:`);
        v.forEach(i => lines.push(`  - ${i}`));
      }
    } else {
      const s = String(v);
      const q = /[:#\[\]{},|>&*!'"@`%]/.test(s) || /^\s|\s$/.test(s);
      lines.push(q ? `${k}: "${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : `${k}: ${s}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ─── Post directories ─────────────────────────────────────────────────────────

const POST_ROOTS = {
  writing: path.join(ROOT, 'src/posts/writing'),
  games:   path.join(ROOT, 'src/posts/games'),
  artwork: path.join(ROOT, 'src/posts/artwork'),
  pets:    path.join(ROOT, 'src/posts/pets'),
};

function scanPosts(type) {
  const root = POST_ROOTS[type];
  if (!root || !fs.existsSync(root)) return [];
  const results = [];
  const walk = (dir, series) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, e.name); continue; }
      if (!e.name.endsWith('.md')) continue;
      const { data, body } = parseFM(fs.readFileSync(fp, 'utf-8'));
      results.push({
        file:    path.relative(ROOT, fp).replace(/\\/g, '/'),
        slug:    e.name.replace('.md', ''),
        series:  series || null,
        title:   data.posttitle || data.title || e.name,
        date:    data.date   || null,
        draft:   data.draft  || false,
        image:   data.image  || null,
        excerpt: data.excerpt || data.comment || null,
        data,
        body,
      });
    }
  };
  walk(root, null);
  results.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return new Date(b.date) - new Date(a.date);
  });
  return results;
}

// ─── API handlers ─────────────────────────────────────────────────────────────

async function handleAPI(method, pathname, params, req, res) {
  // GET /api/posts?type=…
  if (method === 'GET' && pathname === '/api/posts') {
    return send(res, 200, scanPosts(params.type));
  }

  // GET /api/post?file=…
  if (method === 'GET' && pathname === '/api/post') {
    if (!params.file) return send(res, 400, { error: 'Missing file' });
    const abs = safeAbs(params.file);
    if (!fs.existsSync(abs)) return send(res, 404, { error: 'Not found' });
    return send(res, 200, parseFM(fs.readFileSync(abs, 'utf-8')));
  }

  // POST /api/post  { type, slug, series?, data, content }
  if (method === 'POST' && pathname === '/api/post') {
    const { type, slug, series, data, content } = await parseBody(req);
    if (!type || !slug || !POST_ROOTS[type]) return send(res, 400, { error: 'Bad request' });
    const dir = series ? path.join(POST_ROOTS[type], series) : POST_ROOTS[type];
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `${slug}.md`);
    if (fs.existsSync(fp)) return send(res, 409, { error: 'File already exists' });
    fs.writeFileSync(fp, `${dumpFM(data)}\n\n${content || ''}\n`);
    return send(res, 201, { file: path.relative(ROOT, fp).replace(/\\/g, '/') });
  }

  // PUT /api/post  { file, data, content, newSlug? }
  if (method === 'PUT' && pathname === '/api/post') {
    const { file, data, content, newSlug } = await parseBody(req);
    if (!file) return send(res, 400, { error: 'Missing file' });
    const abs = safeAbs(file);

    let targetAbs  = abs;
    let finalData  = data;
    if (newSlug && newSlug !== path.basename(abs, '.md')) {
      const newAbs = path.join(path.dirname(abs), `${newSlug}.md`);
      if (fs.existsSync(newAbs)) return send(res, 409, { error: 'Slug already taken' });
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      targetAbs = newAbs;

      // Rename image + thumbnail to match new slug
      if (data.image) {
        const ext        = path.extname(data.image);
        const newImgName = `${newSlug}${ext}`;
        const imgDir     = path.join(ROOT, 'src/images/artwork');
        const thumbDir   = path.join(imgDir, 'thumbnails');
        const oldImg     = path.join(imgDir, data.image);
        const newImg     = path.join(imgDir, newImgName);
        if (fs.existsSync(oldImg)) fs.renameSync(oldImg, newImg);
        const oldThumb   = path.join(thumbDir, data.image);
        const newThumb   = path.join(thumbDir, newImgName);
        if (fs.existsSync(oldThumb)) fs.renameSync(oldThumb, newThumb);
        finalData = { ...data, image: newImgName };
      }
    }

    fs.writeFileSync(targetAbs, `${dumpFM(finalData)}\n\n${content || ''}\n`);
    return send(res, 200, { ok: true, file: path.relative(ROOT, targetAbs).replace(/\\/g, '/') });
  }

  // DELETE /api/post?file=…
  if (method === 'DELETE' && pathname === '/api/post') {
    if (!params.file) return send(res, 400, { error: 'Missing file' });
    const abs = safeAbs(params.file);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
    return send(res, 200, { ok: true });
  }

  // GET /api/images?folder=…
  if (method === 'GET' && pathname === '/api/images') {
    if (!params.folder) return send(res, 400, { error: 'Missing folder' });
    const dir = safeAbs(params.folder);
    if (!fs.existsSync(dir)) return send(res, 200, []);
    const files = fs.readdirSync(dir).filter(f => /\.(png|jpe?g|gif|svg|webp)$/i.test(f));
    return send(res, 200, files);
  }

  // POST /api/image  { folder, name, data(base64) }
  if (method === 'POST' && pathname === '/api/image') {
    const { folder, name, data: b64 } = await parseBody(req);
    if (!folder || !name || !b64) return send(res, 400, { error: 'Missing fields' });
    const dir = safeAbs(folder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64'));
    const webPath = '/' + folder.replace(/^src\//, '') + '/' + name;
    return send(res, 201, { path: webPath, name });
  }

  // GET /api/series?type=artwork
  if (method === 'GET' && pathname === '/api/series') {
    const root = POST_ROOTS[params.type];
    if (!root || !fs.existsSync(root)) return send(res, 200, []);
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
    return send(res, 200, dirs);
  }

  // POST /api/build
  if (method === 'POST' && pathname === '/api/build') {
    return new Promise(resolve => {
      exec('npm run build', { cwd: ROOT, timeout: 180000 }, (err, stdout, stderr) => {
        send(res, 200, { ok: !err, output: (stdout + stderr).trim() });
        resolve();
      });
    });
  }

  // POST /api/atelier/cleanup  — rename artwork files to match posttitles
  if (method === 'POST' && pathname === '/api/atelier/cleanup') {
    const posts    = scanPosts('artwork');
    const imgDir   = path.join(ROOT, 'src/images/artwork');
    const thumbDir = path.join(imgDir, 'thumbnails');
    const renames  = [];

    for (const post of posts) {
      const posttitle = post.data.posttitle;
      if (!posttitle || posttitle === 'Artwork') continue;

      const newSlugBase = slugify(posttitle);
      if (!newSlugBase || newSlugBase === post.slug) continue;

      const absFile = path.join(ROOT, post.file);
      const dir     = path.dirname(absFile);

      // Find unique slug in this directory (skip if collision with a different file)
      let newSlug = newSlugBase;
      let n = 0;
      while (true) {
        const candidate = path.join(dir, `${newSlug}.md`);
        if (!fs.existsSync(candidate) || candidate === absFile) break;
        n++; newSlug = `${newSlugBase}-${n}`;
      }

      // Rename image + thumbnail
      const { data, body } = parseFM(fs.readFileSync(absFile, 'utf-8'));
      let updatedData = { ...data };
      if (data.image) {
        const ext        = path.extname(data.image);
        const newImgName = `${newSlug}${ext}`;
        const oldImg     = path.join(imgDir,   data.image);
        const newImg     = path.join(imgDir,   newImgName);
        const oldThumb   = path.join(thumbDir, data.image);
        const newThumb   = path.join(thumbDir, newImgName);
        if (fs.existsSync(oldImg) && oldImg !== newImg) {
          if (!fs.existsSync(newImg)) fs.renameSync(oldImg, newImg);
        }
        if (fs.existsSync(oldThumb) && oldThumb !== newThumb) {
          if (!fs.existsSync(newThumb)) fs.renameSync(oldThumb, newThumb);
        }
        if (!fs.existsSync(newImg)) updatedData.image = data.image; // rename failed, keep old
        else updatedData.image = newImgName;
      }

      // Move .md file
      const newAbs = path.join(dir, `${newSlug}.md`);
      fs.unlinkSync(absFile);
      fs.writeFileSync(newAbs, `${dumpFM(updatedData)}\n\n${body || ''}\n`);
      renames.push({ from: post.file, to: path.relative(ROOT, newAbs).replace(/\\/g, '/') });
    }

    return send(res, 200, { ok: true, count: renames.length, renames });
  }

  // GET /api/atelier/folders  — categories with artwork post counts
  if (method === 'GET' && pathname === '/api/atelier/folders') {
    const posts = scanPosts('artwork');
    const counts = {};
    for (const post of posts) {
      const cats = post.data.categories;
      const arr  = Array.isArray(cats) ? cats : (cats ? [cats] : []);
      if (!arr.length) {
        counts['(uncategorized)'] = (counts['(uncategorized)'] || 0) + 1;
      } else {
        for (const c of arr) counts[c] = (counts[c] || 0) + 1;
      }
    }
    const folders = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    return send(res, 200, folders);
  }

  // GET /api/atelier/posts?folder=…  — artwork posts in one category folder
  if (method === 'GET' && pathname === '/api/atelier/posts') {
    const folder = params.folder;
    const posts  = scanPosts('artwork');
    const result = posts.filter(p => {
      const cats = p.data.categories;
      const arr  = Array.isArray(cats) ? cats : (cats ? [cats] : []);
      if (!folder || folder === '(uncategorized)') return arr.length === 0;
      return arr.includes(folder);
    });
    return send(res, 200, result);
  }

  // POST /api/atelier/quick  { folder, imageData(base64), fileName }
  if (method === 'POST' && pathname === '/api/atelier/quick') {
    const { folder, imageData, fileName } = await parseBody(req);
    if (!imageData || !fileName) return send(res, 400, { error: 'Missing fields' });

    const safeName = path.basename(fileName).replace(/[^\w.\-]/g, '_');
    const imgDir   = path.join(ROOT, 'src/images/artwork');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, safeName), Buffer.from(imageData, 'base64'));

    const cat     = (folder && folder !== '(uncategorized)') ? folder : 'misc';
    const catSlug = slugify(cat);
    const postDir = path.join(ROOT, 'src/posts/artwork', catSlug);
    if (!fs.existsSync(postDir)) fs.mkdirSync(postDir, { recursive: true });

    const baseName = safeName.replace(/\.[^.]+$/, '');
    let slug       = slugify(baseName) || 'untitled';
    const slugBase = slug;
    let n = 0;
    while (fs.existsSync(path.join(postDir, `${slug}.md`))) { n++; slug = `${slugBase}-${n}`; }

    const today = new Date().toISOString().split('T')[0];
    const data  = {
      title:      'Artwork',
      layout:     'artwork.njk',
      posttitle:  baseName.replace(/[-_]+/g, ' '),
      date:       today,
      categories: [cat],
      tags:       'artwork',
      image:      safeName,
      draft:      true,
    };

    const fp = path.join(postDir, `${slug}.md`);
    fs.writeFileSync(fp, `${dumpFM(data)}\n\n`);

    return send(res, 201, {
      file:     path.relative(ROOT, fp).replace(/\\/g, '/'),
      slug,
      series:   catSlug,
      title:    data.posttitle,
      image:    safeName,
      imageUrl: `/images/artwork/${safeName}`,
      date:     today,
      draft:    true,
      data,
    });
  }

  send(res, 404, { error: 'No such route' });
}

// ─── Server ───────────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const u      = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (u.pathname.startsWith('/api/')) {
    try   { await handleAPI(method, u.pathname, Object.fromEntries(u.searchParams), req, res); }
    catch (e) { console.error(e); try { send(res, 500, { error: String(e.message) }); } catch {} }
    return;
  }

  // Serve site images for preview (src/images → /images/)
  if (u.pathname.startsWith('/images/')) {
    const imgPath = path.join(ROOT, 'src', u.pathname);
    if (fs.existsSync(imgPath) && fs.lstatSync(imgPath).isFile()) {
      const ext = path.extname(imgPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      return fs.createReadStream(imgPath).pipe(res);
    }
  }

  // Static files from studio/public/
  const rel = u.pathname === '/' ? '/index.html' : u.pathname;
  const fp  = path.join(PUBLIC, rel);
  if (fs.existsSync(fp) && fs.lstatSync(fp).isFile()) {
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return fs.createReadStream(fp).pipe(res);
  }

  send(res, 404, 'Not found');

}).listen(PORT, () => {
  console.log(`\n  ✦ Quaint Lab Studio  →  http://localhost:${PORT}\n`);
});
