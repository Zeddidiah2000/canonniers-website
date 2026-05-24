// canonniers-standings-worker
//
// Caches league standings + team rosters for the 15U and 17U AAA leagues from
// GameChanger's public team-manager API. Cron triggers refresh KV 3x/day; the
// fetch handler serves the cached blob to canonniersdequebec.ca/classement.html.
//
// Endpoints:
//   GET  /api/standings         — public, returns whole KV blob
//   POST /api/standings/refresh — public manual refresh (no auth; only re-pulls
//                                 public upstream data, negligible cost)
//
// Cron: 11:00 / 17:00 / 02:30 UTC (= 07:00 / 13:00 / 22:30 Eastern in EDT).

const GC_API = 'https://api.team-manager.gc.com/public';

const LEAGUES = {
  u15: {
    org_id: 'xnQjeQyO7cFq',
    league_name: '2026 -Saison 15U AAA',
    our_team_ids: { u15: 'aMDDLssAvjFT' },
  },
  u17: {
    org_id: 'x2GrNpCrYJa0',
    league_name: '2026 -Saison 17U AAA',
    our_team_ids: { u17d1: 'ri4fPQu1DiQS', u17d2: '0DLnmx5bPCGz' },
  },
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

async function fetchLeague(orgId) {
  const [standingsRes, teamsRes] = await Promise.all([
    fetch(`${GC_API}/organizations/${orgId}/standings`),
    fetch(`${GC_API}/organizations/${orgId}/teams`),
  ]);
  if (!standingsRes.ok) throw new Error(`standings ${standingsRes.status}`);
  if (!teamsRes.ok)     throw new Error(`teams ${teamsRes.status}`);

  const standings = await standingsRes.json();
  const teamsList = await teamsRes.json();

  const teamMap = Object.fromEntries(
    teamsList.map(t => [t.id, {
      name:     cleanTeamName(t.name),
      raw_name: t.name || '',
      logo:     t.avatar_image || null,
    }])
  );

  return standings
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

async function refreshStandings(env) {
  const results = await Promise.allSettled([
    fetchLeague(LEAGUES.u15.org_id),
    fetchLeague(LEAGUES.u17.org_id),
  ]);

  // Preserve any league whose fetch failed this tick.
  let existing = {};
  try {
    const stored = await env.STANDINGS.get(KV_KEY, 'json');
    if (stored && typeof stored === 'object') existing = stored;
  } catch (_) { /* first run, no existing blob */ }

  const updated_at = new Date().toISOString();
  const next = {
    updated_at,
    u15: existing.u15 || null,
    u17: existing.u17 || null,
  };

  if (results[0].status === 'fulfilled') {
    next.u15 = {
      league_name:   LEAGUES.u15.league_name,
      our_team_ids:  LEAGUES.u15.our_team_ids,
      teams:         results[0].value,
      updated_at,
    };
  }
  if (results[1].status === 'fulfilled') {
    next.u17 = {
      league_name:   LEAGUES.u17.league_name,
      our_team_ids:  LEAGUES.u17.our_team_ids,
      teams:         results[1].value,
      updated_at,
    };
  }

  await env.STANDINGS.put(KV_KEY, JSON.stringify(next));

  return {
    u15_ok:  results[0].status === 'fulfilled',
    u17_ok:  results[1].status === 'fulfilled',
    u15_err: results[0].status === 'rejected' ? String(results[0].reason) : null,
    u17_err: results[1].status === 'rejected' ? String(results[1].reason) : null,
    updated_at,
  };
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
