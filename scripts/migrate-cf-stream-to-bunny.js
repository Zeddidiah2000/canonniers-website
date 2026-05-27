#!/usr/bin/env node
// Migrate stale Cloudflare Stream recordings to bunny.net to free CF Stream space.
//
// Default mode: discover stale (>=7d) CF Stream videos, migrate to bunny.
// Does NOT delete from CF Stream — use --delete-confirmed for the second pass.
//
// Env required:
//   CF_STREAM_RW_TOKEN  — CF token with Stream:Read + Stream:Edit (canonniers-stream-rw-migration)
//   BUNNY_API_KEY       — bunny.net Stream library API key (per-library)
//   NODE_OPTIONS=--use-system-ca  (PowerShell:  $env:NODE_OPTIONS="--use-system-ca")
//
// See: project_bunny_migration.md in /memory for context.

const CF_ACCOUNT_ID = 'db90db1d80338194e2994306da649f90';
const CF_STREAM_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream`;

const LIVE_INPUTS = {
  u15:   '8ffb2b7f7847ab2fb22681c26abe60c8',
  u17d1: 'a3af25e5ea09782876fced8d7d66bf31',
  u17d2: '0ec71443dbcec9b7d58b708968c016da',
};

const BUNNY_LIBRARY_ID = 671238;
const BUNNY_URL = `https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}`;

const CF_TOKEN  = process.env.CF_STREAM_RW_TOKEN;
const BUNNY_KEY = process.env.BUNNY_API_KEY;
if (!CF_TOKEN || !BUNNY_KEY) {
  console.error('Missing env: CF_STREAM_RW_TOKEN and BUNNY_API_KEY are required.');
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
    .map(([k, v]) => [k, v ?? true])
);
const AGE_DAYS         = parseInt(args['age-days'], 10) || 7;
const DRY_RUN          = !!args['dry-run'];
const VERIFY_ONLY      = !!args['verify-only'];
const DELETE_CONFIRMED = !!args['delete-confirmed'];

const cfHeaders        = { Authorization: `Bearer ${CF_TOKEN}` };
const bunnyHeaders     = { AccessKey: BUNNY_KEY, Accept: 'application/json' };
const bunnyJsonHeaders = { ...bunnyHeaders, 'Content-Type': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtBytes = b => !b ? '?' : b > 1e9 ? `${(b/1e9).toFixed(2)} GB` : `${(b/1e6).toFixed(0)} MB`;

// ── HTTP helpers ──────────────────────────────────────────────────────────

async function cfGet(path) {
  const r = await fetch(`${CF_STREAM_URL}${path}`, { headers: cfHeaders });
  if (!r.ok) throw new Error(`CF GET ${r.status} ${path}`);
  const d = await r.json();
  if (!d.success) throw new Error(`CF !success ${path}: ${JSON.stringify(d.errors)}`);
  return d.result;
}
async function cfPost(path) {
  const r = await fetch(`${CF_STREAM_URL}${path}`, { method: 'POST', headers: cfHeaders });
  if (!r.ok) throw new Error(`CF POST ${r.status} ${path}`);
  return (await r.json()).result;
}
async function cfDelete(path) {
  const r = await fetch(`${CF_STREAM_URL}${path}`, { method: 'DELETE', headers: cfHeaders });
  if (!r.ok) throw new Error(`CF DELETE ${r.status} ${path}`);
}
async function bunnyGet(path) {
  const r = await fetch(`${BUNNY_URL}${path}`, { headers: bunnyHeaders });
  if (!r.ok) throw new Error(`Bunny GET ${r.status} ${path}`);
  return r.json();
}
async function bunnyPost(path, body) {
  const r = await fetch(`${BUNNY_URL}${path}`, {
    method: 'POST', headers: bunnyJsonHeaders, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Bunny POST ${r.status} ${path}: ${await r.text()}`);
  return r.json();
}

// ── Discovery ─────────────────────────────────────────────────────────────

async function discoverCfVideos() {
  const all = [];
  for (const [team, liveUid] of Object.entries(LIVE_INPUTS)) {
    const vids = await cfGet(`/live_inputs/${liveUid}/videos`);
    for (const v of vids) {
      if (v.status?.state !== 'ready') continue;
      if (v.duration <= 60) continue;
      const ageDays = Math.floor((Date.now() - new Date(v.created).getTime()) / 86400000);
      all.push({ team, uid: v.uid, created: v.created, ageDays, duration: v.duration, size: v.size });
    }
  }
  return all;
}

async function discoverBunnyVideos() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await bunnyGet(`/videos?page=${page}&itemsPerPage=100`);
    if (!data.items?.length) break;
    for (const v of data.items) {
      const tags = Object.fromEntries((v.metaTags || []).map(t => [t.property, t.value]));
      all.push({
        guid: v.guid, title: v.title, status: v.status,
        streamUid: tags.stream_uid || null,
        originalCreated: tags.original_created || null,
      });
    }
    if (data.items.length < 100) break;
    page++;
  }
  return all;
}

// ── Migration ─────────────────────────────────────────────────────────────

async function enableCfDownload(uid) {
  await cfPost(`/${uid}/downloads`);
  for (let i = 0; i < 720; i++) {        // 720 * 5s = 60 min cap (large videos)
    await sleep(5000);
    const d = await cfGet(`/${uid}/downloads`);
    if (d.default?.status === 'ready') return d.default.url;
  }
  throw new Error(`CF download never ready for ${uid}`);
}

async function migrateOne(cfVid) {
  const title = `${cfVid.team}-${cfVid.created.slice(0, 10)}-${cfVid.uid.slice(0, 8)}`;
  console.log(`\n→ ${title}  (${cfVid.duration}s, ${fmtBytes(cfVid.size)})`);
  if (DRY_RUN) { console.log('  [dry-run] would migrate'); return; }

  process.stdout.write('  enabling CF download...');
  const mp4Url = await enableCfDownload(cfVid.uid);
  console.log(' ready');

  process.stdout.write('  bunny fetch...');
  const fetchResp = await bunnyPost('/videos/fetch', { url: mp4Url, title });
  if (!fetchResp.success) throw new Error(`bunny fetch: ${JSON.stringify(fetchResp)}`);
  const guid = fetchResp.id;
  console.log(` GUID ${guid}`);

  process.stdout.write('  setting metaTags...');
  await bunnyPost(`/videos/${guid}`, {
    metaTags: [
      { property: 'stream_uid',       value: cfVid.uid },
      { property: 'original_created', value: cfVid.created },
    ],
  });
  console.log(' done');
}

// ── Delete pass ───────────────────────────────────────────────────────────

async function deletePass(cfMigrated, bunnyVideos) {
  const finishedByUid = new Map();
  for (const b of bunnyVideos) {
    if (b.status === 4 && b.streamUid) finishedByUid.set(b.streamUid, b);
  }

  const eligible = cfMigrated.filter(c => finishedByUid.has(c.uid));
  if (!eligible.length) { console.log('\nNothing to delete (no CF videos have a Finished bunny match).'); return; }

  let totalSize = 0;
  console.log('\n=== Delete plan ===');
  for (const c of eligible) {
    const b = finishedByUid.get(c.uid);
    console.log(`  ${c.team.padEnd(5)} ${c.created.slice(0,10)} ${c.uid.slice(0,12)} (${fmtBytes(c.size)})  →  bunny ${b.guid.slice(0,8)}`);
    totalSize += c.size || 0;
  }
  console.log(`Total: ${eligible.length} videos, ${fmtBytes(totalSize)} to free.`);

  if (DRY_RUN) { console.log('[dry-run] would delete'); return; }

  console.log('\nProceeding in 5 seconds. Ctrl+C to abort.');
  await sleep(5000);

  let deleted = 0, failed = 0;
  for (const c of eligible) {
    try { await cfDelete(`/${c.uid}`); deleted++; console.log(`  ✓ ${c.uid.slice(0,12)}`); }
    catch (e)                          { failed++;  console.log(`  ✗ ${c.uid.slice(0,12)}: ${e.message}`); }
  }
  console.log(`\nDeleted ${deleted}, failed ${failed}, freed ${fmtBytes(totalSize)}.`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const mode = DELETE_CONFIRMED ? 'DELETE' : VERIFY_ONLY ? 'verify-only' : DRY_RUN ? 'dry-run' : 'migrate';
  console.log(`Mode: ${mode}  ·  Cutoff: ≥${AGE_DAYS} days old`);

  console.log('\nDiscovering CF Stream videos...');
  const cfAll = await discoverCfVideos();
  const cfStale = cfAll.filter(v => v.ageDays >= AGE_DAYS);
  console.log(`CF Stream: ${cfAll.length} total, ${cfStale.length} stale`);

  console.log('Discovering bunny videos...');
  const bunnyAll = await discoverBunnyVideos();
  // "Already migrated" = anything except failed states (Error/UploadFailed)
  const byUid = new Map(
    bunnyAll.filter(b => b.streamUid && b.status !== 5 && b.status !== 6).map(b => [b.streamUid, b])
  );
  console.log(`Bunny: ${bunnyAll.length} videos, ${byUid.size} with valid stream_uid metaTag`);

  const candidates       = cfStale.filter(c => !byUid.has(c.uid));
  const alreadyMigrated  = cfStale.filter(c =>  byUid.has(c.uid));

  console.log('\n=== Status ===');
  console.log(`  Already migrated (CF copies present): ${alreadyMigrated.length}`);
  console.log(`  Pending migration:                    ${candidates.length}`);
  for (const c of candidates) {
    console.log(`    - ${c.team.padEnd(5)} ${c.created.slice(0,10)} ${c.uid.slice(0,12)} (${c.duration}s, ${fmtBytes(c.size)})`);
  }

  if (VERIFY_ONLY) return;

  if (DELETE_CONFIRMED) { await deletePass(alreadyMigrated, bunnyAll); return; }

  let ok = 0, failed = 0;
  for (const cfVid of candidates) {
    try { await migrateOne(cfVid); ok++; }
    catch (e) { failed++; console.log(`  ✗ FAILED: ${e.message}`); }
  }
  console.log(`\n=== Done: ${ok} migrated, ${failed} failed ===`);
}

main().catch(e => { console.error('\nFatal:', e); process.exit(1); });
