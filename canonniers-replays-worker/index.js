// Maps URL slug → Cloudflare Stream Live Input UIDs + Spordle team ID.
//   liveInput   = raw/clean feed (input A) — the season archive.
//   burnedInput = relay-burned feed (input B) with the scorebug/cards baked in.
// When a game has a burned recording we surface THAT instead of the clean one
// (see handleReplays); clean recordings remain the fallback for older games.
const TEAMS = {
  u15:   { liveInput: '8ffb2b7f7847ab2fb22681c26abe60c8', burnedInput: '54ec3eeade9ba58afc4f23446ec30f10', spordle: 156779 },
  u17d1: { liveInput: 'a3af25e5ea09782876fced8d7d66bf31', burnedInput: '5b3ff34bc02b0ce112a93fea52cae813', spordle: 156780 },
  u17d2: { liveInput: '0ec71443dbcec9b7d58b708968c016da', burnedInput: '8a7a1dc776d09061566157c9448a4737', spordle: 156781 },
};

const ACCOUNT_ID    = 'db90db1d80338194e2994306da649f90';

// Hand-made recordings that live outside any live input (e.g. an offline
// re-burn of a game whose live burn fragmented). Each entry is shaped like a
// CF recording and flagged burned, so the normal de-dup evicts its clean twin.
// `created` = the original live recording's start, `duration` in seconds.
const MANUAL_REPLAYS = [
  // 2026-09-05 15U AAA FINAL vs Patriotes (won 14-10): live burn fragmented
  // (two burns overlapped on the VPS), so the clean recording was re-burned
  // offline from the poller's state log. See Updates/finale-15u/reburn/.
  { teamKey: 'u15', uid: 'REPLACE_WITH_UPLOADED_UID', created: '2026-09-05T16:58:19.432Z', duration: 11465,
    overrides: { opponent: 'Patriotes Rive-Sud', isHome: false,
      score: { canonniers: 14, opponent: 10, won: true, tied: false, status: 'final' } } },
];
const CACHE_TTL     = 600; // 10 min
const MAX_REPLAYS   = 7;
const MAX_AGE_DAYS  = 60; // hide recordings older than 60d

// The relay burner supervises ffmpeg and restarts it on exit — and every restart
// opens a NEW RTMP session to CF Stream, i.e. a NEW recording. A flaky input
// therefore shatters one game into dozens of unwatchable slivers (2026-08-07
// produced 80 recordings for a single u17d2 game). These three knobs keep that
// shrapnel off the page.
const MIN_DURATION_S   = 300;            // ignore anything under 5 min outright
const SESSION_GAP_MS   = 15 * 60 * 1000; // restarts this close = same game
const TWIN_OVERLAP     = 0.5;            // share this much of the shorter = same game
const LENGTH_TOLERANCE = 0.15;           // within 15% = "comparable length"

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
    .filter(v => v.duration > MIN_DURATION_S) // skip restart slivers + test blips
    .filter(v => new Date(v.created).getTime() > cutoff)
    .sort((a, b) => new Date(b.created) - new Date(a.created));
    // NOTE: no per-input slice — handleReplays merges clean+burned then slices.
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

// Fetch all final scores via the RESULTS service binding. Public GET endpoint
// returns an array of { spordle_game_id, team_category, home_score, away_score,
// status, ... }. We call it once per request and join client-side rather than
// per-replay round-trips.
async function fetchResults(env) {
  if (!env.RESULTS) return [];
  try {
    const r = await env.RESULTS.fetch('https://canonniers-results-worker/api/results');
    if (!r.ok) {
      console.error(`Results worker ${r.status}`);
      return [];
    }
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('Results fetch error:', err.message);
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
  const isHome  = best.homeTeamId === teamId;
  const oppTeam = isHome ? best.awayTeam : best.homeTeam;
  return {
    gameId:       best.id, // Spordle game.id — joins to results-worker spordle_game_id
    opponent:     oppTeam?.name || oppTeam?.shortName || 'Adversaire',
    opponentLogo: oppTeam?.logoUrl || oppTeam?.logo || null,
    isHome,
  };
}

// Format duration: 7320s → "2:02:00"
function fmtDuration(secs) {
  if (!secs || secs < 1) return null;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Build one replay object from a CF recording (join opponent + final score).
// _created / _burned are internal (used for sort + dedup) and stripped before return.
function buildReplay(v, games, results, team, teamKey, burned) {
  const match = matchGame(v.created, games, team.spordle);

  // Join to the canonniers-results-worker row by Spordle game ID and team
  // category. Only `final` and `forfeit` statuses surface a score.
  let score = null;
  if (match?.gameId) {
    const row = results.find(r =>
      r.spordle_game_id === match.gameId && r.team_category === teamKey
    );
    if (row && (row.status === 'final' || row.status === 'forfeit')) {
      const canonniers = match.isHome ? row.home_score : row.away_score;
      const opponent   = match.isHome ? row.away_score : row.home_score;
      score = {
        canonniers,
        opponent,
        won:    canonniers > opponent,
        tied:   canonniers === opponent,
        status: row.status,
      };
    }
  }

  return {
    id:           `cf-${v.uid.slice(0, 8)}`,
    videoUid:     v.uid,
    date:         v.created.slice(0, 10), // YYYY-MM-DD
    opponent:     match?.opponent || null,
    opponentLogo: match?.opponentLogo || null,
    isHome:       match?.isHome ?? true,
    gameId:       match?.gameId || null,
    duration:     fmtDuration(v.duration),
    score,
    _created:     v.created,
    _burned:      burned,
    _start:       new Date(v.created).getTime(),
    _end:         new Date(v.created).getTime() + (v.duration || 0) * 1000,
  };
}

// ── De-dup helpers ────────────────────────────────────────────────────────
// All three operate on wall-clock spans rather than the Spordle gameId, because
// gameId is null for anything the schedule doesn't cover (see handleReplays).

const durOf     = rp => rp._end - rp._start;
const overlapMs = (a, b) => Math.min(a._end, b._end) - Math.max(a._start, b._start);

// True when some other recording covers the same minutes and is substantially
// longer — i.e. `rp` is a restart sliver of that game, not a game of its own.
function isSubsumed(rp, all) {
  const d = durOf(rp);
  return all.some(o => o !== rp && overlapMs(rp, o) > 0 &&
    durOf(o) >= Math.max(d * 1.5, d + 10 * 60 * 1000));
}

// True when two recordings are the same game at comparable length — the clean
// feed and its burned counterpart running simultaneously on paired inputs.
function isTwin(a, b) {
  const ov = overlapMs(a, b);
  const shorter = Math.min(durOf(a), durOf(b));
  return ov > 0 && shorter > 0 && ov >= shorter * TWIN_OVERLAP;
}

// Burned carries the scorebug, so it wins when it is a genuine equivalent — but
// never at the cost of a materially longer recording. A shredded burned feed
// must not displace an intact clean one.
function better(a, b) {
  const da = durOf(a), db = durOf(b);
  if (Math.abs(da - db) <= Math.max(da, db) * LENGTH_TOLERANCE) {
    return a._burned && !b._burned;
  }
  return da > db;
}

// A game that survives an input drop comes back as several recordings minutes
// apart. Collapse each run into its single best entry so one game occupies one
// replay slot instead of eating the whole list.
function collapseSessions(replays) {
  const sorted = [...replays].sort((a, b) => a._start - b._start);
  const out = [];
  let cur = null;
  for (const rp of sorted) {
    if (cur && rp._start - cur.end <= SESSION_GAP_MS) {
      if (better(rp, cur.best)) cur.best = rp;
      if (rp._end > cur.end) cur.end = rp._end;
    } else {
      if (cur) out.push(cur.best);
      cur = { end: rp._end, best: rp };
    }
  }
  if (cur) out.push(cur.best);
  return out;
}

async function handleReplays(teamKey, env) {
  const team = TEAMS[teamKey];
  if (!team) return json({ error: 'unknown team' }, 404);
  if (!env.CF_STREAM_TOKEN) return json({ error: 'missing CF_STREAM_TOKEN' }, 500);

  const [cleanRecs, burnedRecs, games, results] = await Promise.all([
    fetchRecordings(team.liveInput, env.CF_STREAM_TOKEN).catch(() => []),
    team.burnedInput
      ? fetchRecordings(team.burnedInput, env.CF_STREAM_TOKEN).catch(() => [])
      : Promise.resolve([]),
    fetchSpordleGames(team.spordle, env),
    fetchResults(env),
  ]);
  console.log(`${teamKey}: ${cleanRecs.length} clean + ${burnedRecs.length} burned recordings, ${games.length} spordle games, ${results.length} results`);

  const manual = MANUAL_REPLAYS
    .filter(m => m.teamKey === teamKey && !/^REPLACE/.test(m.uid))
    .map(m => Object.assign(buildReplay({ uid: m.uid, created: m.created, duration: m.duration }, games, results, team, teamKey, true), m.overrides || {}));
  const burnedReplays = [...manual, ...burnedRecs.map(v => buildReplay(v, games, results, team, teamKey, true))];
  const cleanReplays  = cleanRecs.map(v => buildReplay(v, games, results, team, teamKey, false));

  // De-dup used to key off the Spordle gameId alone, with an `extras` escape
  // hatch that published unmatched recordings verbatim. That silently broke when
  // the league moved the playoffs into a GC-only org: Spordle's schedule ends
  // 2026-08-05, so every recording after it matched nothing, took the extras
  // path, and BOTH the clean and burned copy were published — alongside every
  // restart sliver. The passes below work on wall-clock spans instead, so they
  // hold whether or not Spordle knows about the game.
  const all = [...burnedReplays, ...cleanReplays];

  // 1. Drop restart slivers that a much longer recording already covers.
  let kept = all.filter(rp => !isSubsumed(rp, all));

  // 2. Drop the clean twin wherever a burned recording covers the same game.
  //    Runs after (1) so only comparable-length pairs are still standing —
  //    a 9-minute burned fragment can never evict a 134-minute clean copy.
  kept = kept.filter(rp => rp._burned || !kept.some(o => o._burned && isTwin(rp, o)));

  // 3. Collapse the remaining restart runs so one game = one replay slot.
  kept = collapseSessions(kept);

  // 4. Spordle-matched recordings still collapse by gameId — more reliable than
  //    timestamps when the match succeeded (survives a mid-game input swap).
  const byGame = new Map();
  const unmatched = [];
  for (const rp of kept) {
    if (rp.gameId == null) { unmatched.push(rp); continue; }
    const prev = byGame.get(rp.gameId);
    if (!prev || better(rp, prev)) byGame.set(rp.gameId, rp);
  }

  return [...byGame.values(), ...unmatched]
    .sort((a, b) => new Date(b._created) - new Date(a._created))
    .slice(0, MAX_REPLAYS)
    // `burned` = scorebug baked in
    .map(({ _created, _burned, _start, _end, ...r }) => ({ ...r, burned: _burned }));
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
