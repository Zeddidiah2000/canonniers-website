#!/usr/bin/env node
/**
 * gc-schedule-pusher — resolve each of our GC games to its organization and
 * venue, then push the map to canonniers-standings-worker.
 *
 * WHY THIS EXISTS
 * GameChanger has no game-type field. The league files playoff games in a
 * SEPARATE organization ("2026 -Séries 15U AAA") instead of tagging them inside
 * the regular-season org ("2026 -Saison 15U AAA"). Those games show up on our
 * team's schedule but NOT in the league org's public events listing, and the
 * public tier never reveals which org a game belongs to — so from the public
 * API alone a series game is indistinguishable from a regular one.
 *
 * The AUTHENTICATED tier does expose it: `GET /events/{id}` returns
 * `organization_id`. This box already keeps a live gc-token in the shared
 * `gctoken` volume for the poller, so it's the only place that can answer the
 * question. We resolve org (+ venue) per game and PUT the map to the worker,
 * which folds it onto season_games on its next refresh.
 *
 * The payoff is that series/tournament detection is SELF-MAINTAINING: when the
 * league creates "2026 -Séries 17U AAA", its games classify themselves on the
 * next cycle with no config edit and no redeploy anywhere.
 *
 * VENUE NOTE: the authenticated tier does NOT carry more location detail than
 * the public one — both return the same `location` object, which is often just
 * a bare Google `place_id`. Readable addresses come from the org's own public
 * events listing (`location.name`), which the league fills in per game for the
 * series org. So we merge: public listing first (has names), authed event as
 * the fallback (has place_id). A place_id still yields a working map link.
 *
 * Design rules carried over from the poller:
 *   - Never push an empty map (the worker also refuses it) — a dead token must
 *     degrade to stale data, never blank the site.
 *   - Cache resolved games on disk; a game's org never changes, so steady-state
 *     costs ~0 authed calls and new games cost one each.
 *   - Every failure is survivable: we push whatever we resolved this cycle plus
 *     everything already cached.
 *
 * Env:
 *   SCHEDULE_PUSH_TOKEN  bearer for the worker PUT (required)
 *   STANDINGS_URL        worker base (default the prod workers.dev URL)
 *   LOCAL_TOKEN_FILE     gc-token json (default /shared-token/gctoken.json)
 *   CACHE_FILE           resolved-game cache (default /state/schedule-meta.json)
 *   CYCLE_MIN            minutes between cycles (default 60)
 *   ONCE=1               run a single cycle and exit (used by --selftest too)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const GC_API = 'https://api.team-manager.gc.com';

const STANDINGS_URL = (process.env.STANDINGS_URL ||
  'https://canonniers-standings-worker.chisholm2000.workers.dev').replace(/\/+$/, '');
const PUSH_TOKEN   = process.env.SCHEDULE_PUSH_TOKEN || '';
const TOKEN_FILE   = process.env.LOCAL_TOKEN_FILE || '/shared-token/gctoken.json';
const CACHE_FILE   = process.env.CACHE_FILE || '/state/schedule-meta.json';
const CYCLE_MIN    = Math.max(5, parseInt(process.env.CYCLE_MIN || '60', 10));

// Our three GC teams. Same ids as canonniers-standings-worker's OUR_TEAMS.
const OUR_TEAMS = {
  u15:   'aMDDLssAvjFT',
  u17d1: 'ri4fPQu1DiQS',
  u17d2: '0DLnmx5bPCGz',
};

// Browser-like headers — a bot UA gets stale/empty responses from GC's edge.
const GC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://web.gc.com',
  'Referer': 'https://web.gc.com/',
};

const log = (...a) => console.log(new Date().toISOString(), '[schedule-pusher]', ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const FETCH_TIMEOUT_MS = Math.max(2000, parseInt(process.env.FETCH_TIMEOUT_MS || '8000', 10));
async function tfetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ── GC fetch (public tier) ──────────────────────────────────────────── */
async function gcPublicJSON(pathname, { retryOnEmpty = false } = {}) {
  const url = `${GC_API}/public${pathname}`;
  const sep = url.includes('?') ? '&' : '?';
  for (let attempt = 0; attempt < 3; attempt++) {
    let data = null, threw = false;
    try {
      const r = await tfetch(`${url}${sep}_cb=${Date.now()}-${attempt}`, { headers: GC_HEADERS });
      if (r.ok) data = await r.json().catch(() => null);
    } catch (_) { threw = true; }
    if (threw) return null;
    const empty = data == null || (Array.isArray(data) && data.length === 0);
    if (!empty || !retryOnEmpty || attempt === 2) return data;
    await sleep(300 * (attempt + 1));
  }
  return null;
}

/* ── GC fetch (token tier) ───────────────────────────────────────────── */
function readToken() {
  try {
    const rec = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (rec && rec.token) return rec;
  } catch (_) { /* not seeded yet */ }
  return null;
}

async function gcAuthedJSON(pathname, tokenRec) {
  const headers = {
    ...GC_HEADERS,
    'gc-token': tokenRec.token,
    'gc-app-name': 'web',
    'gc-device-id': tokenRec.device_id || '00000000-0000-4000-8000-000000000000',
  };
  if (tokenRec.waf_token) headers['x-aws-waf-token'] = tokenRec.waf_token;
  const r = await tfetch(`${GC_API}${pathname}?_cb=${Date.now()}`, { headers });
  if (r.status === 401 || r.status === 403) {
    const e = new Error(`gc unauthorized ${r.status} on ${pathname}`);
    e.unauthorized = true;
    throw e;
  }
  if (!r.ok) throw new Error(`gc ${pathname} → ${r.status}`);
  return r.json();
}

/* ── cache ───────────────────────────────────────────────────────────── */
// { games: { [gameId]: meta }, orgs: { [orgUuid]: {name,type,public_id} } }
function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && typeof c === 'object') {
      return { games: c.games || {}, orgs: c.orgs || {} };
    }
  } catch (_) { /* cold start */ }
  return { games: {}, orgs: {} };
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, CACHE_FILE);   // atomic — a torn cache would re-resolve everything
  } catch (e) {
    log('WARN cache write failed:', e.message);
  }
}

/* ── org resolution ──────────────────────────────────────────────────── */
const SERIES_NAME_RE = /s[ée]rie|playoff|\bfinale?s?\b|\b(quart|demi)[- ]finale/i;

async function resolveOrg(orgUuid, cache, tokenRec) {
  if (!orgUuid) return null;
  if (cache.orgs[orgUuid]) return cache.orgs[orgUuid];
  const j = await gcAuthedJSON(`/organizations/${orgUuid}`, tokenRec);
  const rec = {
    name:      j.name || null,
    type:      j.type || null,
    public_id: j.public_id || null,
  };
  cache.orgs[orgUuid] = rec;
  log(`discovered org ${orgUuid} → "${rec.name}" [${rec.type}, public_id=${rec.public_id}]` +
      (SERIES_NAME_RE.test(rec.name || '') ? '  ← SERIES' : ''));
  return rec;
}

// Readable venue names live on the ORG's public events listing, not on the
// game record. Fetch once per org per cycle and index event id → location name.
async function venueIndexForOrg(publicId) {
  const out = new Map();
  if (!publicId) return out;
  const events = await gcPublicJSON(`/organizations/${publicId}/events`, { retryOnEmpty: true });
  if (!Array.isArray(events)) return out;
  for (const e of events) {
    const loc = e && e.location;
    if (!e || !e.id || !loc) continue;
    if (loc.name && String(loc.name).trim() && String(loc.name).trim().toUpperCase() !== 'TBD') {
      out.set(e.id, { venue: String(loc.name).trim(), place_id: loc.place_id || null });
    } else if (loc.place_id) {
      out.set(e.id, { venue: null, place_id: loc.place_id });
    }
  }
  return out;
}

/* ── one cycle ───────────────────────────────────────────────────────── */
async function cycle() {
  const tokenRec = readToken();
  if (!tokenRec) {
    log('no gc-token available — skipping cycle (worker keeps last-good meta)');
    return { skipped: true, reason: 'no token' };
  }

  const cache = loadCache();

  // 1. Every game id on our three schedules (public tier, cheap).
  const gameIds = new Map();      // gameId → team key, for logging only
  for (const [team, teamId] of Object.entries(OUR_TEAMS)) {
    const games = await gcPublicJSON(`/teams/${teamId}/games`, { retryOnEmpty: true });
    if (!Array.isArray(games)) {
      log(`WARN could not list games for ${team} — using cache for its games`);
      continue;
    }
    for (const g of games) if (g && g.id) gameIds.set(g.id, team);
  }
  if (gameIds.size === 0 && Object.keys(cache.games).length === 0) {
    log('no games discovered and cache is empty — nothing to push');
    return { skipped: true, reason: 'no games' };
  }

  // 2. Resolve org for any game we haven't seen before.
  const unresolved = [...gameIds.keys()].filter(id => !cache.games[id]);
  let resolved = 0, unauthorized = false;
  for (const id of unresolved) {
    try {
      const j = await gcAuthedJSON(`/events/${id}`, tokenRec);
      const ev = (j && j.event) || {};
      const org = await resolveOrg(ev.organization_id, cache, tokenRec);
      const loc = ev.location || {};
      cache.games[id] = {
        org_id:        ev.organization_id || null,
        org_name:      (org && org.name) || null,
        org_type:      (org && org.type) || null,
        org_public_id: (org && org.public_id) || null,
        venue:         loc.name || null,
        place_id:      loc.place_id || null,
        series:        SERIES_NAME_RE.test((org && org.name) || ''),
      };
      resolved++;
    } catch (e) {
      if (e.unauthorized) {
        // Token died mid-cycle. Stop burning calls; push what we have.
        log('gc-token rejected — stopping resolution, pushing cached meta');
        unauthorized = true;
        break;
      }
      // A scheduled game GC hasn't opened yet can 404 on /events — normal.
      log(`could not resolve ${id} (${gameIds.get(id)}): ${e.message}`);
    }
    await sleep(120);   // be gentle with GC
  }

  // 3. Fill in readable venues from each org's public events listing.
  const publicIds = [...new Set(Object.values(cache.games).map(m => m.org_public_id).filter(Boolean))];
  let venuesFilled = 0;
  for (const pid of publicIds) {
    const idx = await venueIndexForOrg(pid);
    if (!idx.size) continue;
    for (const [gameId, meta] of Object.entries(cache.games)) {
      const hit = idx.get(gameId);
      if (!hit) continue;
      if (hit.venue && meta.venue !== hit.venue) { meta.venue = hit.venue; venuesFilled++; }
      if (!meta.place_id && hit.place_id) meta.place_id = hit.place_id;
    }
  }

  saveCache(cache);

  // 4. Push. Only games currently on a schedule — drop stale ids so a deleted
  //    game can't linger on the site forever.
  const games = {};
  for (const id of gameIds.keys()) {
    if (cache.games[id]) games[id] = cache.games[id];
  }
  // If the schedule listing failed entirely this cycle, fall back to the cache
  // rather than pushing a thin map that would drop tags.
  const payloadGames = Object.keys(games).length ? games : cache.games;
  if (Object.keys(payloadGames).length === 0) {
    log('refusing to push an empty map');
    return { skipped: true, reason: 'empty payload' };
  }

  const seriesCount = Object.values(payloadGames).filter(m => m.series).length;
  let r;
  try {
    r = await tfetch(`${STANDINGS_URL}/api/schedule-meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${PUSH_TOKEN}` },
      body: JSON.stringify({ source: 'gc-schedule-pusher', games: payloadGames }),
    }, 15000);
  } catch (e) {
    // Worker unreachable. The cache is already on disk, so the next cycle
    // re-pushes without re-resolving anything.
    log('PUSH FAILED (network):', e.message);
    return { ok: false, error: 'network' };
  }
  const body = await r.text().catch(() => '');
  if (!r.ok) {
    log(`PUSH FAILED ${r.status}: ${body.slice(0, 200)}`);
    return { ok: false, status: r.status };
  }

  log(`pushed ${Object.keys(payloadGames).length} games ` +
      `(${seriesCount} series, ${resolved} newly resolved, ${venuesFilled} venues filled` +
      `${unauthorized ? ', token expired mid-cycle' : ''})`);
  return { ok: true, count: Object.keys(payloadGames).length, series: seriesCount, resolved };
}

/* ── selftest ────────────────────────────────────────────────────────── */
// Runs at image build time: pure-logic checks only, no network, no token.
function selftest() {
  const cases = [
    ['2026 -Séries 15U AAA', true],
    ['2026 -Series 15U AAA', true],
    ['2026 -Saison 15U AAA', false],
    ['2026 -Parties Pointés 17U AAA', false],
    ['Tournoi -Détection de talents ABC', false],
    ['Tournoi 17U AAA BSL', false],
    ['2026 Playoffs 17U', true],
    ['Demi-finale 15U', true],
    ['', false],
  ];
  let fail = 0;
  for (const [name, expected] of cases) {
    const got = SERIES_NAME_RE.test(name);
    if (got !== expected) { console.error(`SELFTEST FAIL: "${name}" → ${got}, expected ${expected}`); fail++; }
  }
  if (!PUSH_TOKEN) console.log('selftest note: SCHEDULE_PUSH_TOKEN unset (expected at build time)');
  if (fail) { console.error(`selftest: ${fail} failure(s)`); process.exit(1); }
  console.log('selftest: OK');
}

/* ── main ────────────────────────────────────────────────────────────── */
(async () => {
  if (process.argv.includes('--selftest')) { selftest(); return; }

  if (!PUSH_TOKEN) {
    console.error('SCHEDULE_PUSH_TOKEN is required');
    process.exit(1);
  }

  const once = process.env.ONCE === '1' || process.argv.includes('--once');
  log(`starting (cycle every ${CYCLE_MIN} min, target ${STANDINGS_URL})`);

  for (;;) {
    try {
      await cycle();
    } catch (e) {
      log('cycle threw:', e && e.message ? e.message : String(e));
    }
    if (once) return;
    await sleep(CYCLE_MIN * 60 * 1000);
  }
})();
