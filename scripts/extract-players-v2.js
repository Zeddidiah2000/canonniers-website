const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'backups', 'alignement.html.bak-20260428-164925');
const content = fs.readFileSync(filePath, 'utf-8');

function extractStats(drawerContent) {
    const stats = {};
    
    // Look for panels
    const panels = drawerContent.split('<div class="stat-panel');
    panels.shift(); // remove first part before panels

    panels.forEach(p => {
        const isBatting = p.includes('batting') || p.includes('bâton');
        const type = isBatting ? 'batting' : 'pitching';
        
        const historicalMatch = p.match(/<div class="historical-block">([\s\S]*?)<\/div>\s*<\/div>/);
        if (historicalMatch) {
            const blockContent = historicalMatch[1];
            const cellRegex = /<div class="stat-cell"><span class="stat-val[^"]*">([^<]*)<\/span><span class="stat-key">([^<]*)<\/span><\/div>/g;
            const blockStats = {};
            let cellMatch;
            while ((cellMatch = cellRegex.exec(blockContent)) !== null) {
                const val = cellMatch[1].trim();
                const key = cellMatch[2].trim();
                if (val !== '—') {
                    blockStats[key] = val;
                }
            }
            if (Object.keys(blockStats).length > 0) {
                stats[type] = blockStats;
            }
        }
    });
    
    return Object.keys(stats).length > 0 ? JSON.stringify(stats) : null;
}

function extractTeam(panelId, teamCategory) {
    const players = [];
    const panelRegex = new RegExp(`<div class="team-panel[^"]*" id="${panelId}">([\\s\\S]*?)<div class="roster-section">\\s*<div class="section-header">\\s*<span class="fr-text">Personnel</span>`, 'i');
    const panelMatch = content.match(panelRegex);
    
    if (!panelMatch) return [];

    const panelContent = panelMatch[1];
    const playerRowRegex = /<tr class="has-stats" onclick="toggleDrawer\('([^']+)'\)"><td><span class="num-badge(?: no-num)?">([^<]*)<\/span><\/td><td class="player-name"><span class="player-toggle">([^<]+)<\/span><\/td><td class="center"><span class="pos-badge">([^<]*)<\/span><\/td><td class="center bt-cell">([^<]*)<\/td><td class="center ht-cell">([^<]*)<\/td><td class="center wt-cell">([^<]*)<\/td><\/tr>/g;
    
    let match;
    while ((match = playerRowRegex.exec(panelContent)) !== null) {
        const [full, id, number, name, position, batsThrows, height, weight] = match;
        
        // Extract stats for this player
        const drawerRegex = new RegExp(`<tr class="stats-drawer" id="drawer-${id}">([\\s\\S]*?)<\\/tr>`, 'i');
        const drawerMatch = panelContent.match(drawerRegex);
        const statsJson = drawerMatch ? extractStats(drawerMatch[1]) : null;

        players.push({
            name: name.trim(),
            number: number === '—' ? null : number.trim(),
            position: position === '—' ? null : position.trim(),
            bats_throws: batsThrows === '—' ? null : batsThrows.trim(),
            height: height === '—' ? null : height.trim(),
            weight: weight === '—' ? null : weight.trim(),
            team_category: teamCategory,
            stats_json: statsJson
        });
    }
    return players;
}

const allPlayers = [
    ...extractTeam('panel-u15', 'u15'),
    ...extractTeam('panel-u17d1', 'u17d1'),
    ...extractTeam('panel-u17d2', 'u17d2')
];

fs.writeFileSync(path.join(__dirname, 'extracted_players_v2.json'), JSON.stringify(allPlayers, null, 2));
console.log(`Extracted ${allPlayers.length} players. Data saved to extracted_players_v2.json`);
