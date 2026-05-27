// Maps URL slug → Cloudflare Stream Live Input UID + Spordle team ID
const TEAMS = {
  u15:   { liveInput: '8ffb2b7f7847ab2fb22681c26abe60c8', spordle: 156779 },
  u17d1: { liveInput: 'a3af25e5ea09782876fced8d7d66bf31', spordle: 156780 },
  u17d2: { liveInput: '0ec71443dbcec9b7d58b708968c016da', spordle: 156781 },
};

const ACCOUNT_ID      = 'db90db1d80338194e2994306da649f90';
const CF_STREAM_HOST  = 'customer-f9h5cn4tbbphkrh6.cloudflarestream.com';
const CACHE_TTL       = 300;  // 5 min
const MAX_REPLAYS     = 7;
const MAX_AGE_DAYS    = 60;

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

// ── URL builders (provider-specific) ─────────────────────────────────────
const cfHlsUrl     = (uid)         => `https://${CF_STREAM_HOST}/${uid}/manifest/video.m3u8`;
const cfDashUrl    = (uid)         => `https://${CF_STREAM_HOST}/${uid}/manifest/video.mpd`;
const bunnyHlsUrl  = (guid, host)  => `https://${host}/${guid}/playlist.m3u8`;
const bunnyDashUrl = (guid, host)  => `https://${host}/${guid}/playlist.mpd`;

// ── CF Stream source ─────────────────────────────────────────────────────
// Fail-soft: returns [] on any error so bunny results still surface.
async function fetchCfRecordings(liveInputUid, token) {
  if (!token) return [];
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/stream/live_inputs/${liveInputUid}/videos`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Stream API ${r.status}`);
    const data = await r.json();
    if (!data.success) throw new Error('Stream API !success');

    const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;
    return (data.result || [])
      .filter(v => v.status?.state === 'ready')
      .filter(v => v.duration > 60)
      .filter(v => new Date(v.created).getTime() > cutoff)
      .map(v => ({
        provider:  'cfstream',
        uid:       v.uid,            // CF Stream video UID
        streamUid: v.uid,            // = uid, for dedupe with bunny
        created:   v.created,
        duration:  v.duration,
        hlsUrl:    cfHlsUrl(v.uid),
        dashUrl:   cfDashUrl(v.uid),
      }));
  } catch (err) {
    console.error('CF Stream fetch error:', err.message);
    return [];
  }
}

// ── Bunny source ─────────────────────────────────────────────────────────
// Fail-soft: returns [] on any error so CF Stream results still surface.
// Filters server-side by title prefix (team-) since our migration script
// names videos `{team}-{date}-{uid8}`.
async function fetchBunnyRecordings(teamKey, env) {
  if (!env.BUNNY_API_KEY || !env.BUNNY_LIBRARY_ID || !env.BUNNY_CDN_HOST) return [];
  try {
    const url = `https://video.bunnycdn.com/library/${env.BUNNY_LIBRARY_ID}/videos?search=${teamKey}-&itemsPerPage=100`;
    const r = await fetch(url, {
      headers: { AccessKey: env.BUNNY_API_KEY, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`Bunny ${r.status}`);
    const data = await r.json();

    const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;
    return (data.items || [])
      .filter(v => v.status === 4)              // 4 = Finished (transcoded, playable)
      .filter(v => v.title?.startsWith(`${teamKey}-`)) // belt + suspenders to the search filter
      .map(v => {
        const tags = Object.fromEntries((v.metaTags || []).map(t => [t.property, t.value]));
        const originalCreated = tags.original_created || v.dateUploaded;
        return {
          provider:  'bunny',
          uid:       v.guid,                    // bunny GUID
          streamUid: tags.stream_uid || null,   // original CF Stream UID, for dedupe
          created:   originalCreated,
          duration:  v.length,
          hlsUrl:    bunnyHlsUrl(v.guid, env.BUNNY_CDN_HOST),
          dashUrl:   bunnyDashUrl(v.guid, env.BUNNY_CDN_HOST),
        };
      })
      .filter(v => new Date(v.created).getTime() > cutoff);
  } catch (err) {
    console.error('Bunny fetch error:', err.message);
    return [];
  }
}

// ── Spordle + results-worker (unchanged) ─────────────────────────────────
async function fetchSpordleGames(teamId, env) {
  const url = `https://spordle-proxy/?teamId=${teamId}`;
  try {
    const r = await env.SPORDLE.fetch(url);
    if (!r.ok) { console.error(`Spordle proxy ${r.status}`); return []; }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Spordle fetch error:', err.message);
    return [];
  }
}

async function fetchResults(env) {
  if (!env.RESULTS) return [];
  try {
    const r = await env.RESULTS.fetch('https://canonniers-results-worker/api/results');
    if (!r.ok) { console.error(`Results worker ${r.status}`); return []; }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Results fetch error:', err.message);
    return [];
  }
}

// ── matchGame, fmtDuration ───────────────────────────────────────────────
function matchGame(recordingCreated, games, teamId) {
  const recStart = new Date(recordingCreated).getTime();
  let best = null;
  let bestDelta = Infinity;
  for (const g of games) {
    const gameStart = new Date(g.startTime || g.date).getTime();
    const delta = gameStart - recStart;
    if (delta < -6 * 3600 * 1000 || delta > 30 * 60 * 1000) continue;
    if (Math.abs(delta) < bestDelta) { bestDelta = Math.abs(delta); best = g; }
  }
  if (!best) return null;
  const isHome  = best.homeTeamId === teamId;
  const oppTeam = isHome ? best.awayTeam : best.homeTeam;
  return {
    gameId:       best.id,
    opponent:     oppTeam?.name || oppTeam?.shortName || 'Adversaire',
    opponentLogo: oppTeam?.logoUrl || oppTeam?.logo || null,
    isHome,
  };
}

function fmtDuration(secs) {
  if (!secs || secs < 1) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Merge + match ────────────────────────────────────────────────────────
async function handleReplays(teamKey, env) {
  const team = TEAMS[teamKey];
  if (!team) return { error: 'unknown team' };

  const [cfRecs, bunnyRecs, games, results] = await Promise.all([
    fetchCfRecordings(team.liveInput, env.CF_STREAM_TOKEN),
    fetchBunnyRecordings(teamKey, env),
    fetchSpordleGames(team.spordle, env),
    fetchResults(env),
  ]);

  // Dedupe: bunny wins when its stream_uid matches a CF Stream video's uid.
  // (During the migration verification window both copies exist; we want viewers
  // hitting bunny so we can safely delete the CF copy afterward.)
  const bunnyStreamUids = new Set(bunnyRecs.map(r => r.streamUid).filter(Boolean));
  const cfDeduped = cfRecs.filter(r => !bunnyStreamUids.has(r.streamUid));

  const merged = [...cfDeduped, ...bunnyRecs]
    .sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime())
    .slice(0, MAX_REPLAYS);

  console.log(`${teamKey}: cf=${cfRecs.length} bunny=${bunnyRecs.length} deduped=${cfDeduped.length} merged=${merged.length} games=${games.length} results=${results.length}`);

  return merged.map((v) => {
    const match = matchGame(v.created, games, team.spordle);

    let score = null;
    if (match?.gameId) {
      const row = results.find(r =>
        r.spordle_game_id === match.gameId && r.team_category === teamKey
      );
      if (row && (row.status === 'final' || row.status === 'forfeit')) {
        const canonniers = match.isHome ? row.home_score : row.away_score;
        const opponent   = match.isHome ? row.away_score : row.home_score;
        score = {
          canonniers, opponent,
          won:  canonniers > opponent,
          tied: canonniers === opponent,
          status: row.status,
        };
      }
    }

    return {
      id:           `${v.provider}-${v.uid.slice(0, 8)}`,
      provider:     v.provider,
      hlsUrl:       v.hlsUrl,
      dashUrl:      v.dashUrl,
      date:         v.created.slice(0, 10),
      opponent:     match?.opponent || null,
      opponentLogo: match?.opponentLogo || null,
      isHome:       match?.isHome ?? true,
      gameId:       match?.gameId || null,
      duration:     fmtDuration(v.duration),
      score,
    };
  });
}

// ── Entry ────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
    }

    const m = url.pathname.match(/^\/api\/replays\/(u15|u17d1|u17d2)$/);
    if (!m) {
      return json({ error: 'not found' }, 404, corsHeaders(request.headers.get('Origin')));
    }
    const teamKey = m[1];

    // KV cache (account-global, replaces per-colo caches.default)
    const cacheKey = `replays:${teamKey}`;
    if (env.REPLAYS_CACHE) {
      const cached = await env.REPLAYS_CACHE.get(cacheKey);
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: {
            'Content-Type':  'application/json',
            'Cache-Control': `public, max-age=${CACHE_TTL}`,
            'X-Cache':       'HIT',
            ...corsHeaders(request.headers.get('Origin')),
          },
        });
      }
    }

    try {
      const replays = await handleReplays(teamKey, env);
      const body = JSON.stringify(replays);
      if (env.REPLAYS_CACHE) {
        ctx.waitUntil(env.REPLAYS_CACHE.put(cacheKey, body, { expirationTtl: CACHE_TTL }));
      }
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          'X-Cache':       'MISS',
          ...corsHeaders(request.headers.get('Origin')),
        },
      });
    } catch (err) {
      console.error('replays-worker error:', err.message);
      return json([], 200, corsHeaders(request.headers.get('Origin')));
    }
  },
};
