#!/usr/bin/env node
/**
 * Direct bootstrap: uploads photos straight to R2 + D1 via Cloudflare REST API.
 * No worker or CF Access involved — uses the wrangler OAuth token directly.
 *
 * Usage: node bootstrap/upload-direct.js ./bootstrap/media-day-2026/
 */

const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

const CF_TOKEN    = 'MJlQntrcoqi7gtYAuh03ILUGMv2vV5iV9sicFRGc4sw.STB9zDiFIRWPg1NCg5eNL9G4NKMI8aqro7SlXaIJgKQ';
const ACCOUNT_ID  = 'db90db1d80338194e2994306da649f90';
const BUCKET      = 'player-photos-library';
const DB_ID       = 'f416f91e-a004-4bdb-a6bf-d4ba3264e61d';
const CONCURRENCY = 4;
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const R2_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${BUCKET}/objects`;
const AUTH    = { 'Authorization': `Bearer ${CF_TOKEN}` };

function findPhotos(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { out.push(...findPhotos(p)); continue; }
    if (ALLOWED_EXT.has(path.extname(name).toLowerCase())) out.push(p);
  }
  return out.sort();
}

function mimeForExt(ext) {
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function r2Put(key, buf, contentType) {
  const r = await fetch(`${R2_BASE}/${encodeURIComponent(key)}`, {
    method:  'PUT',
    headers: { ...AUTH, 'Content-Type': contentType },
    body:    buf,
  });
  if (!r.ok) throw new Error(`R2 PUT ${key}: HTTP ${r.status}`);
}

async function processOne(filepath, index, total) {
  const filename = path.basename(filepath);
  const ext      = path.extname(filename).toLowerCase();
  const mime     = mimeForExt(ext);
  const buf      = fs.readFileSync(filepath);

  const thumbBuf = await sharp(buf)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();

  const id       = crypto.randomUUID();
  const r2Ext    = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp';
  const r2Key    = `library/${id}.${r2Ext}`;
  const thumbKey = `library/${id}_thumb.jpg`;

  await r2Put(r2Key, buf, mime);
  await r2Put(thumbKey, thumbBuf, 'image/jpeg');

  process.stdout.write(`[${index}/${total}] ${filename} ✓\n`);
  return { r2Key, thumbKey, filename, size: buf.length, mime };
}

function escSql(s) { return s.replace(/'/g, "''"); }

(async () => {
  const sourceDir = process.argv[2];
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    console.error('Usage: node upload-direct.js <folder>'); process.exit(1);
  }

  const photos = findPhotos(sourceDir);
  console.log(`Found ${photos.length} photos — uploading to R2 (concurrency ${CONCURRENCY})...`);
  if (photos.length === 0) process.exit(0);

  const uploaded = [];
  const failed   = [];

  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const batch   = photos.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((p, j) => processOne(p, i + j + 1, photos.length))
    );
    for (let k = 0; k < results.length; k++) {
      const r = results[k];
      if (r.status === 'fulfilled') {
        uploaded.push(r.value);
      } else {
        const failedFile = path.basename(batch[k]);
        console.error(`FAIL: ${failedFile} — ${r.reason?.message}`);
        failed.push(failedFile);
      }
    }
  }

  console.log(`\nR2: ${uploaded.length} uploaded, ${failed.length} failed.`);
  if (failed.length > 0) console.log('Failed files:', failed.join(', '));
  if (uploaded.length === 0) process.exit(1);

  // Write D1 inserts to a SQL file and run via wrangler (avoids REST API format issues)
  console.log('\nGenerating SQL file for D1 insert...');
  const sqlLines = uploaded.map(r =>
    `INSERT INTO photo_library (r2_key, thumb_r2_key, filename, size_bytes, mime_type, uploaded_by) ` +
    `VALUES ('${escSql(r.r2Key)}', '${escSql(r.thumbKey)}', '${escSql(r.filename)}', ${r.size}, '${r.mime}', 'bootstrap@canonniers.ca');`
  );
  const sqlFile = path.join(__dirname, 'bootstrap_inserts.sql');
  fs.writeFileSync(sqlFile, sqlLines.join('\n') + '\n');
  console.log(`SQL file written: ${sqlFile} (${uploaded.length} rows)`);

  console.log('Running wrangler d1 execute...');
  execSync(
    `npx wrangler d1 execute canonniers-db --remote --file="${sqlFile}"`,
    { stdio: 'inherit', cwd: path.join(__dirname, '..') }
  );

  fs.unlinkSync(sqlFile);
  console.log(`\nDone. ${uploaded.length} photos in library.`);
  if (failed.length > 0) { console.log(`\n⚠ ${failed.length} photos failed — rerun to retry them.`); process.exit(1); }
})();
