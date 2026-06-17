#!/usr/bin/env node
// Wraps `reclassify-tumblr.mjs --publish` and restarts the Eleventy dev
// server when needed. Eleventy's --serve watcher reliably picks up content
// *changes* to passthrough-copied files, but new files added to a
// passthrough-copied directory (e.g. profile-model-viewer.js the day it was
// created) can silently 404 until the server restarts and re-copies
// everything from scratch. This script diffs file lists before/after the
// publish step and only restarts when something was actually added/removed.
import { execSync, spawnSync, spawn } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

const WATCHED_DIRS = [
  'src/pages/server/skylanders/models',
  'src/pages/server/skylanders/archive',
  'src/images/skylanders-archive',
];

function walk(dir, files) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else files.add(p);
  }
}

function snapshot() {
  const files = new Set();
  for (const dir of WATCHED_DIRS) walk(dir, files);
  return files;
}

function findEleventyServeProcesses() {
  const out = execSync('ps aux').toString();
  const matches = out.split('\n').filter(l => l.includes('eleventy') && l.includes('--serve') && !l.includes('grep'));
  if (!matches.length) return null;
  const pids = matches.map(l => parseInt(l.trim().split(/\s+/)[1], 10));
  const portMatch = matches.map(l => l.match(/--port[ =](\d+)/)).find(Boolean);
  const port = portMatch ? portMatch[1] : null;
  return { pids, port };
}

console.log('Rebuilding + publishing archive…\n');
const before = snapshot();

const result = spawnSync('node', ['scripts/reclassify-tumblr.mjs', './skylanders-archive', '--publish'], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error('\nPublish failed — not touching the dev server.');
  process.exit(result.status ?? 1);
}

const after = snapshot();
const added   = [...after].filter(f => !before.has(f));
const removed = [...before].filter(f => !after.has(f));

if (!added.length && !removed.length) {
  console.log('\nNo files added/removed in passthrough-copied directories — the running Eleventy dev server (if any) will pick up content changes on its own.');
  process.exit(0);
}

console.log(`\n${added.length} file(s) added, ${removed.length} removed in passthrough-copied directories.`);

const proc = findEleventyServeProcesses();
if (!proc) {
  console.log('No running "eleventy --serve" process found — nothing to restart.');
  process.exit(0);
}

console.log(`Restarting Eleventy dev server (pid ${proc.pids.join(', ')}) on port ${proc.port ?? '8080 (default)'} to pick up the change…`);
for (const pid of proc.pids) {
  try { process.kill(pid); } catch {}
}

setTimeout(() => {
  const args = ['eleventy', '--serve'];
  if (proc.port) args.push('--port', proc.port);
  const child = spawn('npx', args, { detached: true, stdio: 'ignore' });
  child.unref();
  console.log('Restarted: npx ' + args.join(' '));
}, 1000);
