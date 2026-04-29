const fs = require('fs');
const path = require('path');

const API_URL = 'https://canonniers-roster-worker.chisholm2000.workers.dev/api/players';
const PASSWORD = 'canonniers2026';

const players = JSON.parse(fs.readFileSync(path.join(__dirname, 'extracted_players_v2.json'), 'utf-8'));

async function updateStats() {
    console.log('Fetching current database state...');
    const dbRes = await fetch(API_URL);
    const dbPlayers = await dbRes.json();
    
    console.log(`Starting stats update for ${players.length} players...`);
    
    for (const player of players) {
        const dbMatch = dbPlayers.find(p => p.name === player.name);
        if (dbMatch && player.stats_json) {
            console.log(`Updating stats for: ${player.name} (ID: ${dbMatch.id})`);
            
            const payload = {
                ...dbMatch, // keep existing info (photos, etc)
                stats_json: player.stats_json
            };
            
            try {
                const res = await fetch(`${API_URL}/${dbMatch.id}`, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${PASSWORD}`
                    },
                    body: JSON.stringify(payload)
                });
                
                if (res.ok) {
                    console.log(`✅ Updated: ${player.name}`);
                } else {
                    const text = await res.text();
                    console.error(`❌ Failed: ${player.name} - ${res.status} ${text}`);
                }
            } catch (e) {
                console.error(`❌ Error updating ${player.name}:`, e.message);
            }
        }
    }
    console.log('Stats update complete.');
}

updateStats();
