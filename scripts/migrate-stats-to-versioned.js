const API_URL = 'https://canonniers-roster-worker.chisholm2000.workers.dev/api/players';
const PASSWORD = 'canonniers2026';

async function migrate() {
  const all = await fetch(API_URL).then(r => r.json());
  console.log(`Fetched ${all.length} players`);
  let migrated = 0, skipped = 0, errored = 0;

  for (const p of all) {
    if (!p.stats_json) continue;

    let parsed;
    try { parsed = JSON.parse(p.stats_json); }
    catch { console.error(`⚠️  ${p.name}: invalid JSON, skipping`); continue; }

    const looksVersioned = Object.keys(parsed).some(k => /^\d{4}$/.test(k));
    if (looksVersioned) {
      skipped++;
      console.log(`⏭️  ${p.name}: already versioned (keys: ${Object.keys(parsed).join(',')})`);
      continue;
    }

    const payload = { ...p, stats_json: JSON.stringify({ '2025': parsed }) };

    try {
      const res = await fetch(`${API_URL}/${p.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PASSWORD}` },
        body: JSON.stringify(payload)
      });
      if (res.ok) { migrated++; console.log(`✅ ${p.name} (#${p.number} ${p.team_category}): wrapped as 2025`); }
      else { errored++; console.error(`❌ ${p.name}: ${res.status} ${await res.text()}`); }
    } catch (e) { errored++; console.error(`❌ ${p.name}: ${e.message}`); }
  }

  console.log(`\nDone: ${migrated} migrated, ${skipped} skipped, ${errored} errored`);
}

migrate();
