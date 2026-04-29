const fs = require('fs');
const path = require('path');

const API_URL = 'https://canonniers-roster-worker.chisholm2000.workers.dev/api/players';
const PASSWORD = 'canonniers2026';

const updateFiles = [
    'u15-stats-2026-04-28.json',
    'u17d1-stats-2026-04-28.json',
    'u17d2-stats-2026-04-28.json'
];

async function restoreStats() {
    console.log('Fetching current database state...');
    const dbRes = await fetch(API_URL);
    const dbPlayers = await dbRes.json();
    
    for (const fileName of updateFiles) {
        console.log(`Processing ${fileName}...`);
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'Updates', fileName), 'utf-8'));
        const teamSlug = data.team_slug;
        
        for (const gcPlayer of data.players) {
            // Find match in DB by team and name
            // GC names are "A Biasone", DB names are "Aïzak Biasone"
            const gcParts = gcPlayer.gc_name.split(' ');
            const gcInitial = gcParts[0].toLowerCase();
            const gcLastName = gcParts.pop().toLowerCase();
            
            const dbMatch = dbPlayers.find(p => {
                if (p.team_category !== teamSlug) return false;
                const normalize = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
                const dbParts = p.name.split(' ');
                const dbInitial = dbParts[0].charAt(0).toLowerCase();
                const dbLastName = normalize(dbParts.pop());
                const gcLastNameNorm = normalize(gcLastName);
                // Match by Last Name AND First Initial
                return dbLastName.includes(gcLastNameNorm) && dbInitial === gcInitial;
            });
            
            if (dbMatch) {
                console.log(`Found match for ${gcPlayer.gc_name} -> ${dbMatch.name} (ID: ${dbMatch.id})`);
                
                // Format stats_json
                const stats = {};
                if (gcPlayer.batting) {
                    // Convert numeric values to strings to match original design
                    stats.batting = Object.fromEntries(
                        Object.entries(gcPlayer.batting).map(([k, v]) => {
                            if (v === null) return [k, "—"];
                            if (typeof v === 'number' && (k === 'AVG' || k === 'OBP' || k === 'SLG' || k === 'OPS')) {
                                return [k, v.toFixed(3).startsWith('0') ? v.toFixed(3).substring(1) : v.toFixed(3)];
                            }
                            return [k, String(v)];
                        })
                    );
                }
                if (gcPlayer.pitching && gcPlayer.pitching.GP !== null) {
                    stats.pitching = Object.fromEntries(
                        Object.entries(gcPlayer.pitching).map(([k, v]) => {
                            if (v === null) return [k, "—"];
                            if (typeof v === 'number' && (k === 'ERA' || k === 'WHIP')) {
                                return [k, v.toFixed(2)];
                            }
                            return [k, String(v)];
                        })
                    );
                }
                
                if (Object.keys(stats).length > 0) {
                    const statsJson = JSON.stringify(stats);
                    console.log(`Updating stats for ${dbMatch.name}...`);
                    
                    try {
                        const res = await fetch(`${API_URL}/${dbMatch.id}`, {
                            method: 'PUT',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${PASSWORD}`
                            },
                            body: JSON.stringify({
                                ...dbMatch,
                                stats_json: statsJson
                            })
                        });
                        if (res.ok) {
                            console.log(`✅ Success: ${dbMatch.name}`);
                        } else {
                            console.error(`❌ Failed: ${dbMatch.name} - ${res.status}`);
                        }
                    } catch (e) {
                        console.error(`❌ Error: ${e.message}`);
                    }
                }
            } else {
                console.warn(`⚠️ No DB match found for ${gcPlayer.gc_name} in team ${teamSlug}`);
            }
        }
    }
    console.log('Restoration complete.');
}

restoreStats();
