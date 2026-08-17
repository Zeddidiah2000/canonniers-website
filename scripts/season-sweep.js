#!/usr/bin/env node
/**
 * season-sweep.js — LEAGUE-ONLY (regular season) stats sweep from GameChanger.
 *
 * Why this exists: GC's /teams/{uuid}/season-stats is a whole-season aggregate — it
 * includes tournaments, exhibitions and any other game the team keeps a book for. The
 * Canonniers score every game, most rivals don't, so season totals are not comparable
 * across the league (2026-08: Canonniers 15U 54 GP vs 34 league games).
 *
 * This script rebuilds the stats from per-game box scores, keeping ONLY the games whose
 * calendar event belongs to the league organization:
 *
 *   /teams/{uuid}/schedule          -> event_id -> organization_id  (league vs tournament vs none)
 *   /teams/{uuid}/game-summaries    -> the games that were actually scored in GC
 *   /game-stream-processing/{event_id}/boxscore  -> per-player lines, both teams
 *
 * Output: assets/stats-season.json  (consumed by stats-season.html, an unlisted page).
 *
 * Run it on the relay VPS so it uses the always-fresh token from the `relay_gctoken`
 * docker volume (Jay's standing instruction — never ask for a pasted token):
 *
 *   docker run --rm -v relay_gctoken:/gct -v /tmp/season:/work node:20-alpine \
 *     node /work/season-sweep.js --token-file /gct/gctoken.json --out /work/stats-season.json
 *
 * Locally you can pass --token / --device instead.
 */

const fs = require('fs');

/* ── config ──────────────────────────────────────────────────────────── */
const GC = 'https://api.team-manager.gc.com';
const ORGS = { '15': 'xnQjeQyO7cFq', '17': 'x2GrNpCrYJa0' };
// League data-entry mistakes / non-QC guests — dropped from the leaderboards, and their
// games are dropped too so the sample matches the official standings.
const EXCLUDE = ['Toronto Playgrounds'];
const CONCURRENCY = 6;

/* ── args ────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TOKEN_FILE = arg('--token-file');
const OUT = arg('--out', 'stats-season.json');
let TOKEN = arg('--token');
let DEVICE = arg('--device');

function loadToken() {
  if (!TOKEN_FILE) return;
  const t = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  TOKEN = t.token; DEVICE = t.device_id;
}
loadToken();
if (!TOKEN) { console.error('no token (use --token-file or --token/--device)'); process.exit(1); }

/* ── fetch ───────────────────────────────────────────────────────────── */
const headers = () => ({
  // A browser User-Agent is not cosmetic: without it AWS WAF answers 403 from the VPS.
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'gc-token': TOKEN,
  'gc-app-name': 'web',
  'gc-device-id': DEVICE || '',
  accept: 'application/json',
  origin: 'https://web.gc.com',
  referer: 'https://web.gc.com/',
});

let calls = 0;
async function gc(path, accept) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const h = headers();
    if (accept) h.accept = accept;
    let r;
    try {
      r = await fetch(GC + path, { headers: h });
    } catch (e) {
      await sleep(600 * (attempt + 1));
      continue;
    }
    calls++;
    if (r.status === 401) { loadToken(); await sleep(500); continue; }  // refresher may have rotated it
    if (r.status === 429 || r.status >= 500) { await sleep(900 * (attempt + 1)); continue; }
    if (!r.ok) return { status: r.status, body: null };
    return { status: 200, body: await r.json() };
  }
  return { status: 0, body: null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pool(items, worker, n = CONCURRENCY) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await worker(items[k], k); }
  }));
  return out;
}

/* ── stat helpers ────────────────────────────────────────────────────── */
// GC ships IP as 4.1 / 4.2 meaning 4⅓ / 4⅔. Accumulate in outs, never in decimals.
function ipToOuts(ip) {
  if (ip == null) return 0;
  const n = Number(ip);
  if (!isFinite(n)) return 0;
  const whole = Math.floor(n + 1e-9);
  const frac = Math.round((n - whole) * 10);
  return whole * 3 + (frac === 1 ? 1 : frac === 2 ? 2 : 0);
}
const outsToIp = (o) => Math.floor(o / 3) + (o % 3) / 10;
const r3 = (x) => (isFinite(x) ? Math.round(x * 1000) / 1000 : 0);
const r2 = (x) => (isFinite(x) ? Math.round(x * 100) / 100 : 0);
const isExcluded = (name) => EXCLUDE.some((e) => (name || '').includes(e));

/* ── main ────────────────────────────────────────────────────────────── */
(async () => {
  // The stats endpoints are membership-gated: the account has to follow a team before it
  // can read that team's game summaries / box scores. Follow everything first (StatsUP's
  // cleanup.ps1 unfollows the non-Canonniers teams again afterwards).
  for (const slug of Object.values(ORGS)) {
    const pub = await gc(`/public/organizations/${slug}/teams`);
    if (pub.status !== 200) continue;
    await pool(pub.body, async (t) => {
      await fetch(`${GC}/teams/public/${t.id}/follow`, { method: 'POST', headers: headers() })
        .catch(() => {});
    });
  }

  const me = await gc('/me/teams?include=user_team_associations',
    'application/vnd.gc.com.team:list+json; version=0.10.0');
  if (me.status !== 200) { console.error('me/teams failed', me.status); process.exit(1); }
  const byName = new Map(me.body.map((t) => [t.name.trim(), t]));

  const out = { generated: new Date().toISOString().slice(0, 10), leagues: {} };
  const statNamesSeen = new Set();

  for (const [lg, slug] of Object.entries(ORGS)) {
    const pub = await gc(`/public/organizations/${slug}/teams`);
    if (pub.status !== 200) { console.error(`org ${slug} teams failed`, pub.status); continue; }
    const teams = pub.body
      .filter((t) => !isExcluded(t.name))
      .map((t) => ({ slug: t.id, name: t.name, uuid: (byName.get(t.name.trim()) || {}).id }))
      .filter((t) => t.uuid);
    console.log(`\n[${lg}U] ${teams.length} teams`);

    /* 1. schedules -> event_id -> organization_id, and vote on the league org uuid */
    const schedules = await pool(teams, async (t) => {
      const s = await gc(`/teams/${t.uuid}/schedule`);
      return s.status === 200 ? s.body : [];
    });
    const votes = new Map();
    schedules.forEach((sch) => {
      const c = new Map();
      sch.filter((e) => e.event && e.event.event_type === 'game' && e.event.status !== 'canceled')
        .forEach((e) => {
          const o = e.event.organization_id || '';
          c.set(o, (c.get(o) || 0) + 1);
        });
      const best = [...c.entries()].filter(([o]) => o).sort((a, b) => b[1] - a[1])[0];
      if (best) votes.set(best[0], (votes.get(best[0]) || 0) + 1);
    });
    const leagueOrg = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!leagueOrg || leagueOrg[1] < teams.length / 2) {
      console.error(`[${lg}U] could not agree on a league org id`, [...votes]); continue;
    }
    const LEAGUE_ORG = leagueOrg[0];
    console.log(`[${lg}U] league org ${LEAGUE_ORG} (${leagueOrg[1]}/${teams.length} teams agree)`);

    /* 2. per team: scored games ∩ league events -> box scores */
    const teamOut = [];
    for (let ti = 0; ti < teams.length; ti++) {
      const t = teams[ti];
      const orgOf = new Map();
      const oppOf = new Map();
      (schedules[ti] || []).forEach((e) => {
        if (!e.event) return;
        orgOf.set(e.event.id, e.event.organization_id || '');
        if (e.pregame_data) oppOf.set(e.event.id, e.pregame_data.opponent_name || '');
      });

      const gsum = await gc(`/teams/${t.uuid}/game-summaries`);
      const scored = gsum.status === 200 ? gsum.body : [];
      const played = scored.filter((g) => g.game_status === 'completed');
      const league = played.filter((g) => orgOf.get(g.event_id) === LEAGUE_ORG
        && !isExcluded(oppOf.get(g.event_id)));

      const bat = new Map(); const pit = new Map(); const names = new Map();
      let runsFor = 0, runsAgainst = 0, w = 0, l = 0, tie = 0, boxOk = 0;

      await pool(league, async (g) => {
        const b = await gc(`/game-stream-processing/${g.event_id}/boxscore`);
        if (b.status !== 200 || !b.body || !b.body[t.slug]) return;
        boxOk++;
        runsFor += g.owning_team_score || 0;
        runsAgainst += g.opponent_team_score || 0;
        if (g.owning_team_score > g.opponent_team_score) w++;
        else if (g.owning_team_score < g.opponent_team_score) l++;
        else tie++;

        const node = b.body[t.slug];
        (node.players || []).forEach((p) => {
          names.set(p.id, { name: `${p.first_name} ${p.last_name}`.trim(), number: p.number });
        });

        (node.groups || []).forEach((grp) => {
          const isBat = grp.category === 'lineup';
          const store = isBat ? bat : pit;
          (grp.stats || []).forEach((row) => {
            if (!row.player_id) return;
            const s = store.get(row.player_id) || (isBat
              // SHF = GC's combined sacrifice hits + flies. GC's own OBP denominator is
              // AB+BB+HBP+SHF (verified against season-stats to 4 decimals), so keep it.
              ? { G: 0, AB: 0, R: 0, H: 0, RBI: 0, BB: 0, SO: 0, '2B': 0, '3B': 0, HR: 0, TB: 0, HBP: 0, SB: 0, CS: 0, SHF: 0, E: 0 }
              : { G: 0, outs: 0, H: 0, R: 0, ER: 0, BB: 0, SO: 0, HR: 0, BF: 0, P: 0, W: 0, L: 0, SV: 0 });
            s.G++;
            const v = row.stats || {};
            if (isBat) {
              s.AB += +v.AB || 0; s.R += +v.R || 0; s.H += +v.H || 0;
              s.RBI += +v.RBI || 0; s.BB += +v.BB || 0; s.SO += +v.SO || 0;
            } else {
              s.outs += ipToOuts(v.IP); s.H += +v.H || 0; s.R += +v.R || 0;
              s.ER += +v.ER || 0; s.BB += +v.BB || 0; s.SO += +v.SO || 0;
              const tag = (row.player_text || '');
              if (/\(W\)/.test(tag)) s.W++;
              if (/\(L\)/.test(tag)) s.L++;
              if (/\(S(V)?\)/.test(tag)) s.SV++;
            }
            store.set(row.player_id, s);
          });
          // "extra" carries the stats that don't fit the classic box line, keyed by player.
          (grp.extra || []).forEach((ex) => {
            const key = ex.stat_name;
            statNamesSeen.add(`${grp.category}:${key}`);
            if (!Array.isArray(ex.stats)) return;
            ex.stats.forEach((e2) => {
              const s = store.get(e2.player_id);
              if (!s) return;
              const val = +e2.value || 0;
              if (isBat) {
                if (key in s) s[key] += val;
              } else if (key === 'BF') s.BF += val;
              else if (key === '#P') s.P += val;
              else if (key === 'HR') s.HR += val;
            });
          });
        });
      });

      const batters = [...bat.entries()].map(([id, s]) => {
        const meta = names.get(id) || { name: id, number: '' };
        const PA = s.AB + s.BB + s.HBP + s.SHF;
        const obpDen = PA;
        const avg = s.AB ? s.H / s.AB : 0;
        const obp = obpDen ? (s.H + s.BB + s.HBP) / obpDen : 0;
        const slg = s.AB ? s.TB / s.AB : 0;
        return {
          id, name: meta.name, number: meta.number, team: t.name,
          GP: s.G, PA, AB: s.AB, H: s.H, '2B': s['2B'], '3B': s['3B'], HR: s.HR,
          RBI: s.RBI, R: s.R, BB: s.BB, SO: s.SO, HBP: s.HBP, SB: s.SB, CS: s.CS, TB: s.TB,
          AVG: r3(avg), OBP: r3(obp), SLG: r3(slg), OPS: r3(obp + slg),
        };
      }).filter((p) => p.AB > 0 || p.PA > 0);

      const pitchers = [...pit.entries()].map(([id, s]) => {
        const meta = names.get(id) || { name: id, number: '' };
        const ip = s.outs / 3;
        return {
          id, name: meta.name, number: meta.number, team: t.name,
          G: s.G, IP: r2(outsToIp(s.outs)), outs: s.outs,
          W: s.W, L: s.L, SV: s.SV, H: s.H, R: s.R, ER: s.ER, BB: s.BB, SO: s.SO,
          BF: s.BF, P: s.P,
          ERA: ip ? r2((s.ER * 7) / ip) : 0,          // 7-inning basis, same as stats.html
          WHIP: ip ? r2((s.H + s.BB) / ip) : 0,
          'K/G': ip ? r2((s.SO * 7) / ip) : 0,
          'K/BB': s.BB ? r2(s.SO / s.BB) : (s.SO ? 99 : 0),
        };
      }).filter((p) => p.outs > 0);

      const teamAB = batters.reduce((a, p) => a + p.AB, 0);
      const teamH = batters.reduce((a, p) => a + p.H, 0);
      const teamOuts = pitchers.reduce((a, p) => a + p.outs, 0);
      const teamER = pitchers.reduce((a, p) => a + p.ER, 0);

      teamOut.push({
        name: t.name, slug: t.slug,
        games_league: boxOk,
        games_scored_all: played.length,          // everything GC has a book for
        games_non_league: played.length - league.length,
        record: { w, l, t: tie },
        runs_for: runsFor, runs_against: runsAgainst,
        team_avg: teamAB ? r3(teamH / teamAB) : 0,
        team_era: teamOuts ? r2((teamER * 7) / (teamOuts / 3)) : 0,
        batters, pitchers,
      });
      console.log(`  ${t.name.padEnd(34)} league ${boxOk}/${league.length} boxscores  (scored all-comp: ${played.length})`);
    }

    out.leagues[lg] = { org: slug, league_org_uuid: LEAGUE_ORG, teams: teamOut };
  }

  out.stat_names_seen = [...statNamesSeen].sort();
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nwrote ${OUT} (${calls} GC calls)`);
  console.log('extra stat names seen:', out.stat_names_seen.join(' '));
})();
