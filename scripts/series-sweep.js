#!/usr/bin/env node
/**
 * series-sweep.js — PLAYOFF SERIES pitching sweep from GameChanger.
 *
 * The league files playoff games in a separate GC organization ("2026 -Séries 15U AAA",
 * see docs / gc-series-orgs). Public data never says which org a game belongs to, so this
 * script classifies through the authenticated tier, exactly like season-sweep.js:
 *
 *   /teams/{uuid}/schedule            -> event_id -> organization_id
 *   /organizations/{uuid}   (authed)  -> org name -> série/playoff regex
 *   /teams/{uuid}/game-summaries      -> games actually scored
 *   /game-stream-processing/{event_id}/boxscore -> per-player pitching lines, BOTH teams
 *
 * Output: per-game pitcher appearances (IP, #P pitch count, BF, H/R/ER/BB/SO) for every
 * team in the series, deduped (one entry per game), plus per-player aggregates.
 * Consumed by series-pitchers.html via assets/stats-series-pitchers.json.
 *
 * Run on the relay VPS (always-fresh token, and the browser UA is mandatory there):
 *
 *   docker run --rm -v relay_gctoken:/gct -v /tmp/series:/work node:20-alpine \
 *     node /work/series-sweep.js --token-file /gct/gctoken.json --out /work/series.json
 */

const fs = require('fs');

/* ── config ──────────────────────────────────────────────────────────── */
const GC = 'https://api.team-manager.gc.com';
const ORGS = { '15': 'xnQjeQyO7cFq', '17': 'x2GrNpCrYJa0' };
const SERIES_RE = /s[ée]rie|playoff|\bfinale?s?\b|\b(quart|demi)[- ]finale/i;
const EXCLUDE = ['Toronto Playgrounds'];
const CONCURRENCY = 6;

/* ── args ────────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const TOKEN_FILE = arg('--token-file');
const OUT = arg('--out', 'series.json');
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
    if (r.status === 401) { loadToken(); await sleep(500); continue; }
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

function ipToOuts(ip) {
  if (ip == null) return 0;
  const n = Number(ip);
  if (!isFinite(n)) return 0;
  const whole = Math.floor(n + 1e-9);
  const frac = Math.round((n - whole) * 10);
  return whole * 3 + (frac === 1 ? 1 : frac === 2 ? 2 : 0);
}
const outsToIp = (o) => Math.floor(o / 3) + (o % 3) / 10;
const isExcluded = (name) => EXCLUDE.some((e) => (name || '').includes(e));

/* ── main ────────────────────────────────────────────────────────────── */
(async () => {
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
  const orgNameCache = new Map();
  async function orgName(uuid) {
    if (!uuid) return '';
    if (orgNameCache.has(uuid)) return orgNameCache.get(uuid);
    const r = await gc(`/organizations/${uuid}`);
    const name = (r.status === 200 && r.body && (r.body.name || (r.body.organization || {}).name)) || '';
    orgNameCache.set(uuid, name);
    return name;
  }

  for (const [lg, slug] of Object.entries(ORGS)) {
    const pub = await gc(`/public/organizations/${slug}/teams`);
    if (pub.status !== 200) { console.error(`org ${slug} teams failed`, pub.status); continue; }
    const teams = pub.body
      .filter((t) => !isExcluded(t.name))
      .map((t) => ({ slug: t.id, name: t.name, uuid: (byName.get(t.name.trim()) || {}).id }))
      .filter((t) => t.uuid);
    console.log(`\n[${lg}U] ${teams.length} teams`);
    const nameBySlug = new Map(teams.map((t) => [t.slug, t.name]));

    /* 1. schedules -> classify every org uuid seen, find the series org(s) */
    const schedules = await pool(teams, async (t) => {
      const s = await gc(`/teams/${t.uuid}/schedule`);
      return s.status === 200 ? s.body : [];
    });
    const orgUuids = new Set();
    schedules.forEach((sch) => sch.forEach((e) => {
      if (e.event && e.event.organization_id) orgUuids.add(e.event.organization_id);
    }));
    const seriesOrgs = new Set();
    for (const u of orgUuids) {
      const n = await orgName(u);
      if (SERIES_RE.test(n)) { seriesOrgs.add(u); console.log(`[${lg}U] SERIES org: ${n} (${u})`); }
    }
    if (!seriesOrgs.size) { console.log(`[${lg}U] no series org found — skipping`); continue; }

    /* 2. per team: scored series games -> box scores (deduped across the two sides) */
    const seenGames = new Set();
    const games = [];
    const agg = new Map();   // player_id -> aggregate

    for (let ti = 0; ti < teams.length; ti++) {
      const t = teams[ti];
      const evMeta = new Map();
      (schedules[ti] || []).forEach((e) => {
        if (!e.event) return;
        evMeta.set(e.event.id, {
          org: e.event.organization_id || '',
          opp: (e.pregame_data || {}).opponent_name || '',
          start: e.event.start_ts || e.event.datetime
            || ((e.event.start || {}).datetime || (e.event.start || {}).date) || null,
          home_away: (e.pregame_data || {}).home_away || e.event.home_away || null,
        });
      });

      const gsum = await gc(`/teams/${t.uuid}/game-summaries`);
      const scored = gsum.status === 200 ? gsum.body : [];
      const series = scored.filter((g) => g.game_status === 'completed'
        && seriesOrgs.has((evMeta.get(g.event_id) || {}).org));
      if (!series.length) continue;
      console.log(`  ${t.name.padEnd(34)} ${series.length} series games scored`);

      await pool(series, async (g) => {
        const b = await gc(`/game-stream-processing/${g.event_id}/boxscore`);
        if (b.status !== 200 || !b.body) return;
        const meta = evMeta.get(g.event_id) || {};
        const slugs = Object.keys(b.body).sort();
        const day = String(meta.start || '').slice(0, 10) || (g.updated_at || '').slice(0, 10);
        const gameKey = `${day}|${slugs.join('|')}`;
        if (seenGames.has(gameKey)) return;
        seenGames.add(gameKey);

        const game = {
          key: gameKey, date: day, start: meta.start || null,
          teams: slugs.map((s) => ({
            slug: s,
            name: nameBySlug.get(s) || ((b.body[s].team || {}).name) || s,
            score: null,
          })),
          pitchers: [],
        };
        // score from the fetching side's summary (owning = t.slug)
        game.teams.forEach((tm) => {
          tm.score = tm.slug === t.slug ? (g.owning_team_score ?? null) : (g.opponent_team_score ?? null);
        });

        for (const s of slugs) {
          const node = b.body[s];
          const pname = new Map();
          (node.players || []).forEach((p) => {
            pname.set(p.id, { name: `${p.first_name} ${p.last_name}`.trim(), number: p.number });
          });
          (node.groups || []).forEach((grp) => {
            if (grp.category === 'lineup') return;   // pitching group only
            const lines = new Map();
            (grp.stats || []).forEach((row) => {
              if (!row.player_id) return;
              const v = row.stats || {};
              lines.set(row.player_id, {
                player_id: row.player_id,
                name: (pname.get(row.player_id) || {}).name || row.player_id,
                number: (pname.get(row.player_id) || {}).number || '',
                team: nameBySlug.get(s) || s,
                team_slug: s,
                order: lines.size,
                IP: outsToIp(ipToOuts(v.IP)), outs: ipToOuts(v.IP),
                H: +v.H || 0, R: +v.R || 0, ER: +v.ER || 0, BB: +v.BB || 0, SO: +v.SO || 0,
                P: null, BF: null,
                tag: /\((W|L|SV?)\)/.exec(row.player_text || '')?.[1] || '',
              });
            });
            (grp.extra || []).forEach((ex) => {
              if (!Array.isArray(ex.stats)) return;
              ex.stats.forEach((e2) => {
                const ln = lines.get(e2.player_id);
                if (!ln) return;
                if (ex.stat_name === '#P') ln.P = +e2.value || 0;
                else if (ex.stat_name === 'BF') ln.BF = +e2.value || 0;
              });
            });
            lines.forEach((ln) => game.pitchers.push(ln));
          });
        }
        games.push(game);
      });
    }

    games.sort((a, b) => String(a.start || a.date).localeCompare(String(b.start || b.date)));

    /* 3. aggregates */
    games.forEach((g) => g.pitchers.forEach((ln) => {
      const a = agg.get(ln.player_id) || {
        player_id: ln.player_id, name: ln.name, number: ln.number, team: ln.team,
        G: 0, outs: 0, P: 0, BF: 0, H: 0, R: 0, ER: 0, BB: 0, SO: 0, W: 0, L: 0, SV: 0,
        games: [],
      };
      a.G++; a.outs += ln.outs; a.P += ln.P || 0; a.BF += ln.BF || 0;
      a.H += ln.H; a.R += ln.R; a.ER += ln.ER; a.BB += ln.BB; a.SO += ln.SO;
      if (ln.tag === 'W') a.W++; else if (ln.tag === 'L') a.L++; else if (ln.tag) a.SV++;
      a.games.push({ date: g.date, key: g.key, P: ln.P, IP: outsToIp(ln.outs) });
      agg.set(ln.player_id, a);
    }));
    const pitchers = [...agg.values()].map((a) => ({
      ...a, IP: outsToIp(a.outs),
    })).sort((x, y) => y.P - x.P);

    out.leagues[lg] = {
      series_orgs: [...seriesOrgs].map((u) => ({ uuid: u, name: orgNameCache.get(u) })),
      games, pitchers,
    };
    console.log(`[${lg}U] ${games.length} unique series games, ${pitchers.length} pitchers`);
  }

  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`\nwrote ${OUT} (${calls} GC calls)`);
})();
