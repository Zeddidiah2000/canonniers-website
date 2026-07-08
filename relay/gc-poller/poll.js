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

const LIVE_POLL_MS = Math.max(800,   parseInt(process.env.LIVE_POLL_MS || '5000', 10));
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

// Every fetch gets a hard timeout so one slow/hung response can't stall a whole
// tick (the "hiccup then catch up" — a laggy GC poll would freeze the scorebug
// until it returned). On timeout the fetch aborts, the tick abandons that call
// and recovers on the next poll (~1.5s later) instead of blocking.
const FETCH_TIMEOUT_MS = Math.max(800, parseInt(process.env.FETCH_TIMEOUT_MS || '2500', 10));
async function tfetch(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
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
    let data = null, threw = false;
    try {
      const bustUrl = `${url}${sep}_cb=${Date.now()}-${attempt}`;
      const r = await tfetch(bustUrl, { headers: GC_HEADERS });
      if (r.ok) data = await r.json().catch(() => null);
    } catch (_) { threw = true; }
    // A timeout / network error must NOT trigger the empty-retry loop — retrying
    // a hung endpoint just multiplies the timeout into a multi-second blip.
    // Bail immediately; the next tick (~1.5s away) retries fresh.
    if (threw) return null;
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
  const r = await tfetch(`${GC_API}${path}?_cb=${Date.now()}`, { headers });
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
  const r = await tfetch(WORKER_API, { headers: { 'Cache-Control': 'no-store' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`worker GET state → ${r.status}`);
  return r.json();
}

async function workerPutState(state) {
  const r = await tfetch(WORKER_API, {
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
  const r = await tfetch(`${WORKER_API}/commentary`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${POLLER_TOKEN}` },
    body: JSON.stringify(lines),
  });
  if (!r.ok) throw new Error(`worker PUT commentary → ${r.status}`);
  return r.json();
}

async function workerGetGcToken() {
  const r = await tfetch(GCTOKEN_API, {
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
    const r = await tfetch(`${ROSTER_BASE}/api/players`);
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

// Reconstruct current baserunners from the play events of the CURRENT half-
// inning (GC has no explicit "runner on Nth" flag — runbook §3). Replay each
// play's final_details (+ mid-AB at_plate_details) in order: batter reaches
// (single→1B, double→2B, etc.), runners advance/remain/score, outs clear them.
// Best-effort: covers hits/walks/HBP/advances/scores/plain outs; exotic plays
// (fielder's choice force-outs, double plays) may be slightly off.
function computeBases(plays, inning, half) {
  const runners = {}; // uuid -> base 1|2|3
  const baseNum = (s) => (s === '1st' ? 1 : s === '2nd' ? 2 : s === '3rd' ? 3 : null);
  const scanEvents = (tmpl, allowBatterReach) => {
    const t = String(tmpl || '');
    let m;
    if (allowBatterReach &&
        (m = t.match(/^\$\{([0-9a-f-]{36})\}\s+(singles|doubles|triples|walks|is hit by pitch|reaches)/i))) {
      const v = m[2].toLowerCase();
      runners[m[1]] = /double/.test(v) ? 2 : /triple/.test(v) ? 3 : 1;
    }
    for (const a of t.matchAll(/\$\{([0-9a-f-]{36})\}\s+(?:advances to|to|remains at|stays at)\s+(1st|2nd|3rd)/gi)) {
      const b = baseNum(a[2]); if (b) runners[a[1]] = b;
    }
    // Stolen bases (mid-AB, "${x} steals 2nd/3rd/home") — different wording than
    // "advances to". "steals home" = scored, so remove the runner.
    for (const a of t.matchAll(/\$\{([0-9a-f-]{36})\}\s+steals\s+(2nd|3rd|home)/gi)) {
      if (/home/i.test(a[2])) delete runners[a[1]];
      else runners[a[1]] = a[2] === '2nd' ? 2 : 3;
    }
    for (const a of t.matchAll(/\$\{([0-9a-f-]{36})\}\s+scores/gi)) delete runners[a[1]];
    for (const a of t.matchAll(/\$\{([0-9a-f-]{36})\}[^.]*?(?:out at (?:1st|2nd|3rd|home)|caught stealing|is out|is put out|doubled off|forced out|picked off)/gi)) {
      delete runners[a[1]];
    }
  };
  for (const p of plays) {
    if (p.inning !== inning || p.half !== half) continue;
    for (const d of (p.final_details || [])) scanEvents(d.template, true);
    for (const d of (p.at_plate_details || [])) scanEvents(d.template, false);
  }
  return {
    first:  Object.values(runners).includes(1),
    second: Object.values(runners).includes(2),
    third:  Object.values(runners).includes(3),
  };
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
  // Outs: the PENDING at-bat's `outs` field is unreliable (often 0). Use the
  // last COMPLETED play in the current half-inning — its `outs` is "outs after
  // that play" = the current out count (3 flips the half, so this stays 0-2).
  let curOuts = 0;
  for (const p of list) {
    if (p.inning === last.inning && p.half === last.half &&
        Array.isArray(p.final_details) && p.final_details.length &&
        Number.isFinite(p.outs)) {
      curOuts = p.outs;
    }
  }

  const out = {
    inning: last.inning ?? null,
    half:   (last.half === 'top' || last.half === 'bottom') ? last.half : null,
    outs:   clampInt(curOuts, 0, 2, 0),
    bases:  computeBases(list, last.inning, last.half),
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
    // Current pitcher — key on the LINEUP (what GC calls a lineup change). Each
    // player's boxscore `player_text` accumulates every position they've held,
    // e.g. "(P, 2B)" for a pitcher who moved to 2nd, "(P)" for whoever is on the
    // mound now. So the current pitcher is the player whose CURRENT (last-listed)
    // position is P — and that updates the instant GC records the change, before
    // any pitch is thrown. Fallbacks: newest boxscore pitching-group entry, then
    // the most recent "${uuid} pitching" play tag.
    const ourBox = boxscore && boxscore[GC_TEAM_ID];
    let pitcherId = null;
    const lineup = ourBox && (ourBox.groups || []).find((g) => g.category === 'lineup');
    if (lineup && Array.isArray(lineup.stats)) {
      for (const s of lineup.stats) {
        const positions = String(s.player_text || '').replace(/[()]/g, '')
          .split(/[,\-]/).map((x) => x.trim().toUpperCase()).filter(Boolean);
        if (positions.length && positions[positions.length - 1] === 'P') { pitcherId = s.player_id; break; }
      }
    }
    if (!pitcherId) {
      const pitching = ourBox && (ourBox.groups || []).find((g) => g.category === 'pitching');
      const pstats = (pitching && Array.isArray(pitching.stats)) ? pitching.stats : [];
      if (pstats.length) pitcherId = pstats[pstats.length - 1].player_id;
    }
    if (!pitcherId) {
      for (let i = list.length - 1; i >= 0 && !pitcherId; i--) {
        for (const d of (list[i].final_details || [])) {
          const m = String((d && d.template) || '').match(/\$\{([0-9a-f-]{36})\}\s+pitching\b/i);
          if (m && byId.has(m[1])) { pitcherId = m[1]; break; }
        }
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

  const r = await tfetch(`${STANDINGS_URL}?_cb=${Date.now()}`, { headers: { 'Cache-Control': 'no-store' } });
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
      bases: (t2 && t2.bases) ? t2.bases : { first: false, second: false, third: false },
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
      // Latency-first: fire the core fetches in PARALLEL (details + our state +
      // Tier-2 plays/boxscore) so a tick is one round-trip, not five sequential
      // ones. Token read is local (instant), so include Tier-2 up front.
      let { rec, status: tokenStatus } = await ensureGcToken();
      const _tf0 = Date.now();
      const [detR, curR, playsR, boxR] = await Promise.allSettled([
        gcFetchJSON(`${GC_PUBLIC}/game-stream-processing/${game.id}/details`, { retryOnEmpty: true }),
        workerGetState(),
        rec ? gcAuthedJSON(`/game-stream-processing/${game.id}/plays`, rec) : Promise.resolve(null),
        rec ? gcAuthedJSON(`/game-stream-processing/${game.id}/boxscore`, rec) : Promise.resolve(null),
      ]);
      const _tfetch = Date.now() - _tf0;

      const det = detR.status === 'fulfilled' ? detR.value : null;
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
      // Drive the scorebug for 'live' AND 'new' — GC sits a scored game in
      // "new" through lineup setup / warmups (and sometimes well into it)
      // before flipping to "live", so waiting for "live" leaves the broadcast
      // blank with the matchup + starting pitcher already set. Only genuinely
      // pre-setup statuses (scheduled/postponed/etc.) stay in pre-game watch.
      if (!game.forced && status !== 'live' && status !== 'new') {
        await sleep(PREGAME_POLL_MS);
        continue;
      }

      // manual override — manual always wins
      const current = curR.status === 'fulfilled' ? curR.value : undefined;
      if (current && current.mode === 'manual') {
        if (!manualLogged) { log('state.mode = manual — yielding until AUTO'); manualLogged = true; }
        await sleep(LIVE_POLL_MS);
        continue;
      }
      if (manualLogged) { log('state.mode back to auto — resuming'); manualLogged = false; }

      // Tier 2 — count + featured card + inning/half/outs/bases (from the
      // already-fetched plays/boxscore). This is the whole scorebug when a
      // token is present, so Tier-1 below is only the tokenless fallback.
      let t2 = null;
      if (rec) {
        const playsErr = playsR.status === 'rejected' ? playsR.reason : null;
        const boxErr   = boxR.status === 'rejected'   ? boxR.reason   : null;
        if (!playsErr && !boxErr && playsR.value) {
          const roster = await getRoster();
          t2 = computeTier2(playsR.value, boxR.value, roster, det.home_away === 'away' ? 'away' : 'home');
          if (t2) lastT2 = { data: t2, at: Date.now() };
          try { await updateCommentary(playsR.value); } catch (_) { /* non-fatal */ }
        } else {
          const err = playsErr || boxErr;
          if (err && err.unauthorized) {
            tokenStatus = 'expired';
            tokenState.deadSavedAt = rec.saved_at || 'unknown';
            lastT2 = null;
            log('gc-token rejected — Tier-1 degrade:', err.message);
          } else {
            if (lastT2 && Date.now() - lastT2.at < 45 * 1000) t2 = lastT2.data;
            log('Tier-2 fetch failed (transient):', err && err.message);
          }
        }
      }

      // Tier 1 — ONLY when Tier-2 is unavailable (no/expired token). Skipped on
      // the normal path, which removes 2-3 sequential fetches per tick.
      const t1 = { inning: null, half: null, outs: null };
      if (!t2) {
        if (!game.event_id && Date.now() - eventIdTriedAt > 5 * 60 * 1000) {
          eventIdTriedAt = Date.now();
          const events = await gcFetchJSON(`${GC_PUBLIC}/organizations/${GC_ORG_ID}/events`, { retryOnEmpty: true });
          if (Array.isArray(events)) {
            game.event_id = matchEventId(events, game);
            log(game.event_id ? `resolved event_id ${game.event_id}` : 'event_id unresolved (retry in 5 min)');
          }
        }
        if (game.event_id) {
          const ev = await fetchOrgEventLive(game.event_id);
          if (ev) Object.assign(t1, ev);
        }
        if (t1.inning == null) t1.inning = await fetchLinescoreInning(game.id);
      }

      // write
      const written = await buildAndWrite(game, det, t1, t2, tokenStatus, current);
      log(`wrote: ${written.score.away_name} ${written.score.away_runs} @ ${written.score.home_name} ${written.score.home_runs}` +
          ` · ${written.game.half} ${written.game.inning}, ${written.game.outs} out` +
          (written.game.balls != null ? ` · count ${written.game.balls}-${written.game.strikes}` : ' · count hidden') +
          (written.featured_player ? ` · card ${written.featured_player.mode} #${written.featured_player.number}` : '') +
          ` · token ${tokenStatus} · fetch ${_tfetch}ms tick ${Date.now() - tickStart}ms`);
    } catch (e) {
      log('tick error (preserving last state):', e.message);
    }
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(400, sleepMs - elapsed));
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

  // Baserunners: HBP → 1st, single → 1st, then a steal to 2nd, plus a balk
  // advance (GC emits it as "advances to"). Uses realistic GC wording.
  const R1 = '11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const R2 = '22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const basePlays = [
    { inning: 5, half: 'bottom', final_details: [{ template: `\${${R1}} is hit by pitch, \${x} pitching` }], at_plate_details: [] },
    { inning: 5, half: 'bottom', final_details: [{ template: `\${${R2}} singles on a ground ball to left fielder \${y}` }, { template: `\${${R1}} advances to 2nd` }], at_plate_details: [] },
    { inning: 5, half: 'bottom', name_template: { template: '${z} at bat' }, final_details: [], at_plate_details: [{ template: `\${${R2}} steals 2nd` }, { template: `\${${R1}} steals 3rd` }] },
  ];
  const bs = computeBases(basePlays, 5, 'bottom');
  assert.strictEqual(bs.third, true, 'R1 hbp→2nd then stole 3rd');
  assert.strictEqual(bs.second, true, 'R2 single→1st then stole 2nd');
  assert.strictEqual(bs.first, false, 'nobody left on 1st');

  console.log('selftest OK');
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  main().catch((e) => { console.error('fatal:', e); process.exit(1); });
}
