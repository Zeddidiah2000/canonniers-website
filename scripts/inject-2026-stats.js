const fs = require('fs');
const path = require('path');

const API_URL    = 'https://canonniers-roster-worker.chisholm2000.workers.dev/api/players';
const PASSWORD   = 'canonniers2026';
const STATS_FILE = path.join(__dirname, '..', 'stats-input', 'u15-stats-2026-in-season-2026-05-24-v4.json');

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

async function inject() {
  const input = JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8'));
  const all = await fetch(API_URL).then(r => r.json());
  const u15 = all.filter(p => p.team_category === 'u15');

  console.log(`Input: ${input.players.length} players · DB u15: ${u15.length}`);

  let updated = 0, errored = 0;
  const unmatched = [];

  for (const entry of input.players) {
    const db = u15.find(p => Number(p.number) === Number(entry.jersey));
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
      catch { console.error(`⚠️  ${db.name}: bad existing JSON — treating as empty`); }
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
        console.log(`✅ #${entry.jersey} ${db.name}: ${tags}`);
      } else { errored++; console.error(`❌ ${db.name}: ${res.status} ${await res.text()}`); }
    } catch (e) { errored++; console.error(`❌ ${db.name}: ${e.message}`); }
  }

  console.log(`\nDone: ${updated} updated, ${errored} errored`);
  if (unmatched.length) console.log(`Unmatched: ${unmatched.join(', ')}`);
}

inject();
