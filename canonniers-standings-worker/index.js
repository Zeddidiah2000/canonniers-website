// canonniers-standings-worker
//
// Caches league standings + team rosters for the 15U and 17U AAA leagues from
// GameChanger's public team-manager API. Also caches any active GC tournament
// org listed in TOURNAMENTS (participating teams + their logos + standings)
// AND our team's matchups inside each tournament (our_games[], date-sorted,
// with opponent logo pre-resolved) — used to render tournament banners on the
// schedule/homepage. Cron triggers refresh KV 3x/day; the fetch handler serves
// the cached blob to canonniersdequebec.ca/classement.html.
//
// Logos: harvested from Spordle (via SPORDLE_PROXY service binding) using each
// game's homeTeam/awayTeam objects. Spordle's CloudFront URLs are permanent and
// cover every team we play in-league; GC's signed avatar URLs are used as
// fallback for league teams, and as the primary source for tournament-only
// opponents (Ontario programs etc. that never appear in our Spordle schedule).
//
// Endpoints:
//   GET  /api/standings         — public, returns whole KV blob
//                                 (leagues + tournaments[])
//   GET  /api/team-logo?name=X  — public, returns { name, logo } if X
//                                 matches any known league or tournament team
//                                 by mascotKey. 404 otherwise.
//   POST /api/standings/refresh — public manual refresh (no auth; only re-pulls
//                                 public upstream data, negligible cost)
//
// Cron: 11:00 / 17:00 / 22:00 / 02:30 UTC (= 07:00 / 13:00 / 18:00 / 22:30 ET).

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

// Active GC tournament orgs we want to surface (logos + standings + bracket).
// Each entry tells the worker which of our LEAGUES the tournament belongs to,
// so the /api/team-logo lookup and any frontend widget can scope correctly.
// Add a new entry + redeploy when a new tournament starts.
const TOURNAMENTS = [
  {
    org_id: 'lA9kwmnwlCLm',
    league: 'u15', // Tournoi - Détection de talents ABC (May 28–31, 2026)
  },
];

// GC's /teams/{id} returns avatar_url signed for ~7 minutes — too short to
// hot-link. Mirror those logos into the repo at /assets/team-logos/ and map
// them here by GC team_id; the override wins over GC's signed URL in
// fetchTournament. Spordle logos (used by league teams) are permanent and
// don't need this treatment.
const LOGO_OVERRIDES = {
  'ldA1NRAEP6tD': 'https://canonniersdequebec.ca/assets/team-logos/toronto-mets-15u.png',
  '7SDlwvf91CrC': 'https://canonniersdequebec.ca/assets/team-logos/tigers-hpp-asis-15u.png',
  'rfzM1nMQarnu': 'https://canonniersdequebec.ca/assets/team-logos/onc-elite-15u.png',
  'jxD96t3ZTcgT': 'https://canonniersdequebec.ca/assets/team-logos/great-lake-canadians-15u.png',
};

const KV_KEY = 'all';
const EDGE_CACHE_TTL = 300;

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

// Query Spordle (via service binding) for each of our team's schedules and
// harvest a { mascotKey → logoUrl } map from every opponent's homeTeam/awayTeam.
async function fetchSpordleLogos(env, spordleTeamIds) {
  const map = {};
  if (!env.SPORDLE_PROXY) return map;
  const results = await Promise.allSettled(
    spordleTeamIds.map(tid =>
      env.SPORDLE_PROXY.fetch(`https://internal/?officeId=${SPORDLE_OFFICE_ID}&teamId=${tid}`)
    )
  );
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    const games = await r.value.json().catch(() => []);
    for (const g of (Array.isArray(games) ? games : [])) {
      for (const side of ['homeTeam', 'awayTeam']) {
        const t = g[side];
        if (!t || !t.name) continue;
        const k = mascotKey(t.name);
        if (k && !map[k]) map[k] = t.logo || t.logoUrl || null;
      }
    }
  }
  return map;
}

async function fetchLeague(orgId, spordleLogos, excludedTeamIds = []) {
  const [standingsRes, teamsRes] = await Promise.all([
    fetch(`${GC_API}/organizations/${orgId}/standings`),
    fetch(`${GC_API}/organizations/${orgId}/teams`),
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
    fetch(`${GC_API}/organizations/${org_id}`),
    fetch(`${GC_API}/organizations/${org_id}/teams`),
    fetch(`${GC_API}/organizations/${org_id}/standings`),
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
    ourTeamIds.map(tid => fetch(`${GC_API}/teams/${tid}/games`))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'fulfilled' || !r.value.ok) continue;
    const ourTeamId = ourTeamIds[i];
    const list = await r.value.json().catch(() => []);
    for (const g of (Array.isArray(list) ? list : [])) {
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

async function refreshStandings(env) {
  // Fetch each league's Spordle logo map in parallel with the GC fetches.
  const [u15Logos, u17Logos] = await Promise.all([
    fetchSpordleLogos(env, LEAGUES.u15.spordle_team_ids),
    fetchSpordleLogos(env, LEAGUES.u17.spordle_team_ids),
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
    u15:          existing.u15 || null,
    u17:          existing.u17 || null,
    tournaments:  existing.tournaments || [],
  };

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
  if (okTournaments.length > 0) {
    // Cross-fill tournament team logos from league standings (Spordle logos
    // are richer than GC's tournament-org avatars, and GC sometimes omits
    // avatars entirely for league teams that haven't uploaded one).
    const leagueLogoByKey = new Map();
    for (const lr of leagueResults) {
      if (lr.status !== 'fulfilled') continue;
      for (const team of lr.value) {
        if (!team.logo) continue;
        const key = mascotKey(team.name);
        if (key && !leagueLogoByKey.has(key)) leagueLogoByKey.set(key, team.logo);
      }
    }
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
    updated_at,
  };
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
    ctx.waitUntil(refreshStandings(env));
  },
};
