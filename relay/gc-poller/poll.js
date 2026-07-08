// relay/gc-poller/poll.js
//
// Self-driving scorebug feed: polls GameChanger for the live 15U game and
// writes ScoreState through the scorebug worker's POLLER_TOKEN bearer door.
//
//   Tier 1 (tokenless, ~10s while live):
//     score + game_status   /public/game-stream-processing/{g.id}/details
//     inning/half/outs      /public/organizations/{org}/events/{event_id}
//                           (fallback inning: linescore scores.length)
//     balls/strikes: null (scorebug.html hides the count), bases: all false
//
//   Tier 2 (gc-token pasted via admin-scorekeeper.html → worker gctoken vault):
//     live count + self-driving batter/pitcher featured cards from
//     /game-stream-processing/{g.id}/plays + /boxscore (membership-gated).
//     401/403 → Tier-1 degrade (gc_token_status:'expired'), never blank.
//
// Rules of the road (see DIRECTIVE-overlay-relay.md §2[4]):
//   - manual always wins: skip the write while state.mode === 'manual'
//   - preserve-on-empty: a failed fetch keeps the last state, skips the write
//   - Canonniers players ONLY on cards; unmatched roster join → log + skip
//   - game final → stop fast polling, leave the last state (worker TTL cleans)
//
// Env: POLLER_TOKEN (required), TEAM, WORKER_BASE, STANDINGS_URL, ROSTER_BASE,
//      GC_TEAM_ID, GC_ORG_ID, FORCE_EVENT_ID (test: poll a completed game as
//      if live), LIVE_POLL_MS, IDLE_POLL_MS.
//
// Run `node poll.js --selftest` for offline fixture checks (count algorithm,
// roster join, featured shape).

'use strict';

const POLLER_TOKEN = process.env.POLLER_TOKEN || '';
const TEAM         = process.env.TEAM || 'u15';
const WORKER_BASE  = process.env.WORKER_BASE  || 'https://canonniers-live-scorebug-worker.chisholm2000.workers.dev';
const STANDINGS_URL = process.env.STANDINGS_URL || 'https://canonniers-standings-worker.chisholm2000.workers.dev/api/standings';
const ROSTER_BASE  = process.env.ROSTER_BASE  || 'https://canonniers-roster-worker.chisholm2000.workers.dev';
const GC_TEAM_ID   = process.env.GC_TEAM_ID   || 'aMDDLssAvjFT';   // Canonniers 15U AAA (public id)
const GC_ORG_ID    = process.env.GC_ORG_ID    || 'xnQjeQyO7cFq';   // 15U AAA league org
const FORCE_EVENT_ID = (process.env.FORCE_EVENT_ID || '').trim();

const LIVE_POLL_MS = Math.max(5000,  parseInt(process.env.LIVE_POLL_MS || '10000', 10));
const IDLE_POLL_MS = Math.max(20000, parseInt(process.env.IDLE_POLL_MS || '60000', 10));
const PREGAME_POLL_MS = 30000;

const GC_API    = 'https://api.team-manager.gc.com';
const GC_PUBLIC = `${GC_API}/public`;
const WORKER_API   = `${WORKER_BASE}/api/scorebug/${TEAM}`;
const GCTOKEN_API  = `${WORKER_API}/gctoken`;
const CANONNIERS_LOGO_URL = 'https://canonniersdequebec.ca/CANONNIERS-LOGO.png';

// Same activity window as the standings worker's idle-skip.
const ACTIVITY_LOOKBACK_MS  = 6 * 60 * 60 * 1000;
const ACTIVITY_LOOKAHEAD_MS = 30 * 60 * 1000;

// Stable per-process fallback when Jay didn't paste a gc-device-id.
const FALLBACK_DEVICE_ID = require('crypto').randomUUID();

// Browser-like headers — copied from canonniers-standings-worker (a bot UA
// gets stale/empty GC edge responses mid-game).
const GC_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://web.gc.com',
  'Referer': 'https://web.gc.com/',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/* ── GC fetch (public tier) ──────────────────────────────────────────── */
// Ported from the standings worker's gcFetchJSON: cache-bust per attempt
// (GC's upstream CDN caches per URL — this is what unfroze live scores) +
// escalating retry on empty. Returns parsed JSON or null on hard failure.
async function gcFetchJSON(url, { retryOnEmpty = false } = {}) {
  const sep = url.includes('?') ? '&' : '?';
  for (let attempt = 0; attempt < 3; attempt++) {
    let data = null;
    try {
      const bustUrl = `${url}${sep}_cb=${Date.now()}-${attempt}`;
      const r = await fetch(bustUrl, { headers: GC_HEADERS });
      if (r.ok) data = await r.json().catch(() => null);
    } catch (_) { data = null; }
    const empty = data == null || (Array.isArray(data) && data.length === 0);
    if (!empty || !retryOnEmpty || attempt === 2) return data;
    await sleep(300 * (attempt + 1));
  }
  return null;
}

/* ── GC fetch (token tier) ───────────────────────────────────────────── */
// Throws { unauthorized: true } on 401/403 so the caller can degrade to
// Tier 1 and flag the token expired.
async function gcAuthedJSON(path, tokenRec) {
  const headers = {
    ...GC_HEADERS,
    'gc-token': tokenRec.token,
    'gc-app-name': 'web',
    'gc-device-id': tokenRec.device_id || FALLBACK_DEVICE_ID,
  };
  if (tokenRec.waf_token) headers['x-aws-waf-token'] = tokenRec.waf_token;
  const r = await fetch(`${GC_API}${path}?_cb=${Date.now()}`, { headers });
  if (r.status === 401 || r.status === 403) {
    const e = new Error(`gc unauthorized ${r.status} on ${path}`);
    e.unauthorized = true;
    throw e;
  }
  if (!r.ok) throw new Error(`gc ${path} → ${r.status}`);
  return r.json();
}

/* ── Scorebug worker API ─────────────────────────────────────────────── */
async function workerGetState() {
  const r = await fetch(WORKER_API, { headers: { 'Cache-Control': 'no-store' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`worker GET state → ${r.status}`);
  return r.json();
}

async function workerPutState(state) {
  const r = await fetch(WORKER_API, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${POLLER_TOKEN}`,
    },
    body: JSON.stringify(state),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`worker PUT state → ${r.status} ${detail.slice(0, 200)}`);
  }
  return r.json();
}

async function workerPutCommentary(lines) {
  const r = await fetch(`${WORKER_API}/commentary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${POLLER_TOKEN}` },
    body: JSON.stringify(lines),
  });
  if (!r.ok) throw new Error(`worker PUT commentary → ${r.status}`);
  return r.json();
}

async function workerGetGcToken() {
  const r = await fetch(GCTOKEN_API, {
    headers: { 'Authorization': `Bearer ${POLLER_TOKEN}` },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`worker GET gctoken → ${r.status}`);
  return r.json();
}

/* ── Roster (D1 via roster worker) ───────────────────────────────────── */
const rosterCache = { players: [], fetchedAt: 0 };

async function getRoster() {
  if (Date.now() - rosterCache.fetchedAt < 10 * 60 * 1000 && rosterCache.players.length) {
    return rosterCache.players;
  }
  try {
    const r = await fetch(`${ROSTER_BASE}/api/players`);
    if (!r.ok) throw new Error(`roster → ${r.status}`);
    const players = await r.json();
    const ours = (Array.isArray(players) ? players : [])
      .filter((p) => String(p.team_category || '').toLowerCase() === TEAM);
    if (ours.length) {
      rosterCache.players = ours;
      rosterCache.fetchedAt = Date.now();
    }
    return rosterCache.players;
  } catch (e) {
    log('roster fetch failed (using cache):', e.message);
    return rosterCache.players;
  }
}

/* ── Name helpers ────────────────────────────────────────────────────── */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Ported from the standings worker: strip "-15U 2026"-style suffixes.
function cleanTeamName(raw) {
  return String(raw || '')
    .replace(/\s*-?\s*\d{1,2}U(\s*\d{4})?\s*/, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^-\s*/, '')
    .trim();
}

// GC UUID → D1 roster join: jersey number anchors, accent-normalized name
// verifies. Unmatched → null (never a wrong card).
function findRosterPlayer(roster, gcp) {
  const num = Number(gcp.number);
  if (!Number.isFinite(num)) return null;
  const gcFull = norm(`${gcp.first_name || ''} ${gcp.last_name || ''}`);
  const gcLast = norm(gcp.last_name || '');
  for (const p of roster) {
    if (Number(p.number) !== num) continue;
    const full = norm(p.name);
    if (!full) continue;
    const lastTok = full.split(' ').pop();
    if (full === gcFull ||
        (gcLast && full.endsWith(' ' + gcLast)) ||
        (lastTok && gcFull.endsWith(' ' + lastTok))) {
      return p;
    }
  }
  return null;
}

// EXACT port of admin-scorekeeper.html rosterToFeaturedPlayer() — the card
// renderer expects precisely this shape.
function rosterToFeaturedPlayer(p, mode) {
  let photo_url = p.photo_url || null;
  if (photo_url && !/^https?:\/\//i.test(photo_url)) {
    photo_url = ROSTER_BASE + photo_url;
  }
  const name = (p.name || '').trim();
  const lastSpace = name.lastIndexOf(' ');
  const first_name = lastSpace > 0 ? name.slice(0, lastSpace) : name;
  const last_name  = lastSpace > 0 ? name.slice(lastSpace + 1) : '';
  const bt = (p.bats_throws || '').split('/').map((s) => s.trim());
  const bats = bt[0] || '';
  const throws_ = bt[1] || '';

  const stats = { AVG: null, OPS: null, HR: null, RBI: null, SB: null,
                  ERA: null, IP: null, K: null, WHIP: null };
  try {
    const root = p.stats_json ? (typeof p.stats_json === 'string' ? JSON.parse(p.stats_json) : p.stats_json) : null;
    const years = root ? Object.keys(root).filter((k) => /^\d{4}$/.test(k)).sort().reverse() : [];
    const yearBlock = years.length ? root[years[0]] : null;
    if (yearBlock) {
      if (mode === 'batter' && yearBlock.batting) {
        const b = yearBlock.batting;
        stats.AVG = b.AVG ?? null;
        stats.OPS = b.OPS ?? null;
        stats.HR  = b.HR  ?? null;
        stats.RBI = b.RBI ?? null;
        stats.SB  = b.SB  ?? null;
      } else if (mode === 'pitcher' && yearBlock.pitching) {
        const pi = yearBlock.pitching;
        stats.ERA  = pi.ERA  ?? null;
        stats.IP   = pi.IP   ?? null;
        stats.K    = pi.SO   ?? null;
        stats.WHIP = pi.WHIP ?? null;
      }
    }
  } catch (_) { /* stats stay null */ }

  return {
    number: Number(p.number) || 0,
    mode,
    first_name, last_name,
    position: p.position || '',
    bats, throws: throws_,
    photo_url,
    stats,
  };
}

/* ── Tier 2: count + featured card from /plays + /boxscore ───────────── */
// Live count from the pending at-bat's pitch list (runbook §3): balls = the
// `Ball N` entries; strikes capped at 2; Foul only adds below 2.
function countFromDetails(details) {
  let b = 0, s = 0;
  for (const d of details || []) {
    const t = String((d && d.template) || '');
    if (/^Ball/.test(t)) b++;
    else if (/^Strike/.test(t)) { if (s < 2) s++; }
    else if (t === 'Foul') { if (s < 2) s++; }
  }
  return { balls: Math.min(b, 3), strikes: s };
}

function computeTier2(plays, boxscore, roster, homeAway) {
  const list = (plays && Array.isArray(plays.plays)) ? plays.plays : [];
  const last = list[list.length - 1];
  if (!last) return null;

  // NOTE: the score is intentionally NOT taken from the play feed. The last
  // play is the pending at-bat, whose home_score/away_score are 0 until the AB
  // completes — trusting them zeroes out the scoreboard. The score always comes
  // from /details in buildAndWrite; Tier-2 only supplies count/cards/inning/
  // half/outs.
  const out = {
    inning: last.inning ?? null,
    half:   (last.half === 'top' || last.half === 'bottom') ? last.half : null,
    outs:   clampInt(last.outs, 0, 2, 0),
    featured: null,
  };

  const tmpl = String((last.name_template && last.name_template.template) || '');
  const pendingAB = /at bat/.test(tmpl);
  if (pendingAB) {
    const c = countFromDetails(last.at_plate_details);
    out.balls = c.balls;
    out.strikes = c.strikes;
  } else {
    out.balls = 0;   // between batters — a real 0-0
    out.strikes = 0;
  }

  // Our roster lookup for both card paths. team_players is keyed by team;
  // ours uses the public id (runbook §3).
  const teamPlayers = (plays.team_players && plays.team_players[GC_TEAM_ID]) || [];
  const byId = new Map(teamPlayers.map((p) => [p.id, p]));

  const ourHalfAtBat = homeAway === 'home' ? 'bottom' : 'top';
  const weBat = out.half === ourHalfAtBat;

  if (weBat && pendingAB) {
    // Our batter card — resolve "${uuid} at bat".
    const m = tmpl.match(/\$\{([0-9a-f-]{36})\}/);
    const gcp = m ? byId.get(m[1]) : null;
    if (gcp) {
      const rp = findRosterPlayer(roster, gcp);
      if (rp) out.featured = rosterToFeaturedPlayer(rp, 'batter');
      else log(`roster join MISS (batter): #${gcp.number} ${gcp.first_name} ${gcp.last_name} — no card`);
    }
  } else if (!weBat && out.half) {
    // Our defense — pitcher card. Runbook §6: pitcher = pitching group,
    // listed first; cross-check substitution messages (last change wins).
    const ourBox = boxscore && boxscore[GC_TEAM_ID];
    const pitching = ourBox && (ourBox.groups || []).find((g) => g.category === 'pitching');
    let pitcherId = pitching && pitching.stats && pitching.stats[0]
      ? pitching.stats[0].player_id : null;
    for (const play of list) {
      for (const msg of (play.messages || [])) {
        const t = String((msg && msg.template) || msg || '');
        if (!/pitch/i.test(t)) continue;
        const mm = t.match(/\$\{([0-9a-f-]{36})\}/);
        if (mm && byId.has(mm[1])) pitcherId = mm[1];
      }
    }
    const gcp = pitcherId ? byId.get(pitcherId) : null;
    if (gcp) {
      const rp = findRosterPlayer(roster, gcp);
      if (rp) out.featured = rosterToFeaturedPlayer(rp, 'pitcher');
      else log(`roster join MISS (pitcher): #${gcp.number} ${gcp.first_name} ${gcp.last_name} — no card`);
    }
  }

  return out;
}

/* ── Commentary feed (voice play-by-play v0) ─────────────────────────── */
// Resolve ${uuid} templates (runbook §3) against BOTH teams' player lists.
function buildNameMap(plays) {
  const map = {};
  const tp = plays && plays.team_players;
  if (tp && typeof tp === 'object') {
    for (const list of Object.values(tp)) {
      for (const p of (Array.isArray(list) ? list : [])) {
        if (p && p.id) map[p.id] = `${p.first_name || ''} ${p.last_name || ''}`.trim();
      }
    }
  }
  return map;
}
function resolveTemplate(str, names) {
  return String(str || '').replace(/\$\{([0-9a-f-]{36})\}/g, (_, id) => names[id] || 'the runner');
}
// Light EN→FR gloss for the common outcomes so the FR voice isn't pure English.
// (v1 replaces this with a Claude rewrite — see DIRECTIVE-voice-playbyplay.md.)
function glossFR(en) {
  let s = en;
  const rules = [
    [/\bscores\b/gi, 'marque'],
    [/\bwalks\b/gi, 'obtient un but sur balles'],
    [/\bstrikes out swinging\b/gi, 'est retiré sur trois prises (élan)'],
    [/\bstrikes out looking\b/gi, 'est retiré sur trois prises'],
    [/\bstrikes out\b/gi, 'est retiré sur des prises'],
    [/\bhits a home run\b/gi, 'frappe un circuit'],
    [/\bhomers\b/gi, 'frappe un circuit'],
    [/\bsingles\b/gi, 'frappe un simple'],
    [/\bdoubles\b/gi, 'frappe un double'],
    [/\btriples\b/gi, 'frappe un triple'],
    // "X out to <fielder>" — capture the "to" so no English leaks.
    [/\bflies out to\b/gi, 'est retiré sur un ballon capté par'],
    [/\bgrounds out to\b/gi, 'est retiré au sol par'],
    [/\blines out to\b/gi, 'est retiré sur une flèche captée par'],
    [/\bpops out to\b/gi, 'est retiré sur une chandelle captée par'],
    [/\bflies out\b/gi, 'est retiré sur un ballon'],
    [/\bgrounds out\b/gi, 'est retiré au sol'],
    [/\blines out\b/gi, 'est retiré sur une flèche'],
    [/\bpops out\b/gi, 'est retiré sur une chandelle'],
    [/\bgrounds into a double play\b/gi, 'frappe dans un double-jeu'],
    [/\breaches (on )?(an? )?error\b/gi, 'atteint le but sur une erreur'],
    [/\bis hit by pitch\b/gi, 'est atteint par un lancer'],
    [/\badvances to\b/gi, 'avance au'],
    [/\bon a (?:\w+ )*ground ball to\b/gi, 'sur un roulant vers'],
    [/\bon a (?:\w+ )*fly ball to\b/gi, 'sur un ballon vers'],
    [/\bon a (?:\w+ )*line drive to\b/gi, 'sur une flèche vers'],
    [/\bon a (?:\w+ )*pop ?up to\b/gi, 'sur une chandelle vers'],
    [/,?\s*\b([\wÀ-ÿ' -]+?) pitching\b/gi, ' (lanceur : $1)'],
    [/\bpitcher\b/gi, 'lanceur'], [/\bcatcher\b/gi, 'receveur'],
    [/\bfirst baseman\b/gi, 'premier but'], [/\bsecond baseman\b/gi, 'deuxième but'],
    [/\bthird baseman\b/gi, 'troisième but'], [/\bshortstop\b/gi, 'arrêt-court'],
    [/\bleft fielder\b/gi, 'voltigeur de gauche'], [/\bcenter fielder\b/gi, 'voltigeur de centre'],
    [/\bright fielder\b/gi, 'voltigeur de droite'],
  ];
  for (const [re, fr] of rules) s = s.replace(re, fr);
  return s;
}

const commentaryState = { lastOrder: -1, lines: [] };
async function updateCommentary(plays) {
  const list = (plays && Array.isArray(plays.plays)) ? plays.plays : [];
  if (!list.length) return;
  const names = buildNameMap(plays);
  let added = false;
  for (const p of list) {
    const order = Number.isFinite(p.order) ? p.order : list.indexOf(p);
    if (order <= commentaryState.lastOrder) continue;
    // Only completed plays have final_details; the pending AB has none.
    const details = Array.isArray(p.final_details) ? p.final_details : [];
    if (!details.length) continue;
    const en = details.map((d) => resolveTemplate(d.template, names)).join('. ').replace(/\s+/g, ' ').trim();
    if (!en) { commentaryState.lastOrder = Math.max(commentaryState.lastOrder, order); continue; }
    commentaryState.lines.push({ id: order, en, fr: glossFR(en), ts: new Date().toISOString() });
    commentaryState.lastOrder = order;
    added = true;
  }
  if (commentaryState.lines.length > 40) commentaryState.lines = commentaryState.lines.slice(-40);
  if (added) {
    try { await workerPutCommentary(commentaryState.lines); }
    catch (e) { log('commentary PUT failed:', e.message); }
  }
}

/* ── Tier 1: tokenless inning/half/outs ──────────────────────────────── */
// Org-events supplement (reference_gc_live_endpoints): total_outs is
// CUMULATIVE — current-half outs = % 3.
async function fetchOrgEventLive(eventId) {
  const ev = await gcFetchJSON(`${GC_PUBLIC}/organizations/${GC_ORG_ID}/events/${eventId}`);
  if (!ev || typeof ev !== 'object') return null;
  const bats = (ev.sport_specific && ev.sport_specific.bats) || {};
  const dd = bats.inning_details || {};
  return {
    inning: Number.isFinite(dd.inning) ? dd.inning : null,
    half:   (dd.half === 'top' || dd.half === 'bottom') ? dd.half : null,
    outs:   Number.isFinite(bats.total_outs) ? ((bats.total_outs % 3) + 3) % 3 : null,
  };
}

async function fetchLinescoreInning(gameId) {
  const ls = await gcFetchJSON(`${GC_PUBLIC}/game-stream-processing/organizations/${gameId}/linescore`);
  if (!ls || typeof ls !== 'object') return null;
  let inning = 0;
  for (const v of Object.values(ls)) {
    if (v && Array.isArray(v.scores)) inning = Math.max(inning, v.scores.length);
  }
  return inning || null;
}

// Ported from the standings worker: map our season_games entry to its GC
// event id via the org events listing (team pair + nearest start_ts).
function matchEventId(events, g) {
  const ourId = g.our_team_id || GC_TEAM_ID;
  const oppId = (g.opponent && g.opponent.team_id) || null;
  const gTs = g.start_ts ? new Date(g.start_ts).getTime() : NaN;
  let best = null, bestDelta = Infinity;
  for (const ev of events) {
    const hId = ev.home_team && ev.home_team.id;
    const aId = ev.away_team && ev.away_team.id;
    if (hId !== ourId && aId !== ourId) continue;
    if (oppId && hId !== oppId && aId !== oppId) continue;
    const evTs = ev.start_ts ? new Date(ev.start_ts).getTime() : NaN;
    const delta = (!isNaN(gTs) && !isNaN(evTs)) ? Math.abs(evTs - gTs) : 0;
    if (delta < bestDelta) { bestDelta = delta; best = ev; }
  }
  if (best && bestDelta !== Infinity && bestDelta > 6 * 60 * 60 * 1000) return null;
  return (best && best.id) || null;
}

/* ── gc-token source ─────────────────────────────────────────────────── */
// Two sources, in priority order:
//   1. LOCAL_TOKEN_FILE — written by the mint-loop sidecar (trusted-device
//      auto-minted, refreshed every ~45min). Instant, no human. Preferred.
//   2. worker gctoken vault — Jay's manual paste from admin-scorekeeper.html.
//      Fallback for when the minter's device-trust has expired.
// A token whose JWT `exp` has passed is skipped (the minter should have
// refreshed it; if not, we degrade to Tier-1 rather than send a dead token).
const LOCAL_TOKEN_FILE = process.env.LOCAL_TOKEN_FILE || '/shared-token/gctoken.json';
const tokenState = { rec: null, fetchedAt: 0, deadSavedAt: null };

function jwtExpMs(tok) {
  try {
    const p = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number.isFinite(p.exp) ? p.exp * 1000 : null;
  } catch { return null; }
}

function readLocalToken() {
  try {
    const raw = require('fs').readFileSync(LOCAL_TOKEN_FILE, 'utf8');
    const rec = JSON.parse(raw);
    if (!rec || !rec.token) return null;
    const exp = jwtExpMs(rec.token);
    if (exp && exp < Date.now() + 15 * 1000) return null;  // expired/about to
    return { token: rec.token, device_id: rec.device_id || null, waf_token: rec.waf_token || null, saved_at: rec.minted_at || 'local' };
  } catch { return null; }
}

async function ensureGcToken() {
  // 1. Local auto-minted token wins whenever it's fresh — unless GC already
  //    rejected this exact one (deadSavedAt), in which case wait for the
  //    minter to write a newer file.
  const local = readLocalToken();
  if (local && !(tokenState.deadSavedAt && local.saved_at === tokenState.deadSavedAt)) {
    return { rec: local, status: 'ok', source: 'auto' };
  }

  // 2. Fall back to the vault (manual paste), cached ~60s.
  if (Date.now() - tokenState.fetchedAt > 60 * 1000) {
    try {
      tokenState.rec = await workerGetGcToken();
      tokenState.fetchedAt = Date.now();
    } catch (e) {
      log('gctoken vault fetch failed (keeping cached):', e.message);
    }
  }
  const rec = tokenState.rec;
  if (!rec || !rec.token) return { rec: null, status: 'absent' };
  if (tokenState.deadSavedAt && rec.saved_at === tokenState.deadSavedAt) {
    return { rec: null, status: 'expired' };   // dead until Jay re-pastes
  }
  return { rec, status: 'ok', source: 'paste' };
}

/* ── Game discovery ──────────────────────────────────────────────────── */
const finishedIds = new Set();

async function discoverGame() {
  if (FORCE_EVENT_ID) {
    const det = await gcFetchJSON(`${GC_PUBLIC}/game-stream-processing/${FORCE_EVENT_ID}/details`);
    if (!det || typeof det !== 'object') return null;
    return {
      id: FORCE_EVENT_ID,
      forced: true,
      start_ts: det.start_ts || null,
      our_team_id: GC_TEAM_ID,
      event_id: null,
      opponent: { name: cleanTeamName(det.opponent_team && det.opponent_team.name), logo: null, team_id: null },
    };
  }

  const r = await fetch(`${STANDINGS_URL}?_cb=${Date.now()}`, { headers: { 'Cache-Control': 'no-store' } });
  if (!r.ok) throw new Error(`standings → ${r.status}`);
  const data = await r.json();
  const games = (data && data.season_games && data.season_games[TEAM]) || [];
  const now = Date.now();

  let candidate = games.find((g) => g && g.game_status === 'live' && !finishedIds.has(g.id));
  if (!candidate) {
    candidate = games.find((g) => {
      if (!g || finishedIds.has(g.id)) return false;
      if (g.game_status === 'completed' || g.game_status === 'final') return false;
      const ts = g.start_ts ? Date.parse(g.start_ts) : NaN;
      return !isNaN(ts) && ts >= now - ACTIVITY_LOOKBACK_MS && ts <= now + ACTIVITY_LOOKAHEAD_MS;
    });
  }
  return candidate || null;
}

/* ── State assembly + write ──────────────────────────────────────────── */
async function buildAndWrite(game, det, t1, t2, tokenStatus, current) {
  const homeAway = det.home_away === 'away' ? 'away' : 'home';

  // Score always from /details: { team, opponent_team } from OUR side → home/away.
  const us   = (det.score && Number.isFinite(det.score.team))          ? det.score.team          : 0;
  const them = (det.score && Number.isFinite(det.score.opponent_team)) ? det.score.opponent_team : 0;
  const home_runs = homeAway === 'home' ? us : them;
  const away_runs = homeAway === 'home' ? them : us;

  const oppName = (cleanTeamName((game.opponent && game.opponent.name) || (det.opponent_team && det.opponent_team.name) || '')
    || 'VISITEUR').toUpperCase().slice(0, 30);
  const oppLogo = (game.opponent && game.opponent.logo) || null;

  const state = {
    visible: true,
    mode: 'auto',
    overlay_scale: (current && typeof current.overlay_scale === 'number') ? current.overlay_scale : 1,
    score: {
      home_name: homeAway === 'home' ? 'CANONNIERS' : oppName,
      away_name: homeAway === 'home' ? oppName : 'CANONNIERS',
      home_logo_url: homeAway === 'home' ? CANONNIERS_LOGO_URL : oppLogo,
      away_logo_url: homeAway === 'home' ? oppLogo : CANONNIERS_LOGO_URL,
      home_runs: clampInt(home_runs, 0, 99, 0),
      away_runs: clampInt(away_runs, 0, 99, 0),
    },
    game: {
      inning: clampInt((t2 && t2.inning) ?? t1.inning ?? 1, 1, 20, 1),
      half:   (t2 && t2.half) || t1.half || 'top',
      balls:   t2 ? clampInt(t2.balls, 0, 3, 0)   : null,
      strikes: t2 ? clampInt(t2.strikes, 0, 2, 0) : null,
      outs:   clampInt((t2 && t2.outs) ?? t1.outs ?? 0, 0, 2, 0),
      bases: { first: false, second: false, third: false },
    },
    featured_player: t2 ? t2.featured : null,
    gc_token_status: tokenStatus,
    auto_updated_at: new Date().toISOString(),
  };

  await workerPutState(state);
  return state;
}

/* ── Live loop ───────────────────────────────────────────────────────── */
async function liveLoop(game) {
  log(`tracking game ${game.id} vs "${(game.opponent && game.opponent.name) || '?'}"${game.forced ? ' [FORCED]' : ''}`);
  // Fresh game → reset the commentary feed so play-ids don't collide with a
  // prior game's (teststream seeds to the newest id on turn-on).
  commentaryState.lastOrder = -1;
  commentaryState.lines = [];
  try { await workerPutCommentary([]); } catch (_) { /* non-fatal */ }
  let manualLogged = false;
  let eventIdTriedAt = 0;
  let lastT2 = null;               // { data, at } — reused ≤45s on transient Tier-2 failure

  for (;;) {
    const tickStart = Date.now();
    let sleepMs = LIVE_POLL_MS;
    try {
      // 1. details — status + score (public, keyed by our game id)
      const det = await gcFetchJSON(`${GC_PUBLIC}/game-stream-processing/${game.id}/details`, { retryOnEmpty: true });
      if (!det || typeof det !== 'object' || det.game_status == null) {
        log('details fetch failed — preserving last state, skipping write');
        await sleep(LIVE_POLL_MS);
        continue;
      }

      const status = det.game_status;
      if (!game.forced && (status === 'final' || status === 'completed')) {
        log(`game ${game.id} is final — leaving last state, back to discovery`);
        finishedIds.add(game.id);
        return;
      }
      if (!game.forced && status !== 'live') {
        // pregame: keep watching, don't write anything yet
        await sleep(PREGAME_POLL_MS);
        continue;
      }

      // 2. manual override check (GET first — cheap; manual always wins)
      const current = await workerGetState().catch(() => undefined);
      if (current && current.mode === 'manual') {
        if (!manualLogged) { log('state.mode = manual — yielding until AUTO'); manualLogged = true; }
        await sleep(LIVE_POLL_MS);
        continue;
      }
      if (manualLogged) { log('state.mode back to auto — resuming'); manualLogged = false; }

      // 3. Tier 1 — inning/half/outs from the org-events tier
      const t1 = { inning: null, half: null, outs: null };
      if (!game.event_id && Date.now() - eventIdTriedAt > 5 * 60 * 1000) {
        eventIdTriedAt = Date.now();
        const events = await gcFetchJSON(`${GC_PUBLIC}/organizations/${GC_ORG_ID}/events`, { retryOnEmpty: true });
        if (Array.isArray(events)) {
          game.event_id = matchEventId(events, game);
          log(game.event_id ? `resolved event_id ${game.event_id}` : 'event_id unresolved (will retry in 5 min)');
        }
      }
      if (game.event_id) {
        const ev = await fetchOrgEventLive(game.event_id);
        if (ev) Object.assign(t1, ev);
      }
      if (t1.inning == null) {
        t1.inning = await fetchLinescoreInning(game.id);
      }

      // 4. Tier 2 — count + featured card (needs the pasted gc-token)
      let t2 = null;
      let { rec, status: tokenStatus } = await ensureGcToken();
      if (rec) {
        try {
          const [plays, boxscore] = await Promise.all([
            gcAuthedJSON(`/game-stream-processing/${game.id}/plays`, rec),
            gcAuthedJSON(`/game-stream-processing/${game.id}/boxscore`, rec),
          ]);
          const roster = await getRoster();
          t2 = computeTier2(plays, boxscore, roster, det.home_away === 'away' ? 'away' : 'home');
          if (t2) lastT2 = { data: t2, at: Date.now() };
          // Voice play-by-play feed (best-effort; never blocks the scorebug).
          try { await updateCommentary(plays); } catch (_) { /* non-fatal */ }
        } catch (e) {
          if (e.unauthorized) {
            tokenStatus = 'expired';
            tokenState.deadSavedAt = rec.saved_at || 'unknown';
            lastT2 = null;
            log('gc-token rejected — Tier-1 degrade until a fresh paste:', e.message);
          } else {
            // transient — reuse the last good Tier-2 briefly rather than
            // flapping cards/count off and on
            if (lastT2 && Date.now() - lastT2.at < 45 * 1000) t2 = lastT2.data;
            log('Tier-2 fetch failed (transient):', e.message);
          }
        }
      }

      // 5. write
      const written = await buildAndWrite(game, det, t1, t2, tokenStatus, current);
      log(`wrote: ${written.score.away_name} ${written.score.away_runs} @ ${written.score.home_name} ${written.score.home_runs}` +
          ` · ${written.game.half} ${written.game.inning}, ${written.game.outs} out` +
          (written.game.balls != null ? ` · count ${written.game.balls}-${written.game.strikes}` : ' · count hidden') +
          (written.featured_player ? ` · card ${written.featured_player.mode} #${written.featured_player.number}` : '') +
          ` · token ${tokenStatus}`);
    } catch (e) {
      log('tick error (preserving last state):', e.message);
    }
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(1000, sleepMs - elapsed));
  }
}

/* ── Main ────────────────────────────────────────────────────────────── */
async function main() {
  if (!POLLER_TOKEN) {
    console.error('POLLER_TOKEN is required (worker bearer). Refusing to start.');
    process.exit(1);
  }
  log(`gc-poller up · team=${TEAM} · worker=${WORKER_BASE}` +
      (FORCE_EVENT_ID ? ` · FORCE_EVENT_ID=${FORCE_EVENT_ID}` : ''));

  for (;;) {
    let game = null;
    try {
      game = await discoverGame();
    } catch (e) {
      log('discovery failed:', e.message);
    }
    if (game) {
      try {
        await liveLoop(game);
      } catch (e) {
        log('live loop crashed (back to discovery):', e.message);
      }
    }
    await sleep(IDLE_POLL_MS);
  }
}

/* ── Offline self-test (node poll.js --selftest) ─────────────────────── */
function selftest() {
  const assert = require('assert');

  // Count algorithm (runbook §3 worked example: Strike looking + Foul = 0-2)
  assert.deepStrictEqual(
    countFromDetails([{ template: 'Strike 1 looking' }, { template: 'Foul' }]),
    { balls: 0, strikes: 2 });
  // Foul with 2 strikes doesn't add
  assert.deepStrictEqual(
    countFromDetails([{ template: 'Strike 1 swinging' }, { template: 'Strike 2 looking' }, { template: 'Foul' }, { template: 'Foul' }]),
    { balls: 0, strikes: 2 });
  // Balls count; baserunning noise ignored
  assert.deepStrictEqual(
    countFromDetails([{ template: 'Ball 1' }, { template: 'Pickoff attempt at 1st' }, { template: 'Ball 2' }, { template: '${x} advances to 2nd on wild pitch' }]),
    { balls: 2, strikes: 0 });

  // Roster join: number + accent-normalized name
  const roster = [
    { number: 22, name: 'Félix Côté' },
    { number: 7,  name: 'William De La Durantaye' },
    { number: 13, name: 'Nathan Roy' },
  ];
  assert.strictEqual(findRosterPlayer(roster, { number: '22', first_name: 'Felix', last_name: 'Cote' }), roster[0]);
  assert.strictEqual(findRosterPlayer(roster, { number: '7', first_name: 'William', last_name: 'De La Durantaye' }), roster[1]);
  // same number, different name → MISS (never a wrong card)
  assert.strictEqual(findRosterPlayer(roster, { number: '13', first_name: 'Zack', last_name: 'Tremblay' }), null);

  // Featured shape matches the admin page's renderer contract
  const fp = rosterToFeaturedPlayer(
    { number: '22', name: 'Félix Côté', position: 'SS', bats_throws: 'G/D',
      photo_url: '/api/players/22/photo',
      stats_json: JSON.stringify({ 2025: { batting: { AVG: '.300' } }, 2026: { batting: { AVG: '.312', OPS: '.890', HR: 2, RBI: 14, SB: 9 }, pitching: { ERA: '2.10', IP: '21.0', SO: 30, WHIP: '1.05' } } }) },
    'batter');
  assert.strictEqual(fp.first_name, 'Félix');
  assert.strictEqual(fp.last_name, 'Côté');
  assert.strictEqual(fp.bats, 'G');
  assert.strictEqual(fp.throws, 'D');
  assert.strictEqual(fp.photo_url, ROSTER_BASE + '/api/players/22/photo');
  assert.strictEqual(fp.stats.AVG, '.312');   // latest year wins
  assert.strictEqual(fp.stats.ERA, null);     // batter mode
  const pp = rosterToFeaturedPlayer({ number: 22, name: 'Félix Côté', stats_json: { 2026: { pitching: { ERA: '2.10', IP: '21.0', SO: 30, WHIP: '1.05' } } } }, 'pitcher');
  assert.strictEqual(pp.stats.K, 30);         // K = pitching SO

  // Tier-2 compute: our half at bat → batter card + live count
  const plays = {
    team_players: {
      [GC_TEAM_ID]: [{ id: '11111111-1111-4111-8111-111111111111', first_name: 'Félix', last_name: 'Côté', number: '22' }],
      'OPPONENT': [{ id: '22222222-2222-4222-8222-222222222222', first_name: 'Ozzy', last_name: 'Opp', number: '9' }],
    },
    plays: [{
      inning: 3, half: 'bottom', outs: 1, home_score: 4, away_score: 2,
      name_template: { template: '${11111111-1111-4111-8111-111111111111} at bat' },
      at_plate_details: [{ template: 'Ball 1' }, { template: 'Strike 1 looking' }],
      final_details: [], messages: [],
    }],
  };
  const t2 = computeTier2(plays, null, roster.concat([{ number: 22, name: 'Félix Côté', stats_json: null }]), 'home');
  assert.strictEqual(t2.balls, 1);
  assert.strictEqual(t2.strikes, 1);
  assert.strictEqual(t2.half, 'bottom');
  assert.ok(t2.featured && t2.featured.mode === 'batter' && t2.featured.number === 22);

  // Opponent half → pitcher card from boxscore
  const playsTop = { ...plays, plays: [{ ...plays.plays[0], half: 'top', name_template: { template: '${22222222-2222-4222-8222-222222222222} at bat' } }] };
  const box = { [GC_TEAM_ID]: { players: [], groups: [{ category: 'pitching', stats: [{ player_id: '11111111-1111-4111-8111-111111111111' }] }] } };
  const t2p = computeTier2(playsTop, box, roster, 'home');
  assert.ok(t2p.featured && t2p.featured.mode === 'pitcher');

  console.log('selftest OK');
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main().catch((e) => { console.error('fatal:', e); process.exit(1); });
}
