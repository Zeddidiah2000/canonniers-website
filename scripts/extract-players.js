const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'alignement.html');
const content = fs.readFileSync(filePath, 'utf-8');

function extractTeam(panelId, teamCategory) {
    const players = [];
    const panelRegex = new RegExp(`<div class="team-panel[^"]*" id="${panelId}">([\\s\\S]*?)<div class="roster-section">\\s*<div class="section-header">\\s*<span class="fr-text">Personnel</span>`, 'i');
    const panelMatch = content.match(panelRegex);
    
    if (!panelMatch) {
        console.log(`Panel ${panelId} not found`);
        return [];
    }

    const panelContent = panelMatch[1];
    const playerRowRegex = /<tr class="has-stats" onclick="toggleDrawer\('([^']+)'\)"><td><span class="num-badge(?: no-num)?">([^<]*)<\/span><\/td><td class="player-name"><span class="player-toggle">([^<]+)<\/span><\/td><td class="center"><span class="pos-badge">([^<]*)<\/span><\/td><td class="center bt-cell">([^<]*)<\/td><td class="center ht-cell">([^<]*)<\/td><td class="center wt-cell">([^<]*)<\/td><\/tr>/g;
    
    let match;
    while ((match = playerRowRegex.exec(panelContent)) !== null) {
        const [full, id, number, name, position, batsThrows, height, weight] = match;
        
        // Extract stats for this player
        const drawerRegex = new RegExp(`<tr class="stats-drawer" id="drawer-${id}">([\\s\\S]*?)<\\/tr>`, 'i');
        const drawerMatch = panelContent.match(drawerRegex);
        let statsJson = null;

        if (drawerMatch) {
            const drawerContent = drawerMatch[1];
            const historicalBlockMatch = drawerContent.match(/<div class="historical-block">([\s\S]*?)<\/div>\s*<\/div>/g);
            
            if (historicalBlockMatch) {
                const stats = {};
                historicalBlockMatch.forEach(block => {
                    const isBatting = block.includes('batting') || block.includes('bâton');
                    const type = isBatting ? 'batting' : 'pitching';
                    const gridMatch = block.match(/<div class="stat-grid">([\s\S]*?)<\/div>/);
                    
                    if (gridMatch) {
                        const gridContent = gridMatch[1];
                        const cellRegex = /<div class="stat-cell"><span class="stat-val[^"]*">([^<]*)<\/span><span class="stat-key">([^<]*)<\/span><\/div>/g;
                        const blockStats = {};
                        let cellMatch;
                        while ((cellMatch = cellRegex.exec(gridContent)) !== null) {
                            blockStats[cellMatch[2]] = cellMatch[1];
                        }
                        stats[type] = blockStats;
                    }
                });
                statsJson = JSON.stringify(stats);
            }
        }

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

fs.writeFileSync(path.join(__dirname, 'extracted_players.json'), JSON.stringify(allPlayers, null, 2));
console.log(`Extracted ${allPlayers.length} players. Data saved to extracted_players.json`);
