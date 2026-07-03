// canonniers-standings-worker
//
// Caches league standings, team rosters, active tournaments, and per-team
// regular-season games from GameChanger's public team-manager API.
//
// KV blob (key 'all'):
//   {
//     updated_at: ISO,
//     u15: { league_name, our_team_ids, teams[], updated_at },
//     u17: { league_name, our_team_ids, teams[], updated_at },
//     tournaments: [ { org_id, name, type, start_date, end_date, league,
//                      our_team_ids, teams[], our_games[], updated_at } ],
//     season_games: { u15: games[], u17d1: games[], u17d2: games[] },
//     season_games_updated_at: ISO,
//   }
//
// Each season_games entry may also carry, once a game enters the activity
// window, live enrichment from GC's richer event tier (reference_gc_live_endpoints):
//   event_id: GC event id (≠ team-schedule game id; resolved + cached on the record)
//   live:     { status, inning, half ('top'|'bottom'), outs (0-2, current half),
//               total_outs (raw cumulative), updated_at }
// `live` is additive — it never overwrites `score` / `game_status`.
//
// Logos: harvested from Spordle (via SPORDLE_PROXY service binding) using each
// game's homeTeam/awayTeam objects. Spordle's CloudFront URLs are permanent and
// cover every team we play in-league; GC's signed avatar URLs are used as
// fallback for league teams, and as the primary source for tournament-only
// opponents (Ontario programs etc. that never appear in our Spordle schedule).
//
// Endpoints:
//   GET  /api/standings         — public, whole KV blob
//   GET  /api/team-logo?name=X  — public, mascotKey → known logo
//   POST /api/standings/refresh — public manual full refresh
//
// Crons:
//   - Full refresh (4×/day at 11:00 / 17:00 / 22:00 / 02:30 UTC = 07:00 /
//     13:00 / 18:00 / 22:30 ET): leagues + tournaments + season_games, and
//     backfills finals into the canonniers-results-worker KV (RESULTS, keyed
//     by spordle_game_id) via a date+opponent join against the Spordle
//     schedule.
//   - Lightweight (*/2 min): refreshes season_games only (with no-store + UA +
//     one retry on empty, and live inning/half/outs enrichment for in-window
//     games). Idle-skips the GC fetch when no cached game's start_ts is in
//     [-6h, +30min].

const GC_API = 'https://api.team-manager.gc.com/public';
const SPORDLE_OFFICE_ID = 4168;

const LEAGUES = {
  u15: {
    org_id: 'xnQjeQyO7cFq',
    league_name: '2026 -Saison 15U AAA',
    our_team_ids: { u15: 'aMDDLssAvjFT' },
    spordle_team_ids: [156779],
    // Toronto Playgrounds Elite appears in the GC org listing but isn't part
    // of our league's actual schedule — exclude from the public standings.
    excluded_team_ids: ['iSAMte1FZlBR'],
  },
  u17: {
    org_id: 'x2GrNpCrYJa0',
    league_name: '2026 -Saison 17U AAA',
    our_team_ids: { u17d1: 'ri4fPQu1DiQS', u17d2: '0DLnmx5bPCGz' },
    spordle_team_ids: [156780, 156781],
    excluded_team_ids: [],
  },
};

// Per-team identity map for GC ↔ Spordle joins. Single source of truth for
// the season-games harvester and the results-worker KV backfill.
const OUR_TEAMS = {
  u15:   { gc_team_id: 'aMDDLssAvjFT', spordle_team_id: 156779, league: 'u15' },
  u17d1: { gc_team_id: 'ri4fPQu1DiQS', spordle_team_id: 156780, league: 'u17' },
  u17d2: { gc_team_id: '0DLnmx5bPCGz', spordle_team_id: 156781, league: 'u17' },
};

// Active GC tournament orgs we want to surface (logos + standings + bracket).
// Each entry tells the worker which of our LEAGUES the tournament belongs to,
// so the /api/team-logo lookup and any frontend widget can scope correctly.
// Add a new entry + redeploy when a new tournament starts.
const TOURNAMENTS = [
  // Tournoi 17U AAA BSL — 2026-07-03 → 07-05, both 17U teams entered. Retire after ~07-06.
  { org_id: '8ek6ruK8yOGY', league: 'u17' },
  // Add an entry when a new GC tournament starts:
  // { org_id: '<gc_org_id>', league: 'u15' | 'u17' },
];

// GC's /teams/{id} returns avatar_url signed for ~7 minutes — too short to
// hot-link. Mirror those logos into the repo at /assets/team-logos/ and map
// them here by GC team_id; the override wins over GC's signed URL in
// fetchTournament. Spordle logos (used by league teams) are permanent and
// don't need this treatment.
//
// PNGs for prior tournament opponents (Toronto Mets, Tigers HPP, ONC Elite,
// Great Lake Canadians) remain in /assets/team-logos/ — re-add the mapping
// here if any of those orgs appears in a future tournament.
const LOGO_OVERRIDES = {
  // Tournoi 17U AAA BSL (org 8ek6ruK8yOGY) — GC avatar_image URLs are signed and
  // expire ~7 min, so mirror to /assets/team-logos/ and map by GC team_id.
  'ri4fPQu1DiQS': 'https://canonniersdequebec.ca/assets/team-logos/canonniers1-17u.jpg',
  '0DLnmx5bPCGz': 'https://canonniersdequebec.ca/assets/team-logos/canonniers2-17u.jpg',
  'FJmfXSC6Mj0p': 'https://canonniersdequebec.ca/assets/team-logos/patriotes-17u.jpg',
  'AdtP2isDrQAf': 'https://canonniersdequebec.ca/assets/team-logos/faucons-17u.jpg',
  '3M4St6gCLEgY': 'https://canonniersdequebec.ca/assets/team-logos/phoenix-17u.jpg',
  'EGQYXD5lEdSA': 'https://canonniersdequebec.ca/assets/team-logos/pionniers-17u.jpg',
  'ZjLXO48qS4kn': 'https://canonniersdequebec.ca/assets/team-logos/riverains-17u.jpg',
  'XwqDzXEj3z4L': 'https://canonniersdequebec.ca/assets/team-logos/3l-17u.jpg',
  'OkQEQlD3T0Ax': 'https://canonniersdequebec.ca/assets/team-logos/pei-selects-17u.jpg',
  // These 3 have no GC avatar_image — sourced manually: Marquis from the Spordle
  // regular-season league logo; Mudcats + Baseball NB from their Facebook pages.
  // (Tyrans d'Outaouais AEdsWYFi6sg6 has no findable logo — falls back to initials.)
  'tBoXykCHd9Z8': 'https://canonniersdequebec.ca/assets/team-logos/marquis-17u.png',
  'xdw5PCmceoVF': 'https://canonniersdequebec.ca/assets/team-logos/mudcats-17u.jpg',
  'QKRjFGQzo16W': 'https://canonniersdequebec.ca/assets/team-logos/baseball-nb-17u.jpg',
  // '<gc_team_id>': 'https://canonniersdequebec.ca/assets/team-logos/<file>.png',
};

const KV_KEY         = 'all';
const RESULTS_KV_KEY = 'all';
const EDGE_CACHE_TTL = 300;

// Activity window for */2 min cron's idle-skip: refetch only if a cached game's
// start_ts is in [now - LOOKBACK, now + LOOKAHEAD]. Off-hours fire & skip cheap.
const ACTIVITY_LOOKBACK_MS  = 6  * 60 * 60 * 1000; // 6h — covers a long game
const ACTIVITY_LOOKAHEAD_MS = 30 * 60 * 1000;      // 30 min — pre-first-pitch

// GC uses 'completed' for a finished game; we canonicalize that to 'final' on
// write so the results-worker's status enum (final/forfeit/cancelled/postponed)
// stays clean for admin-results.html edits.
const GC_DONE_STATUSES = new Set(['completed', 'final', 'forfeit', 'cancelled', 'postponed']);

const CATS = ['u15', 'u17d1', 'u17d2'];

// Each team's GC league-org id, for the live event-detail enrichment tier
// (reference_gc_live_endpoints). Both 17U teams share the u17 org.
const ORG_FOR_CAT = Object.fromEntries(
  Object.entries(OUR_TEAMS).map(([cat, t]) => [cat, LEAGUES[t.league]?.org_id || null])
);

// A real browser-ish UA + edge-cache bypass on every GC subrequest. The freeze
// bug (project_standings_light_cron_bug) was the */2 cron's GC fetch getting
// empty 200s mid-game — the default Worker UA / edge cache was the prime
// suspect for the empty responses.
const GC_HEADERS = {
  'User-Agent': 'CanonniersStandingsWorker/1.0 (+https://canonniersdequebec.ca)',
  'Accept': 'application/json',
};

// Fetch + parse JSON from GC with the edge cache disabled and a real UA.
// retryOnEmpty: do ONE retry when the response is missing/empty (an empty 200
// for a team that should have games is the freeze signature). Returns parsed
// JSON, or null on hard failure.
async function gcFetchJSON(url, { retryOnEmpty = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let data = null;
    try {
      const r = await fetch(url, { headers: GC_HEADERS, cache: 'no-store' });
      if (r.ok) data = await r.json().catch(() => null);
    } catch (_) { data = null; }
    const empty = data == null || (Array.isArray(data) && data.length === 0);
    if (!empty || !retryOnEmpty || attempt === 1) return data;
    await new Promise(res => setTimeout(res, 300)); // brief backoff before the single retry
  }
  return null;
}

// Which categories have a cached game inside the [-6h, +30min] activity window
// right now. Drives both the lightweight cron's idle-skip and the
// empty-fetch-during-a-live-game flag in preserveOnEmpty.
function categoriesInActivityWindow(known) {
  const now = Date.now();
  const lo  = now - ACTIVITY_LOOKBACK_MS;
  const hi  = now + ACTIVITY_LOOKAHEAD_MS;
  const active = new Set();
  for (const cat of CATS) {
    for (const g of (known?.[cat] || [])) {
      if (!g || !g.start_ts) continue;
      const ts = new Date(g.start_ts).getTime();
      if (isNaN(ts)) continue;
      if (ts >= lo && ts <= hi) { active.add(cat); break; }
    }
  }
  return active;
}

// If GC returns 0 games for a team but our cached blob had games for that
// team, that's almost certainly a transient GC fetch failure — preserve the
// cached list rather than wiping good data (feedback_preserve_on_empty).
// Applied per-team so a partial outage (u15 fails, u17 fine) doesn't lose both.
//
// When a preserved team has a game in the activity window we additionally log a
// WARN. The retry in gcFetchJSON should make this rare, but if it still happens
// we want the freeze to be VISIBLE in `wrangler tail` instead of silently
// re-saving a pre-game snapshot (project_standings_light_cron_bug). We still
// preserve (don't wipe) — surfacing it is the new behaviour, not regressing it.
function preserveOnEmpty(fetched, cached, activeCategories = null) {
  const out = { u15: [], u17d1: [], u17d2: [] };
  for (const cat of CATS) {
    const fresh = (fetched && Array.isArray(fetched[cat])) ? fetched[cat] : [];
    const prior = (cached  && Array.isArray(cached[cat]))  ? cached[cat]  : [];
    if (fresh.length === 0 && prior.length > 0) {
      out[cat] = prior;
      if (activeCategories && activeCategories.has(cat)) {
        console.warn(`[standings] empty GC fetch for ${cat} during activity window — preserving ${prior.length} cached records (retry exhausted; possible live freeze)`);
      }
    } else {
      out[cat] = fresh;
    }
  }
  return out;
}

const ALLOWED_ORIGINS = [
  'https://canonniersdequebec.ca',
  'https://www.canonniersdequebec.ca',
  'https://canonniers-website.pages.dev',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : 'https://canonniersdequebec.ca';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Strip "-15U 2026" / "15U 2026" / "- 17U 2026" / "15U" suffix patterns and collapse whitespace.
//   "Canonniers -15U 2026 QC"            → "Canonniers QC"
//   "Faucons -15U 2026 Estrie R-Y"       → "Faucons Estrie R-Y"
//   "Phoenix-15U 2026 Mauricie CDQ"      → "Phoenix Mauricie CDQ"
//   "3L - 17U 2026 Rive-Nord"            → "3L Rive-Nord"
//   "Canonniers 1 -17U 2026 QC"          → "Canonniers 1 QC"
//   "Toronto Playgrounds 15U Elite"      → "Toronto Playgrounds Elite"
function cleanTeamName(raw) {
  return (raw || '')
    .replace(/\s*-?\s*\d{1,2}U(\s*\d{4})?\s*/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^-\s*/, '')
    .trim();
}

// First token, accent-stripped, lowercased. Used as the join key between GC team
// names and Spordle team names — each league has unique mascots, so the first
// token is a reliable discriminator:
//   "Faucons Estrie R-Y"                    → "faucons"
//   "FAUCONS DE L'ESTRIE RICHELIEU-YAMASKA" → "faucons"
//   "3L Rive-Nord"                          → "3l"
//   "3L DE LA RIVE-NORD"                    → "3l"
function mascotKey(name) {
  return (name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
    .split(/[\s\-]+/)[0] || '';
}

// YYYY-MM-DD in America/Toronto — defends the GC↔Spordle date join against UTC
// drift around midnight ET (GC's start_ts may be UTC; Spordle's startTime is
// local; naive .slice(0,10) on either side day-flips on late games).
function ymdInET(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// Query Spordle (via service binding) for each of our team's schedules. Returns
// both the { mascotKey → logoUrl } map (same shape the old fetchSpordleLogos
// produced) and a per-team game-id index keyed by `${ymd}|${oppMascotKey}` →
// Array<{ gameId, startTime }> sorted by startTime asc. The array form keeps
// both halves of a doubleheader joinable: previously the first game silently
// won the slot and the second forever lost the GC backfill.
async function fetchSpordleSchedule(env, spordleTeamIds) {
  const logos = {};
  const gameIdByTeam = new Map();
  if (!env.SPORDLE_PROXY) return { logos, gameIdByTeam };

  const settled = await Promise.allSettled(
    spordleTeamIds.map(tid =>
      env.SPORDLE_PROXY
        .fetch(`https://internal/?officeId=${SPORDLE_OFFICE_ID}&teamId=${tid}`)
        .then(r => ({ tid, r }))
    )
  );

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    const { tid, r } = result.value;
    if (!r.ok) continue;
    const games = await r.json().catch(() => []);
    if (!Array.isArray(games)) continue;

    const idx = new Map();
    for (const g of games) {
      // Logos
      for (const side of ['homeTeam', 'awayTeam']) {
        const t = g[side];
        if (!t || !t.name) continue;
        const k = mascotKey(t.name);
        if (k && !logos[k]) logos[k] = t.logo || t.logoUrl || null;
      }
      // game-id join key — now multi-valued so doubleheaders both stick.
      const gameId = g.id ?? null;
      const ymd    = ymdInET(g.startTime || g.date);
      if (!gameId || !ymd) continue;
      let oppName;
      if      (g.homeTeamId === tid) oppName = g.awayTeam?.name || '';
      else if (g.awayTeamId === tid) oppName = g.homeTeam?.name || '';
      else continue;
      const oppKey = mascotKey(oppName);
      if (!oppKey) continue;
      const key = `${ymd}|${oppKey}`;
      const arr = idx.get(key) || [];
      arr.push({ gameId, startTime: g.startTime || g.date || '' });
      idx.set(key, arr);
    }
    // Sort each bucket by startTime asc so game 1 of a doubleheader pairs
    // with GC game 1 (season_games is also start_ts asc — fetchOurSeasonGames
    // sorts at the end).
    for (const arr of idx.values()) {
      arr.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    }
    gameIdByTeam.set(tid, idx);
  }
  return { logos, gameIdByTeam };
}

async function fetchLeague(orgId, spordleLogos, excludedTeamIds = []) {
  const [standingsRes, teamsRes] = await Promise.all([
    fetch(`${GC_API}/organizations/${orgId}/standings`, { headers: GC_HEADERS, cache: 'no-store' }),
    fetch(`${GC_API}/organizations/${orgId}/teams`,     { headers: GC_HEADERS, cache: 'no-store' }),
  ]);
  if (!standingsRes.ok) throw new Error(`standings ${standingsRes.status}`);
  if (!teamsRes.ok)     throw new Error(`teams ${teamsRes.status}`);

  const standings = await standingsRes.json();
  const teamsList = await teamsRes.json();
  const excluded  = new Set(excludedTeamIds);

  const teamMap = Object.fromEntries(
    teamsList.map(t => {
      const cleanName = cleanTeamName(t.name);
      const spordleLogo =
        spordleLogos[mascotKey(cleanName)] ||
        spordleLogos[mascotKey(t.name)] ||
        null;
      return [t.id, {
        name:     cleanName,
        raw_name: t.name || '',
        logo:     spordleLogo || t.avatar_image || null,
      }];
    })
  );

  return standings
    .filter(row => !excluded.has(row.team_id))
    .map(row => {
      const meta = teamMap[row.team_id] || { name: row.team_id, raw_name: row.team_id, logo: null };
      return {
        team_id:     row.team_id,
        name:        meta.name,
        raw_name:    meta.raw_name,
        logo:        meta.logo,
        overall:     row.overall,
        winning_pct: row.winning_pct,
        runs:        row.runs,
        last10:      row.last10,
        streak:      row.streak,
        home:        row.home,
        away:        row.away,
      };
    })
    .sort((a, b) => {
      if (b.winning_pct !== a.winning_pct) return b.winning_pct - a.winning_pct;
      return (b.runs?.differential ?? 0) - (a.runs?.differential ?? 0);
    });
}

// Fetch a tournament org's metadata, participating teams (with avatar URLs),
// and current standings. Returns null on failure so the caller can preserve
// prior data without short-circuiting the whole refresh.
async function fetchTournament(cfg) {
  const { org_id, league } = cfg;
  const [orgRes, teamsRes, standingsRes] = await Promise.all([
    fetch(`${GC_API}/organizations/${org_id}`,           { headers: GC_HEADERS, cache: 'no-store' }),
    fetch(`${GC_API}/organizations/${org_id}/teams`,     { headers: GC_HEADERS, cache: 'no-store' }),
    fetch(`${GC_API}/organizations/${org_id}/standings`, { headers: GC_HEADERS, cache: 'no-store' }),
  ]);
  if (!orgRes.ok)   throw new Error(`tournament org ${orgRes.status}`);
  if (!teamsRes.ok) throw new Error(`tournament teams ${teamsRes.status}`);

  const org       = await orgRes.json();
  const teamsList = await teamsRes.json();
  const standings = standingsRes.ok ? await standingsRes.json() : [];

  const teamMap = Object.fromEntries(
    teamsList.map(t => [t.id, {
      team_id:  t.id,
      name:     cleanTeamName(t.name),
      raw_name: t.name || '',
      logo:     LOGO_OVERRIDES[t.id] || t.avatar_url || t.avatar_image || null,
    }])
  );

  // Use standings order if upstream provides one; otherwise team-list order.
  const ordered = standings.length
    ? standings.map(row => ({ row, meta: teamMap[row.team_id] }))
    : teamsList.map(t => ({ row: null, meta: teamMap[t.id] }));

  const teams = ordered
    .filter(x => x.meta)
    .map(({ row, meta }) => ({
      ...meta,
      overall:     row?.overall     ?? null,
      winning_pct: row?.winning_pct ?? null,
      runs:        row?.runs        ?? null,
      last10:      row?.last10      ?? null,
      streak:      row?.streak      ?? null,
      home:        row?.home        ?? null,
      away:        row?.away        ?? null,
    }));

  return {
    org_id,
    name:         org.name        || null,
    type:         org.type        || 'tournament',
    start_date:   org.start_date  || null,
    end_date:     org.end_date    || null,
    league,
    our_team_ids: LEAGUES[league]?.our_team_ids || null,
    teams,
  };
}

// For each of our GC team_ids, fetch /teams/{id}/games and pick out games
// that fall inside a tournament's date window AND whose opponent resolves
// (via mascotKey) to a team in that tournament. Both checks are required —
// the participant list usually includes league teams we play year-round, so
// without the date filter every season-long game vs Faucons/Phoenix/etc. would
// be misattributed as a tournament game. Returns a Map keyed by tournament
// org_id → games[].
async function fetchOurTournamentGames(ourTeamIds, tournaments) {
  // Per-tournament opponent index + date window.
  // mascotKey → [{ tournament, team, startDate, endDate }, ...] (multi in case
  // two tournaments share an opponent — first window match wins).
  const opponentIndex = new Map();
  for (const tournament of tournaments) {
    const startDate = (tournament.start_date || '').slice(0, 10);
    const endDate   = (tournament.end_date   || '').slice(0, 10);
    if (!startDate || !endDate) continue;
    for (const team of tournament.teams || []) {
      const key = mascotKey(team.name);
      if (!key) continue;
      const arr = opponentIndex.get(key) || [];
      arr.push({ tournament, team, startDate, endDate });
      opponentIndex.set(key, arr);
    }
  }
  const byTournament = new Map();
  if (opponentIndex.size === 0 || ourTeamIds.length === 0) return byTournament;

  const results = await Promise.allSettled(
    ourTeamIds.map(tid => gcFetchJSON(`${GC_API}/teams/${tid}/games`, { retryOnEmpty: true }))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    const ourTeamId = ourTeamIds[i];
    const list = r.value;
    for (const g of list) {
      const oppName  = g.opponent_team?.name || '';
      const gameDate = (g.start_ts || '').slice(0, 10);
      if (!gameDate) continue;
      const candidates = opponentIndex.get(mascotKey(oppName));
      if (!candidates) continue;
      const match = candidates.find(c => gameDate >= c.startDate && gameDate <= c.endDate);
      if (!match) continue;
      const arr = byTournament.get(match.tournament.org_id) || [];
      arr.push({
        id:                   g.id,
        start_ts:             g.start_ts,
        end_ts:               g.end_ts,
        timezone:             g.timezone || 'America/Toronto',
        home_away:            g.home_away || null,
        game_status:          g.game_status || 'scheduled',
        has_videos_available: !!g.has_videos_available,
        has_live_stream:      !!g.has_live_stream,
        score:                g.score || null,
        our_team_id:          ourTeamId,
        opponent: {
          team_id:  match.team.team_id,
          name:     match.team.name,
          raw_name: match.team.raw_name || oppName,
          logo:     match.team.logo || g.opponent_team?.avatar_url || null,
        },
      });
      byTournament.set(match.tournament.org_id, arr);
    }
  }
  for (const list of byTournament.values()) {
    list.sort((a, b) => (a.start_ts || '').localeCompare(b.start_ts || ''));
  }
  return byTournament;
}

// Harvest every GC game on each of our team's schedules. Returns
// { u15: games[], u17d1: games[], u17d2: games[] }, each list sorted by
// start_ts asc. Opponent logos resolve against the league standings map
// (mascotKey → permanent Spordle URL); GC's signed avatar_urls expire in
// ~7 min so they are only a last-resort fallback.
async function fetchOurSeasonGames(leagueLogoByKey) {
  const out = { u15: [], u17d1: [], u17d2: [] };
  const entries = Object.entries(OUR_TEAMS);

  const settled = await Promise.allSettled(
    entries.map(([_cat, t]) =>
      gcFetchJSON(`${GC_API}/teams/${t.gc_team_id}/games`, { retryOnEmpty: true }))
  );

  for (let i = 0; i < settled.length; i++) {
    const [category, team] = entries[i];
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const list = r.value;
    if (!Array.isArray(list)) continue;

    const games = [];
    for (const g of list) {
      const oppName = g.opponent_team?.name || '';
      const oppKey  = mascotKey(oppName);
      const oppLogo = (oppKey && leagueLogoByKey.get(oppKey)) || g.opponent_team?.avatar_url || null;
      games.push({
        id:                   g.id,
        start_ts:             g.start_ts || null,
        end_ts:               g.end_ts || null,
        timezone:             g.timezone || 'America/Toronto',
        home_away:            g.home_away || null,
        game_status:          g.game_status || 'scheduled',
        has_videos_available: !!g.has_videos_available,
        has_live_stream:      !!g.has_live_stream,
        score:                g.score || null,
        our_team_id:          team.gc_team_id,
        team_category:        category,
        opponent: {
          team_id:  g.opponent_team?.id || null,
          name:     cleanTeamName(oppName),
          raw_name: oppName || '',
          logo:     oppLogo,
        },
      });
    }
    games.sort((a, b) => (a.start_ts || '').localeCompare(b.start_ts || ''));
    out[category] = games;
  }
  return out;
}

// Map one of our season_games entries to its GC *event* id (distinct from the
// team-schedule game id) using the org-wide events listing. Match on team pair
// (our id + opponent id, when known) then nearest start_ts. Returns the event
// id or null. See reference_gc_live_endpoints.
function matchEventId(events, g) {
  const ourId = g.our_team_id;
  const oppId = (g.opponent && g.opponent.team_id) || null;
  const gTs   = g.start_ts ? new Date(g.start_ts).getTime() : NaN;
  let best = null, bestDelta = Infinity;
  for (const ev of events) {
    const hId = ev.home_team && ev.home_team.id;
    const aId = ev.away_team && ev.away_team.id;
    if (hId !== ourId && aId !== ourId) continue;          // must involve us
    if (oppId && hId !== oppId && aId !== oppId) continue;  // opponent must match if known
    const evTs  = ev.start_ts ? new Date(ev.start_ts).getTime() : NaN;
    const delta = (!isNaN(gTs) && !isNaN(evTs)) ? Math.abs(evTs - gTs) : 0;
    if (delta < bestDelta) { bestDelta = delta; best = ev; }
  }
  // Reject a wildly-off time match when both timestamps were present.
  if (best && bestDelta !== Infinity && bestDelta > 6 * 60 * 60 * 1000) return null;
  return (best && best.id) || null;
}

// Enrich the harvested season_games (in place) with live inning / half / outs
// for any game inside the activity window, via GC's richer event-detail tier
// (reference_gc_live_endpoints). Purely ADDITIVE: it only sets `g.event_id`
// (cached so the events listing is fetched at most once per org per game) and
// `g.live = { status, inning, half, outs, updated_at }`. It NEVER touches
// `g.score` or `g.game_status`, and it carries the prior `live`/`event_id`
// forward by stable game id so a failed detail fetch can't wipe a good block.
async function enrichLiveGames(seasonGames, prior) {
  // Carry resolved event_id + last-known live block forward by game id.
  const priorById = new Map();
  for (const cat of CATS) for (const g of (prior && prior[cat]) || []) {
    if (g && g.id) priorById.set(g.id, g);
  }
  for (const cat of CATS) for (const g of seasonGames[cat] || []) {
    const p = g.id ? priorById.get(g.id) : null;
    if (!p) continue;
    if (p.event_id && !g.event_id) g.event_id = p.event_id;
    if (p.live && g.live === undefined) g.live = p.live; // keep until refreshed
  }

  // Active games (in window, not completed) need a live refresh this tick.
  const now = Date.now();
  const lo  = now - ACTIVITY_LOOKBACK_MS;
  const hi  = now + ACTIVITY_LOOKAHEAD_MS;
  const active = [];
  for (const cat of CATS) for (const g of seasonGames[cat] || []) {
    if (g.game_status === 'completed') continue;
    const ts = g.start_ts ? new Date(g.start_ts).getTime() : NaN;
    if (isNaN(ts) || ts < lo || ts > hi) continue;
    active.push({ cat, g });
  }
  if (active.length === 0) return { active: 0, enriched: 0 };

  // Resolve any missing event ids (org events listing fetched once per org).
  const orgEventsCache = new Map();
  for (const { cat, g } of active) {
    if (g.event_id) continue;
    const orgId = ORG_FOR_CAT[cat];
    if (!orgId) continue;
    if (!orgEventsCache.has(orgId)) {
      const events = await gcFetchJSON(`${GC_API}/organizations/${orgId}/events`, { retryOnEmpty: true });
      orgEventsCache.set(orgId, Array.isArray(events) ? events : null);
    }
    const events = orgEventsCache.get(orgId);
    if (Array.isArray(events)) {
      const eid = matchEventId(events, g);
      if (eid) g.event_id = eid;
    }
  }

  // Pull live detail per active game that has an event id.
  let enriched = 0;
  await Promise.allSettled(active.map(async ({ cat, g }) => {
    if (!g.event_id) return;
    const orgId = ORG_FOR_CAT[cat];
    if (!orgId) return;
    const ev = await gcFetchJSON(`${GC_API}/organizations/${orgId}/events/${g.event_id}`);
    if (!ev || typeof ev !== 'object') return; // keep any carried-over live block
    const bats = (ev.sport_specific && ev.sport_specific.bats) || {};
    const det  = bats.inning_details || {};
    // GC's bats.total_outs is CUMULATIVE for the whole game (e.g. 30 after 5
    // complete innings), not the current half-inning. Current-half outs (what a
    // scorebug shows, 0–2) = total_outs % 3. Keep the raw total for debugging.
    const totalOuts = Number.isFinite(bats.total_outs) ? bats.total_outs : null;
    const live = {
      status:     ev.game_status != null ? ev.game_status : null,
      inning:     Number.isFinite(det.inning) ? det.inning : null,
      half:       (det.half === 'top' || det.half === 'bottom') ? det.half : null,
      outs:       totalOuts != null ? (((totalOuts % 3) + 3) % 3) : null,
      total_outs: totalOuts,
      updated_at: new Date().toISOString(),
    };
    // Don't overwrite a good carried block with an all-null one from a
    // partial / !ok detail fetch.
    if (live.inning == null && live.half == null && live.outs == null) return;
    g.live = live;
    enriched++;
  }));
  return { active: active.length, enriched };
}

// Build a `${category}|${ymd}|${oppKey}` guard set from the tournament harvest.
// season_games contains every GC game (regular season AND tournaments) because
// fetchOurSeasonGames hits /teams/{id}/games. The Spordle schedule is regular-
// season only, so without a guard a tournament game on the same date vs the
// same opponent as a league game would steal that Spordle game_id's KV entry.
function tournamentKeysFor(tournaments) {
  const keys = new Set();
  for (const t of (tournaments || [])) {
    for (const g of (t.our_games || [])) {
      const ymd = ymdInET(g.start_ts);
      if (!ymd) continue;
      const oppKey = mascotKey(g.opponent?.raw_name || g.opponent?.name || '');
      if (!oppKey) continue;
      // Resolve our_team_id → category
      let category = null;
      for (const [cat, m] of Object.entries(OUR_TEAMS)) {
        if (m.gc_team_id === g.our_team_id) { category = cat; break; }
      }
      if (!category) continue;
      keys.add(`${category}|${ymd}|${oppKey}`);
    }
  }
  return keys;
}

// Mirror finals from harvested season_games into the canonniers-results-worker
// KV (RESULTS, keyed by spordle_game_id). Manual entries (no `source` field
// or `source !== 'gc'`) are never overwritten — admin-results.html stays
// authoritative for anything Jay entered by hand.
//
// Doubleheaders: the Spordle index value is an array sorted by startTime; we
// consume slots in order via a per-(category,key) counter so GC game 1 maps
// to Spordle game 1 of the DH, etc. GC season_games is already start_ts asc.
//
// Tournament guard: GC games whose (category, ymd, oppKey) is in tournamentKeys
// are skipped — those aren't on the Spordle schedule and any apparent match
// would be a same-date+same-opponent coincidence with a league game.
async function backfillResultsKV(env, seasonGames, gameIdByTeam, tournamentKeys) {
  if (!env.RESULTS) return { written: 0, skipped: 0, no_match: 0, tournament_skipped: 0 };

  let existing = [];
  try {
    const raw = await env.RESULTS.get(RESULTS_KV_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed;
    }
  } catch (_) { /* empty */ }

  const byId = new Map(existing.map(r => [Number(r.spordle_game_id), r]));
  let written = 0;
  let skipped = 0;
  let no_match = 0;
  let tournament_skipped = 0;

  for (const [category, games] of Object.entries(seasonGames)) {
    const spordleId = OUR_TEAMS[category]?.spordle_team_id;
    const idx       = gameIdByTeam.get(spordleId);
    if (!idx) continue;
    // Per-category slot counter so DH game N consumes Spordle bucket slot N.
    const used = new Map(); // key → next index
    for (const g of games) {
      if (!GC_DONE_STATUSES.has(g.game_status)) continue;

      const ymd = ymdInET(g.start_ts);
      if (!ymd) continue;
      const oppKey = mascotKey(g.opponent.raw_name);
      if (!oppKey) continue;
      const key = `${ymd}|${oppKey}`;

      // Tournament guard — skip GC tournament games even if their date+opp
      // happens to overlap a league date.
      if (tournamentKeys && tournamentKeys.has(`${category}|${key}`)) {
        tournament_skipped++;
        continue;
      }

      const bucket = idx.get(key);
      if (!bucket || bucket.length === 0) { no_match++; continue; }
      const slot = used.get(key) || 0;
      const cand = bucket[slot];
      if (!cand) { no_match++; continue; }
      used.set(key, slot + 1);
      const spordleGameId = cand.gameId;

      // GC score = { team, opponent_team } (us vs them, from our side).
      // Map to home/away via the game's home_away flag.
      const us   = (g.score && typeof g.score.team === 'number')          ? g.score.team          : null;
      const them = (g.score && typeof g.score.opponent_team === 'number') ? g.score.opponent_team : null;
      let home_score = null;
      let away_score = null;
      if (us != null && them != null) {
        if      (g.home_away === 'home') { home_score = us;   away_score = them; }
        else if (g.home_away === 'away') { home_score = them; away_score = us;   }
      }
      if (home_score == null || away_score == null) continue;
      if (home_score < 0 || home_score > 99 || away_score < 0 || away_score > 99) continue;

      const canonicalStatus = (g.game_status === 'completed') ? 'final' : g.game_status;

      const prior = byId.get(Number(spordleGameId));
      if (prior && prior.source !== 'gc') { skipped++; continue; } // manual wins
      if (prior &&
          prior.home_score === home_score &&
          prior.away_score === away_score &&
          prior.status     === canonicalStatus) {
        continue; // unchanged — skip the rewrite to keep updated_at stable
      }

      byId.set(Number(spordleGameId), {
        spordle_game_id: Number(spordleGameId),
        team_category:   category,
        game_date:       ymd,
        game_number:     null,
        home_score,
        away_score,
        status:          canonicalStatus,
        notes:           null,
        source:          'gc',
        updated_at:      new Date().toISOString(),
      });
      written++;
    }
  }

  if (written > 0) {
    await env.RESULTS.put(RESULTS_KV_KEY, JSON.stringify([...byId.values()]));
  }
  return { written, skipped, no_match, tournament_skipped };
}

async function refreshStandings(env) {
  // Fetch each league's Spordle schedule in parallel with the GC fetches.
  // fetchSpordleSchedule returns { logos, gameIdByTeam }: logos is the same
  // mascotKey → URL map the old fetchSpordleLogos returned (preserved
  // per-league so cross-league mascot collisions don't bleed the wrong logo),
  // gameIdByTeam is the spordle_game_id index used by the results backfill.
  const [u15Spordle, u17Spordle] = await Promise.all([
    fetchSpordleSchedule(env, LEAGUES.u15.spordle_team_ids),
    fetchSpordleSchedule(env, LEAGUES.u17.spordle_team_ids),
  ]);
  const u15Logos = u15Spordle.logos;
  const u17Logos = u17Spordle.logos;
  const gameIdByTeam = new Map([
    ...u15Spordle.gameIdByTeam,
    ...u17Spordle.gameIdByTeam,
  ]);

  const [leagueResults, tournamentResults] = await Promise.all([
    Promise.allSettled([
      fetchLeague(LEAGUES.u15.org_id, u15Logos, LEAGUES.u15.excluded_team_ids),
      fetchLeague(LEAGUES.u17.org_id, u17Logos, LEAGUES.u17.excluded_team_ids),
    ]),
    Promise.allSettled(TOURNAMENTS.map(t => fetchTournament(t))),
  ]);

  // Preserve any league or tournament whose fetch failed this tick.
  let existing = {};
  try {
    const stored = await env.STANDINGS.get(KV_KEY, 'json');
    if (stored && typeof stored === 'object') existing = stored;
  } catch (_) { /* first run, no existing blob */ }

  const updated_at = new Date().toISOString();
  const next = {
    updated_at,
    u15:                     existing.u15 || null,
    u17:                     existing.u17 || null,
    tournaments:             existing.tournaments || [],
    season_games:            existing.season_games || { u15: [], u17d1: [], u17d2: [] },
    season_games_updated_at: existing.season_games_updated_at || null,
  };

  // No active tournaments configured → clear any stale KV data immediately
  // (distinct from "all configured fetches failed", which preserves prior data
  // so a transient GC blip doesn't wipe an in-progress tournament).
  if (TOURNAMENTS.length === 0) {
    next.tournaments = [];
  }

  if (leagueResults[0].status === 'fulfilled') {
    next.u15 = {
      league_name:   LEAGUES.u15.league_name,
      our_team_ids:  LEAGUES.u15.our_team_ids,
      teams:         leagueResults[0].value,
      updated_at,
    };
  }
  if (leagueResults[1].status === 'fulfilled') {
    next.u17 = {
      league_name:   LEAGUES.u17.league_name,
      our_team_ids:  LEAGUES.u17.our_team_ids,
      teams:         leagueResults[1].value,
      updated_at,
    };
  }

  // Replace tournaments only if at least one fetch succeeded — otherwise keep
  // the previous list so a transient GC blip doesn't wipe tournament data
  // mid-event.
  const okTournaments = tournamentResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);

  let totalOurGames = 0;

  // Cross-league logo map: mascotKey → permanent Spordle URL. Used to fill
  // missing tournament-team logos AND to attach opponent logos to season_games.
  const leagueLogoByKey = new Map();
  for (const lr of leagueResults) {
    if (lr.status !== 'fulfilled') continue;
    for (const team of lr.value) {
      if (!team.logo) continue;
      const key = mascotKey(team.name);
      if (key && !leagueLogoByKey.has(key)) leagueLogoByKey.set(key, team.logo);
    }
  }

  if (okTournaments.length > 0) {
    // Cross-fill tournament team logos from league standings (Spordle logos
    // are richer than GC's tournament-org avatars, and GC sometimes omits
    // avatars entirely for league teams that haven't uploaded one).
    for (const tournament of okTournaments) {
      for (const team of tournament.teams || []) {
        if (!team.logo) {
          const fallback = leagueLogoByKey.get(mascotKey(team.name));
          if (fallback) team.logo = fallback;
        }
      }
    }

    // Collect distinct our-team IDs across leagues this tournament set touches.
    const ourTeamIds = [...new Set(
      okTournaments.flatMap(t => Object.values(LEAGUES[t.league]?.our_team_ids || {}))
    )];
    const gamesByTournament = await fetchOurTournamentGames(ourTeamIds, okTournaments);
    next.tournaments = okTournaments.map(t => {
      const our_games = gamesByTournament.get(t.org_id) || [];
      totalOurGames += our_games.length;
      return { ...t, our_games, updated_at };
    });
  }

  // Season-games harvest + results-worker KV backfill. Errors here don't
  // abort the standings/tournaments write — they're independent of the rest.
  let seasonStats = { written: 0, skipped: 0, no_match: 0, tournament_skipped: 0 };
  try {
    const activeCats    = categoriesInActivityWindow(existing.season_games || {});
    const fetchedSeason = await fetchOurSeasonGames(leagueLogoByKey);
    const seasonGames   = preserveOnEmpty(fetchedSeason, existing.season_games, activeCats);
    // Live inning/half/outs enrichment — additive, never wipes a score.
    try { await enrichLiveGames(seasonGames, existing.season_games); } catch (_) { /* additive */ }
    next.season_games            = seasonGames;
    next.season_games_updated_at = updated_at;
    try {
      const tournamentKeys = tournamentKeysFor(next.tournaments);
      seasonStats = await backfillResultsKV(env, seasonGames, gameIdByTeam, tournamentKeys);
    } catch (e) {
      seasonStats = { written: 0, skipped: 0, no_match: 0, tournament_skipped: 0, error: String(e) };
    }
  } catch (e) {
    seasonStats.error = `season_games fetch: ${String(e)}`;
  }

  await env.STANDINGS.put(KV_KEY, JSON.stringify(next));

  return {
    u15_ok:  leagueResults[0].status === 'fulfilled',
    u17_ok:  leagueResults[1].status === 'fulfilled',
    u15_err: leagueResults[0].status === 'rejected' ? String(leagueResults[0].reason) : null,
    u17_err: leagueResults[1].status === 'rejected' ? String(leagueResults[1].reason) : null,
    u15_spordle_logos: Object.keys(u15Logos).length,
    u17_spordle_logos: Object.keys(u17Logos).length,
    tournaments_ok:    okTournaments.length,
    tournaments_total: TOURNAMENTS.length,
    tournaments_err:   tournamentResults
                         .map((r, i) => r.status === 'rejected'
                           ? { org_id: TOURNAMENTS[i].org_id, error: String(r.reason) }
                           : null)
                         .filter(Boolean),
    our_tournament_games: totalOurGames,
    season_games_total:   next.season_games.u15.length + next.season_games.u17d1.length + next.season_games.u17d2.length,
    results_backfill:     seasonStats,
    updated_at,
  };
}

// Lightweight refresh: only re-pulls season_games from GC. Skips when no
// cached game's start_ts is in [now - 6h, now + 30min]. Does NOT touch
// Spordle and does NOT backfill the results KV — the 4×/day full refresh
// handles those (diffusion's results lookup is fine with ≤6h lag).
async function refreshSeasonGamesLight(env) {
  let existing = {};
  try {
    const stored = await env.STANDINGS.get(KV_KEY, 'json');
    if (stored && typeof stored === 'object') existing = stored;
  } catch (_) { /* first run */ }

  const known = existing.season_games || { u15: [], u17d1: [], u17d2: [] };
  const knownCount = (known.u15?.length || 0) + (known.u17d1?.length || 0) + (known.u17d2?.length || 0);

  const activeCats  = categoriesInActivityWindow(known);
  const hasActivity = knownCount === 0 || activeCats.size > 0; // empty → populate on first run
  if (!hasActivity) {
    return { skipped: true, reason: 'idle (no game in [-6h, +30min] window)' };
  }

  // Reuse cached league logos — no Spordle re-fetch on the hot path.
  const leagueLogoByKey = new Map();
  for (const lk of ['u15', 'u17']) {
    for (const team of existing[lk]?.teams || []) {
      if (!team.logo) continue;
      const key = mascotKey(team.name);
      if (key && !leagueLogoByKey.has(key)) leagueLogoByKey.set(key, team.logo);
    }
  }

  let seasonGames;
  try {
    seasonGames = await fetchOurSeasonGames(leagueLogoByKey);
  } catch (e) {
    console.error(`[standings:light] season_games fetch threw: ${String(e)}`);
    return { skipped: false, error: `season_games fetch: ${String(e)}` };
  }
  // Don't let a transient GC failure wipe cached games — preserve per-team if
  // the fetch came back empty for a team that previously had games (logs a WARN
  // when that team has a live game, per project_standings_light_cron_bug).
  seasonGames = preserveOnEmpty(seasonGames, known, activeCats);

  // Live inning/half/outs enrichment — additive, never wipes a score.
  let enrichStats = { active: 0, enriched: 0 };
  try { enrichStats = await enrichLiveGames(seasonGames, known); } catch (_) { /* additive */ }

  const updated_at = new Date().toISOString();
  const next = {
    ...existing,
    season_games:            seasonGames,
    season_games_updated_at: updated_at,
    updated_at,
  };
  await env.STANDINGS.put(KV_KEY, JSON.stringify(next));

  // Tail visibility: per-team counts + how many live games we enriched. Watch
  // this in `wrangler tail` during a game — non-zero counts + a fresh score in
  // KV mean the hot path is healthy (project_standings_light_cron_bug).
  const summary = {
    skipped: false,
    active_categories:  [...activeCats],
    per_team:           { u15: seasonGames.u15.length, u17d1: seasonGames.u17d1.length, u17d2: seasonGames.u17d2.length },
    season_games_total: seasonGames.u15.length + seasonGames.u17d1.length + seasonGames.u17d2.length,
    live_active:        enrichStats.active,
    live_enriched:      enrichStats.enriched,
    updated_at,
  };
  console.log('[standings:light]', JSON.stringify(summary));
  return summary;
}

// Scan all known league + tournament teams by mascotKey, return the first
// match with a logo. Used by frontend pages to resolve out-of-league opponent
// names (e.g. tournament visitors) without baking a static map.
function findTeamLogoByName(data, rawName) {
  const key = mascotKey(cleanTeamName(rawName));
  if (!key) return null;
  const buckets = [
    ...(data.u15?.teams || []),
    ...(data.u17?.teams || []),
    ...(data.tournaments || []).flatMap(t => t.teams || []),
  ];
  for (const t of buckets) {
    if (mascotKey(t.name) === key && t.logo) {
      return { name: t.name, raw_name: t.raw_name || null, logo: t.logo };
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/api/standings/refresh' && request.method === 'POST') {
      const summary = await refreshStandings(env);
      return json(summary, 200, corsHeaders(origin));
    }

    if (url.pathname === '/api/team-logo' && request.method === 'GET') {
      const name = url.searchParams.get('name');
      if (!name) {
        return json({ error: 'name required' }, 400, corsHeaders(origin));
      }
      const data = await env.STANDINGS.get(KV_KEY, 'json');
      if (!data) {
        return json({ error: 'Standings not yet populated' }, 503, corsHeaders(origin));
      }
      const hit = findTeamLogoByName(data, name);
      if (!hit) {
        return json({ error: 'not found', name }, 404, corsHeaders(origin));
      }
      return json(hit, 200, {
        ...corsHeaders(origin),
        'Cache-Control': `public, max-age=${EDGE_CACHE_TTL}`,
      });
    }

    if (url.pathname !== '/api/standings' || request.method !== 'GET') {
      return json({ error: 'Not found' }, 404, corsHeaders(origin));
    }

    const data = await env.STANDINGS.get(KV_KEY, 'json');
    if (!data) {
      return json({ error: 'Standings not yet populated' }, 503, corsHeaders(origin));
    }

    return json(data, 200, {
      ...corsHeaders(origin),
      'Cache-Control': `public, max-age=${EDGE_CACHE_TTL}`,
    });
  },

  async scheduled(event, env, ctx) {
    // 2-min cron handles season_games only with idle-skip; all other crons
    // do the full refresh (leagues + tournaments + season_games + backfill).
    if (event.cron && event.cron.startsWith('*/2 ')) {
      ctx.waitUntil(refreshSeasonGamesLight(env));
      return;
    }
    ctx.waitUntil(refreshStandings(env));
  },
};
