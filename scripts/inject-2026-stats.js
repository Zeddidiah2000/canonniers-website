const fs = require('fs');
const path = require('path');

const API_URL  = 'https://canonniers-roster-worker.chisholm2000.workers.dev/api/players';
const PASSWORD = 'canonniers2026';
const STATS_DIR = path.join(__dirname, '..', 'stats-input');
const TEAMS = ['u15', 'u17d1', 'u17d2'];

// Baseball thirds: "5.2" means 5 and 2/3 innings (17 outs), NOT 5.2 decimal.
function ipToDecimal(ip) {
  if (ip == null) return 0;
  const m = String(ip).match(/^(\d+)(?:\.(\d))?$/);
  if (!m) return parseFloat(ip) || 0;
  return parseInt(m[1], 10) + ((m[2] ? parseInt(m[2], 10) : 0) / 3);
}

function computeWhip(pitching) {
  if (!pitching) return null;
  const ip = ipToDecimal(pitching.IP);
  if (ip === 0) return null;
  return (((Number(pitching.BB) || 0) + (Number(pitching.H) || 0)) / ip).toFixed(2);
}

function findLatestStatsFile(team) {
  const prefix = `${team}-stats-`;
  const matches = fs.readdirSync(STATS_DIR)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(STATS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0] ? matches[0].name : null;
}

async function injectTeam(team, allPlayers) {
  const fileName = findLatestStatsFile(team);
  if (!fileName) {
    console.log(`\n— ${team}: no stats file found in stats-input/ (skipped)`);
    return { team, updated: 0, errored: 0, unmatched: [], skipped: true };
  }

  console.log(`\n— ${team}: using ${fileName}`);
  const input = JSON.parse(fs.readFileSync(path.join(STATS_DIR, fileName), 'utf-8'));
  const roster = allPlayers.filter(p => p.team_category === team);
  console.log(`  Input: ${input.players.length} players · DB ${team}: ${roster.length}`);

  let updated = 0, errored = 0;
  const unmatched = [];

  for (const entry of input.players) {
    const db = roster.find(p => Number(p.number) === Number(entry.jersey));
    if (!db) { unmatched.push(`#${entry.jersey} ${entry.name}`); continue; }

    const block = { batting: entry.batting };
    if (entry.pitching) {
      const pi = { ...entry.pitching };
      if (pi.WHIP == null) pi.WHIP = computeWhip(pi);
      block.pitching = pi;
    }
    if (entry._gc_fielding_catching) block.catching = entry._gc_fielding_catching;

    let existing = {};
    if (db.stats_json) {
      try { existing = JSON.parse(db.stats_json); }
      catch { console.error(`  ⚠️  ${db.name}: bad existing JSON — treating as empty`); }
    }
    const payload = { ...db, stats_json: JSON.stringify({ ...existing, '2026': block }) };

    try {
      const res = await fetch(`${API_URL}/${db.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASSWORD}` },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        updated++;
        const tags = ['batting', block.pitching && 'pitching', block.catching && 'catching'].filter(Boolean).join('+');
        console.log(`  ✅ #${entry.jersey} ${db.name}: ${tags}`);
      } else { errored++; console.error(`  ❌ ${db.name}: ${res.status} ${await res.text()}`); }
    } catch (e) { errored++; console.error(`  ❌ ${db.name}: ${e.message}`); }
  }

  return { team, updated, errored, unmatched, skipped: false };
}

async function main() {
  const arg = process.argv[2];
  const targets = arg ? [arg] : TEAMS;
  if (arg && !TEAMS.includes(arg)) {
    console.error(`Unknown team "${arg}". Valid: ${TEAMS.join(', ')}`);
    process.exit(1);
  }

  const allPlayers = await fetch(API_URL).then(r => r.json());
  const results = [];
  for (const team of targets) results.push(await injectTeam(team, allPlayers));

  console.log('\n=== Summary ===');
  for (const r of results) {
    if (r.skipped) { console.log(`${r.team}: skipped (no file)`); continue; }
    console.log(`${r.team}: ${r.updated} updated, ${r.errored} errored${r.unmatched.length ? `, unmatched: ${r.unmatched.join(', ')}` : ''}`);
  }
}

main();
