const fs = require('fs');
const path = require('path');

const JSON_FILES = [
    '../Updates/u15-stats-2026-04-28.json',
    '../Updates/u17d1-stats-2026-04-28.json',
    '../Updates/u17d2-stats-2026-04-28.json'
];

const SRC_FILE = 'alignement.html';
const PREVIEW_FILE = 'preview/alignement.html';

function formatStat(val, key) {
    if (val === null || val === undefined) return '—';
    if (key === 'IP') return String(val);
    const num = parseFloat(val);
    if (['AVG', 'OBP', 'SLG', 'OPS'].includes(key) && num < 1 && num >= 0) {
        let s = num.toFixed(3);
        if (s.startsWith('0.')) return s.substring(1);
        return s;
    }
    if (['ERA', 'WHIP'].includes(key)) return num.toFixed(3);
    return String(val);
}

function generateBlock(player, type) {
    const data = player[type];
    if (type === 'pitching' && Object.values(data).every(v => v === null)) return null;

    let stats = [];
    if (type === 'batting') {
        stats = [
            { key: 'GP', val: data.GP }, { key: 'PA', val: data.PA }, { key: 'AB', val: data.AB },
            { key: 'AVG', val: data.AVG, highlight: true }, { key: 'H', val: data.H },
            { key: '2B', val: data['2B'] }, { key: '3B', val: data['3B'] }, { key: 'HR', val: data.HR },
            { key: 'RBI', val: data.RBI }, { key: 'R', val: data.R }, { key: 'BB', val: data.BB },
            { key: 'SO', val: data.SO }, { key: 'OBP', val: data.OBP }, { key: 'SLG', val: data.SLG },
            { key: 'OPS', val: data.OPS }
        ];
    } else {
        stats = [
            { key: 'IP', val: data.IP, highlight: true }, { key: 'GP', val: data.GP }, { key: 'GS', val: data.GS },
            { key: 'BF', val: data.BF }, { key: 'W', val: data.W }, { key: 'L', val: data.L },
            { key: 'SV', val: data.SV }, { key: 'ERA', val: data.ERA }, { key: 'SO', val: data.SO },
            { key: 'BB', val: data.BB }, { key: 'WHIP', val: data.WHIP }, { key: 'H', val: data.H },
            { key: 'R', val: data.R }, { key: 'ER', val: data.ER }
        ];
    }

    let gridHtml = '                <div class="stat-grid">\n';
    stats.forEach(s => {
        const valStr = formatStat(s.val, s.key);
        const highlightClass = s.highlight ? ' highlight' : '';
        gridHtml += `                  <div class="stat-cell"><span class="stat-val${highlightClass}">${valStr}</span><span class="stat-key">${s.key}</span></div>\n`;
    });
    gridHtml += '                </div>';

    return `
                <div class="historical-block">
                  <div class="historical-label fr-text">Saison 2025 — Historique</div>
                  <div class="historical-label en-text">2025 Season — Historical</div>
${gridHtml}
                </div>`;
}

function run() {
    let html = fs.readFileSync(SRC_FILE, 'utf8');
    const playersMap = {};
    JSON_FILES.forEach(file => {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'));
        data.players.forEach(p => { if (p.status === 'approved') playersMap[p.html_id] = p; });
    });

    // Split by panel start tag, keeping the tags
    const parts = html.split(/(<div class="stat-panel[^"]*" id="[^"]+">)/i);
    const newParts = [parts[0]];

    for (let i = 1; i < parts.length; i += 2) {
        const tag = parts[i];
        let content = parts[i + 1];

        const match = tag.match(/id="([^"]+)-(bat|pit)"/i);
        if (match) {
            const playerId = match[1];
            const type = match[2];
            const player = playersMap[playerId];

            if (player) {
                const block = generateBlock(player, type === 'bat' ? 'batting' : 'pitching');
                if (block) {
                    // We need to find the end of the panel content
                    // The panel content ends at the closing </div> at 14 spaces indentation
                    const panelEndIdx = content.indexOf('\n              </div>');
                    if (panelEndIdx !== -1) {
                        let inner = content.substring(0, panelEndIdx);
                        const rest = content.substring(panelEndIdx);

                        if (inner.includes('class="historical-block"')) {
                            // Replace existing historical-block
                            inner = inner.replace(/<div class="historical-block">[\s\S]*<\/div>/i, block.trim());
                        } else {
                            // Append before closing div
                            inner = inner.trimEnd() + block + '\n';
                        }
                        content = inner + rest;
                    }
                }
            }
        }
        newParts.push(tag);
        newParts.push(content);
    }

    fs.writeFileSync(PREVIEW_FILE, newParts.join(''));
    console.log(`Wrote ${PREVIEW_FILE}`);
}

run();
