#!/usr/bin/env node
/**
 * Bulk-uploads photos from a local folder to canonniers-library-worker.
 * Generates thumbnails locally using `sharp` (must be installed: npm install --no-save sharp).
 *
 * Usage:
 *   node bootstrap/upload-library-photos.js ./bootstrap/media-day-2026/
 *
 * Auth: Uses a ONE-TIME admin bypass token (X-Bootstrap-Token header), not CF Access.
 * Enable via: wrangler secret put BOOTSTRAP_TOKEN (inside workers/library/)
 * Delete after upload: wrangler secret delete BOOTSTRAP_TOKEN (then redeploy worker)
 */

const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const WORKER_URL     = process.env.WORKER_URL || 'https://canonniers-library-worker.chisholm2000.workers.dev';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;

if (!BOOTSTRAP_TOKEN) {
  console.error('FATAL: BOOTSTRAP_TOKEN env var not set');
  console.error('  Set it: BOOTSTRAP_TOKEN=<token> node bootstrap/upload-library-photos.js <folder>');
  process.exit(1);
}

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error('Usage: node bootstrap/upload-library-photos.js <folder-path>');
  process.exit(1);
}
if (!fs.existsSync(sourceDir)) {
  console.error(`FATAL: folder not found: ${sourceDir}`);
  process.exit(1);
}

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function findPhotos(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p    = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      out.push(...findPhotos(p));
    } else if (ALLOWED_EXT.has(path.extname(name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

async function uploadOne(filepath, index, total) {
  const filename = path.basename(filepath);
  const buf      = fs.readFileSync(filepath);

  // Generate 800px thumbnail locally (max longest edge, JPEG q75)
  const thumbBuf = await sharp(buf)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();

  const fd = new FormData();
  fd.append('files', new Blob([buf]), filename);
  fd.append(`thumb_${filename}`, new Blob([thumbBuf]), `${filename}.thumb.jpg`);

  const r = await fetch(`${WORKER_URL}/api/library/upload`, {
    method:  'POST',
    headers: { 'X-Bootstrap-Token': BOOTSTRAP_TOKEN },
    body:    fd,
  });

  if (!r.ok) {
    const err = await r.text();
    console.error(`[${index}/${total}] ${filename} FAILED: HTTP ${r.status} ${err}`);
    return false;
  }

  const data = await r.json();
  const ok   = data.results?.[0]?.ok;
  const msg  = ok ? '✓' : `✗ ${data.results?.[0]?.error || 'unknown'}`;
  console.log(`[${index}/${total}] ${filename} ${msg}`);
  return !!ok;
}

(async () => {
  const photos = findPhotos(sourceDir);
  console.log(`Found ${photos.length} photos in ${sourceDir}`);
  if (photos.length === 0) process.exit(0);

  console.log('Starting upload (concurrency: 4)…');

  let okCount = 0, failCount = 0;
  const CONCURRENCY = 4;

  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const batch   = photos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((p, j) => uploadOne(p, i + j + 1, photos.length))
    );
    okCount   += results.filter(Boolean).length;
    failCount += results.filter(r => !r).length;
  }

  console.log(`\nDone. ${okCount} uploaded, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
})();
