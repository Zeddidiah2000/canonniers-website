// Run with: node scripts/reconcile-ghost-photos.js
//      or:  node scripts/reconcile-ghost-photos.js --team=u17d1
//      or:  node scripts/reconcile-ghost-photos.js --execute
//      or:  node scripts/reconcile-ghost-photos.js --team=u17d1 --execute
//
// Dry run (default): lists every D1 row whose CF Images asset 404s.
// Execute mode:      deletes those rows via DELETE /api/photos/:id.
//
// Requires commit 4 to be live before --execute is usable.
// Set env vars before running in execute mode:
//   ADMIN_BEARER  — bearer token for the photo-worker
//   ADMIN_JWT     — CF Access JWT (copy from browser DevTools:
//                   Application > Cookies > CF_Authorization, or
//                   Network tab header CF-Access-Jwt-Assertion on any request)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CF_IMAGE_HASH = 'XuWXX2Hn8HGMN14wNLQAMA';
const WORKER_URL    = process.env.WORKER_URL   || 'https://canonniersdequebec.ca/api/photo-worker';
const ADMIN_TOKEN   = process.env.ADMIN_BEARER || '';
const ADMIN_JWT     = process.env.ADMIN_JWT    || '';
const TEAMS         = ['u15', 'u17d1', 'u17d2'];

const teamArg = process.argv.find(a => a.startsWith('--team='));
const teamsToScan = teamArg ? [teamArg.split('=')[1]] : TEAMS;

if (teamArg && !TEAMS.includes(teamsToScan[0])) {
  console.error(`Invalid team: ${teamsToScan[0]}. Must be one of: ${TEAMS.join(', ')}`);
  process.exit(1);
}

async function main() {
  const mode = process.argv.includes('--execute') ? 'execute' : 'dry-run';
  console.log(`Mode: ${mode}\n`);

  if (mode === 'execute' && (!ADMIN_TOKEN || !ADMIN_JWT)) {
    console.error('ERROR: Set ADMIN_BEARER and ADMIN_JWT env vars before running --execute');
    process.exit(1);
  }

  const ghosts = [];

  for (const team of teamsToScan) {
    const r = await fetch(`${WORKER_URL}/api/photos?team=${team}`);
    if (!r.ok) {
      console.error(`Failed to fetch photos for team ${team}: HTTP ${r.status}`);
      process.exit(1);
    }
    const { photos } = await r.json();
    console.log(`Team ${team}: ${photos.length} row(s) in D1`);

    for (const p of photos) {
      const url = `https://imagedelivery.net/${CF_IMAGE_HASH}/${p.cf_image_id}/thumb`;
      let status;
      try {
        const head = await fetch(url, { method: 'HEAD' });
        status = head.status;
      } catch (e) {
        console.warn(`  WARN id=${p.id}: HEAD request failed (${e.message}) — skipping`);
        await sleep(50);
        continue;
      }

      if (status !== 200) {
        ghosts.push(p);
        console.log(`  GHOST id=${p.id} cf_image_id=${p.cf_image_id} HTTP=${status}`);
        console.log(`        event="${p.event_name_fr}" date=${p.event_date} team=${p.team_category}`);
      }
      await sleep(50);
    }
  }

  console.log(`\nFound ${ghosts.length} ghost row(s).`);

  if (mode === 'dry-run') {
    console.log('Dry run complete. Re-run with --execute to delete.');
    return;
  }

  let deleted = 0;
  let failed  = 0;

  for (const p of ghosts) {
    const r = await fetch(`${WORKER_URL}/api/photos/${p.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization':           `Bearer ${ADMIN_TOKEN}`,
        'CF-Access-Jwt-Assertion': ADMIN_JWT,
      },
    });
    if (r.ok) {
      console.log(`  DELETED id=${p.id} (${p.event_name_fr})`);
      deleted++;
    } else {
      console.error(`  FAILED  id=${p.id}: HTTP ${r.status}`);
      failed++;
    }
  }

  console.log(`\nDone. Deleted: ${deleted}  Failed: ${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
