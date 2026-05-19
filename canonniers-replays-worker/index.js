// Maps URL slug → Cloudflare Stream Live Input UID + Spordle team ID
const TEAMS = {
  u15:   { liveInput: '8ffb2b7f7847ab2fb22681c26abe60c8', spordle: 156779 },
  u17d1: { liveInput: 'a3af25e5ea09782876fced8d7d66bf31', spordle: 156780 },
  u17d2: { liveInput: '0ec71443dbcec9b7d58b708968c016da', spordle: 156781 },
};

const ACCOUNT_ID    = 'db90db1d80338194e2994306da649f90';
const CACHE_TTL     = 600; // 10 min
const MAX_REPLAYS   = 7;
const MAX_AGE_DAYS  = 60; // hide recordings older than 60d

// CORS — only canonniersdequebec.ca + workers.dev for local testing
function corsHeaders(origin) {
  const allowed = [
    'https://canonniersdequebec.ca',
    'https://www.canonniersdequebec.ca',
    'https://canonniers-website.pages.dev',
  ];
  const allow = allowed.includes(origin) ? origin : 'https://canonniersdequebec.ca';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}

function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// Fetch CF Stream recordings for a given live input, filter to ready+recent
async function fetchRecordings(liveInputUid, token) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/live_inputs/${liveInputUid}/videos`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Stream API ${r.status}`);
  const data = await r.json();
  if (!data.success) throw new Error('Stream API !success');

  const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;
  return (data.result || [])
    .filter(v => v.status?.state === 'ready')
    .filter(v => v.duration > 60) // skip <1min test recordings
    .filter(v => new Date(v.created).getTime() > cutoff)
    .sort((a, b) => new Date(b.created) - new Date(a.created))
    .slice(0, MAX_REPLAYS);
}

// Fetch Spordle games for a team via the SPORDLE service binding.
// Direct fetch() to spordle-proxy.workers.dev is blocked same-account, so we
// call it through the service binding instead.
async function fetchSpordleGames(teamId, env) {
  const url = `https://spordle-proxy/?teamId=${teamId}`;
  try {
    const r = await env.SPORDLE.fetch(url);
    if (!r.ok) {
      console.error(`Spordle proxy ${r.status}`);
      return [];
    }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Spordle fetch error:', err.message);
    return [];
  }
}

// Match a recording (by `created` timestamp) to a Spordle game.
// Window: game starts up to 30 min AFTER recording started, up to 6h BEFORE.
// (Mevo pre-rolls 15min; some recordings start mid-game.)
function matchGame(recordingCreated, games, teamId) {
  const recStart = new Date(recordingCreated).getTime();
  let best = null;
  let bestDelta = Infinity;
  for (const g of games) {
    const gameStart = new Date(g.startTime || g.date).getTime();
    const delta = gameStart - recStart; // +ve if game starts after recording
    if (delta < -6 * 3600 * 1000 || delta > 30 * 60 * 1000) continue;
    if (Math.abs(delta) < bestDelta) {
      bestDelta = Math.abs(delta);
      best = g;
    }
  }
  if (!best) return null;
  const isHome   = best.homeTeamId === teamId;
  const opponent = isHome
    ? (best.awayTeam?.name || best.awayTeam?.shortName || 'Adversaire')
    : (best.homeTeam?.name || best.homeTeam?.shortName || 'Adversaire');
  return { opponent, isHome };
}

// Format duration: 7320s → "2:02:00"
function fmtDuration(secs) {
  if (!secs || secs < 1) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function handleReplays(teamKey, env) {
  const team = TEAMS[teamKey];
  if (!team) return json({ error: 'unknown team' }, 404);
  if (!env.CF_STREAM_TOKEN) return json({ error: 'missing CF_STREAM_TOKEN' }, 500);

  const [recordings, games] = await Promise.all([
    fetchRecordings(team.liveInput, env.CF_STREAM_TOKEN),
    fetchSpordleGames(team.spordle, env),
  ]);
  console.log(`${teamKey}: ${recordings.length} recordings, ${games.length} spordle games`);

  const replays = recordings.map((v, i) => {
    const match = matchGame(v.created, games, team.spordle);
    return {
      id:       `cf-${v.uid.slice(0, 8)}`,
      videoUid: v.uid,
      date:     v.created.slice(0, 10), // YYYY-MM-DD
      opponent: match?.opponent || null,
      isHome:   match?.isHome ?? true,
      duration: fmtDuration(v.duration),
    };
  });

  return replays;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
    }

    // Route: /api/replays/{teamKey}
    const m = url.pathname.match(/^\/api\/replays\/(u15|u17d1|u17d2)$/);
    if (!m) {
      return json({ error: 'not found' }, 404, corsHeaders(request.headers.get('Origin')));
    }
    const teamKey = m[1];

    // Cache check
    const cacheKey = new Request(url.toString(), request);
    const cache = caches.default;
    let cached = await cache.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      Object.entries(corsHeaders(request.headers.get('Origin'))).forEach(([k, v]) => headers.set(k, v));
      return new Response(cached.body, { status: cached.status, headers });
    }

    try {
      const replays = await handleReplays(teamKey, env);
      const response = new Response(JSON.stringify(replays), {
        status: 200,
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          ...corsHeaders(request.headers.get('Origin')),
        },
      });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (err) {
      // Fail closed: return empty list so the section just hides.
      console.error('replays-worker error:', err.message);
      return json([], 200, corsHeaders(request.headers.get('Origin')));
    }
  },
};
