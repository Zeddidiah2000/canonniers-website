const fs = require('fs');
const path = require('path');

const API_URL = 'https://canonniers-roster-worker.chisholm2000.workers.dev/api/players';
const PASSWORD = 'canonniers2026';

const players = JSON.parse(fs.readFileSync(path.join(__dirname, 'extracted_players.json'), 'utf-8'));

async function migrate() {
    console.log(`Starting migration of ${players.length} players...`);
    for (const player of players) {
        try {
            const res = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${PASSWORD}`
                },
                body: JSON.stringify(player)
            });
            if (res.ok) {
                console.log(`✅ Migrated: ${player.name}`);
            } else {
                const text = await res.text();
                console.error(`❌ Failed: ${player.name} - ${res.status} ${text}`);
            }
        } catch (e) {
            console.error(`❌ Error migrating ${player.name}:`, e.message);
        }
    }
    console.log('Migration complete.');
}

migrate();
