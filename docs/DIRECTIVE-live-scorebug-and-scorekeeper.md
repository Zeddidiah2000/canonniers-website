> **⚠️ HISTORICAL / SUPERSEDED — DO NOT IMPLEMENT FROM THIS FILE**
>
> This 3-phase directive (live + silent timeline capture + replay overlay)
> was the original plan. Jay superseded it on **2026-05-25** in favor of a
> stripped-down v1 because **golightstream.com burns the scorebug INTO the
> broadcast video** — there is nothing to reconstruct on replay, so the
> D1/R2 timeline machinery, game-id tracking, Spordle picker, and replay
> overlay are all unnecessary.
>
> **What actually shipped (2026-05-27, signed off as "shipped and closed"):**
> KV-only worker + transparent `/scorebug.html` for golightstream + phone
> `/admin-scorekeeper.html` with Spordle opponent autocomplete, home/away
> role toggle, full baseball logic (walk/K/HR), and live overlay size scaling.
> Source of truth is the memory entry `project_scorebug_system.md`.
>
> Keeping this file as a historical record of the design decisions and
> the architecture that was considered but not built.

---

# DIRECTIVE — Canonniers Live Scorebug + Replay Broadcast System (v1, 3 phases)

**Scope evolution note:** This directive supersedes an earlier "live-only" scope. After reviewing the live-only design, Jay opted for the full broadcast experience up front (live + replay animated overlay) to avoid rebuilding later. The cost is roughly 3× the original directive; the upside is a single coherent system that gives viewers a broadcast-grade experience on both live games AND replays.

---

## End state

A complete Canonniers broadcast graphics system:

1. **Live broadcast**: scorekeeper pushes state from phone at the ballpark; public viewers see semi-transparent scorebug + featured player card composited over the live Cloudflare Stream iframe on `diffusion.html`.
2. **Silent timeline capture**: every state change during a live game is logged with a wall-clock timestamp to D1.
3. **Replay broadcast**: when a viewer clicks a replay tile on `diffusion.html`, the same overlay re-animates over the recorded video — scrubbing, pausing, and rewinding all work. Featured player cards come in and out at the moments they were originally pushed.

Three teams (15U, 17U D1, 17U D2) supported from day one. Three admin pages (siblings). Single new worker (`canonniers-live-scorebug-worker`) wires everything together.

---

## Decisions confirmed (Jay, 2026-05-24)

| # | Decision | Confirmed |
|---|---|---|
| 1 | Game identity | **Spordle dropdown picker** for scheduled games + **"+ Manual game" option** for tests and tournament games not in Spordle |
| 2 | Timeline storage | **D1 for writes during games + R2 JSON snapshot on END GAME** — fast writes live, fast reads for replay viewers |
| 3 | Featured player on replays | **Animated through the timeline** — same flow as live, free since data is already captured |
| 4 | Deployment | **3 phases**: Live → Timeline+Archive (silent) → Public replay overlay |
| 5 | Team scope | **All 3 teams from day one** (parametric cost already paid) |
| Extra | Admin gate | **Strict allowlist `jay@canonniers.ca` only** for v1; widen later via auth-worker role lookup |

---

## Architecture overview

```
┌──────────────────┐    PUT       ┌────────────────────────────────┐
│ admin-scorekeeper│───────────►  │  canonniers-live-scorebug-      │
│ .html (phone)    │   (JWT)      │  worker                         │
└──────────────────┘              │                                 │
                                  │   ┌─ KV: current:{team}         │
                                  │   │     (live state, 2s poll)   │
                                  │   ├─ D1: scorebug_events        │
                                  │   │     (timeline, every PUT)   │
                                  │   ├─ D1: scorebug_games         │
                                  │   │     (game registry +        │
                                  │   │      final snapshot)        │
                                  │   └─ R2: timelines/{id}.json    │
                                  │         (written on END GAME)   │
                                  └─────────┬───────────────────────┘
                                            │ GET (public, no auth)
                                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  diffusion.html                                                    │
│   ┌─ live: polls /api/scorebug/:team every 2s                      │
│   │   → renders scorebug + featured card over live iframe          │
│   └─ replay: clicks a replay tile                                  │
│       → fetches /api/scorebug/games/{id}/timeline                  │
│       → subscribes to CF Stream Player API timeupdate              │
│       → binary-searches timeline, renders state at each moment     │
└────────────────────────────────────────────────────────────────────┘
```

Three deployment phases:
- **Phase 1**: Live scorekeeping only. KV-backed, no timeline writes, no replay overlay. Risk profile = "does the phone UX work at a real game?"
- **Phase 2**: Add timeline writes on every PUT + END GAME archive to D1+R2. Silent — no UI change. Risk profile = "is the data being captured correctly?"
- **Phase 3**: Wire public replay overlay into diffusion.html replay click handler. Risk profile = "does video-time sync work?"

Each phase is independently deployable and reversible.

---

## Pre-flight reality (verified — do not re-test, just use)

### Roster endpoint
- **Endpoint:** `GET https://canonniers-roster-worker.chisholm2000.workers.dev/api/players` — public, no auth, returns all players.
- Filter client-side by `team_category` (`u15` / `u17d1` / `u17d2`).
- **15U photo coverage:** 14/14 players have `photo_url`.
- **stats_json shape:** versioned by year since 2026-05-24 (commit `0bb6ecc`). See memory `project_stats_json_schema.md`. Adapter must pick latest year.
- **Suggested first live-test player:** #39 Aïzak Biasone — has full 2026 batting + pitching after the 2026-05-24 injection.

### Roster data shape gotchas (apply to `rosterToFeaturedPlayer` adapter)

| Brief assumed | Roster returns | Adapter does |
|---|---|---|
| `photo_url` absolute | Relative path `/api/photos/player_12.jpg` | Prepend `https://canonniers-roster-worker.chisholm2000.workers.dev` if missing `http` |
| `first_name` + `last_name` | `name: "Alexis Parent"` single string | Split on last space → `{first, last}` |
| `bats` + `throws` | `bats_throws: "R/R"` single string | Split on `/` |
| Flat `{batting, pitching}` stats | Versioned: `{"2025":{...}, "2026":{...}}` | Pick latest year via `Object.keys().filter(/^\d{4}$/).sort().reverse()[0]`, then pick batting or pitching block by mode, map pitching `K → SO` |

### Auth pattern
- The cards-worker pattern is **direct JWKS verification**, NOT a service binding to auth-worker. Clone `canonniers-cards-worker/src/auth.ts` `verifyAccessJwt()` verbatim. After verify, check `payload.email === 'jay@canonniers.ca'`. (See memory `project_auth_worker_oracle.md`.)

### CF Access scope
- `AuthCanonniers` covers `canonniersdequebec.ca/admin*` per `cards-worker/src/auth.ts:6`. Verify rule is `/admin*` glob (not `/admin/*` with slash) before deploy; otherwise the new admin pages slip through.

### diffusion.html DOM
- Overlay target is `.player-stage` with id `#stage-u15` / `#stage-u17d1` / `#stage-u17d2`. (NOT `.player-stage-wrap` — that's a hallucination from the design brief.)

### Replays system contract (already shipped, do not touch)
- `GET https://canonniers-replays-worker.chisholm2000.workers.dev/api/replays/{team}` returns `[{id, videoUid, date, opponent, opponentLogo, isHome, gameId, duration, score}]`.
- `gameId` is the **Spordle game id** for the replay's matching game (joined via results-worker + Spordle).
- **The replay overlay queries our scorebug system using `spordle:${r.gameId}` as the game_id key.** Manual games will not link to replay videos (out of scope for v1 — see "Out of scope" section).

### CF Stream Player API
- Embedded CF Stream iframes expose a postMessage-based Player SDK at `https://embed.cloudflarestream.com/embed/sdk.latest.js`.
- Subscribe via `Stream(iframe).addEventListener('timeupdate', cb)` — fires every ~200ms with `currentTime`.
- **Pre-flight verification (do this BEFORE Phase 3 code):** load a known replay in `diffusion.html`, attach the SDK, log `currentTime` from the console. If postMessage is blocked by some embed setting, Phase 3 collapses and we fall back to Option 2 (pinned final state, no animation). Discover early.

### Wrangler binary
- Only available at `repo-working\workers\canonniers-cards-worker\node_modules\.bin\wrangler.cmd`. Reuse for all worker deploys.

### Node SSL
- All scripts run with `NODE_OPTIONS=--use-system-ca` per memory `reference_git_ssl_schannel.md`.

---

## Data model (full)

### State contract (PUT/GET shape — same as before, plus `game_id`)

```json
{
  "game_id": "spordle:12345" | "manual:u15:20260524-190000",
  "visible": true,
  "score": {
    "home_name": "CANONNIERS",
    "away_name": "TITANS",
    "away_logo_url": null,
    "home_runs": 3,
    "away_runs": 1
  },
  "game": {
    "inning": 4,
    "half": "top",
    "balls": 2,
    "strikes": 1,
    "outs": 1,
    "bases": { "first": true, "second": false, "third": false }
  },
  "featured_player": null | {
    "number": 39,
    "mode": "batter",
    "first_name": "Aïzak",
    "last_name": "Biasone",
    "position": "P,SS",
    "bats": "R",
    "throws": "R",
    "photo_url": "https://...",
    "stats": { "AVG": ".333", "OPS": ".900", "HR": 0, "RBI": 1, "SB": null,
               "ERA": null, "IP": null, "K": null, "WHIP": null }
  },
  "updated_at": "2026-05-24T23:14:09.123Z",
  "version": 1
}
```

- `game_id` is **required** for PUT. Worker rejects PUTs without it.
- `game_id` formats:
  - `spordle:{numeric_spordle_id}` — for scheduled league games picked from Spordle dropdown
  - `manual:{team}:{YYYYMMDD-HHMMSS}` — for manual / tournament / test games (timestamp at "Start Game" tap)
- `updated_at` and `version` are server-set on every PUT.

### D1 schema (new tables in `canonniers-db`)

```sql
CREATE TABLE scorebug_games (
  id TEXT PRIMARY KEY,              -- game_id
  team_category TEXT NOT NULL,      -- 'u15' | 'u17d1' | 'u17d2'
  source TEXT NOT NULL,             -- 'spordle' | 'manual'
  spordle_game_id TEXT,             -- populated when source='spordle'
  home_name TEXT,
  away_name TEXT,
  started_at INTEGER NOT NULL,      -- unix ms wall-clock at Start Game tap
  ended_at INTEGER,                 -- unix ms, null while live
  final_state_json TEXT,            -- last state at END GAME (for fast reads)
  r2_timeline_key TEXT,             -- 'timelines/{game_id}.json', null while live
  notes TEXT                        -- manual game notes (optional)
);
CREATE INDEX idx_scorebug_games_team_started ON scorebug_games(team_category, started_at DESC);
CREATE INDEX idx_scorebug_games_spordle ON scorebug_games(spordle_game_id) WHERE spordle_game_id IS NOT NULL;

CREATE TABLE scorebug_events (
  game_id TEXT NOT NULL,
  t_ms INTEGER NOT NULL,            -- unix ms wall-clock at this PUT
  state_json TEXT NOT NULL,         -- full state at this moment
  PRIMARY KEY (game_id, t_ms)
);
CREATE INDEX idx_scorebug_events_game ON scorebug_events(game_id, t_ms);
```

### KV namespace (`SCOREBUG`)
- `current:u15` / `current:u17d1` / `current:u17d2` — live state for the active game on each team. Deleted on END GAME.

### R2 (`canonniers-scorebug-timelines` bucket)
- `timelines/{game_id}.json` — full event timeline written once on END GAME. Format: `[{t_ms, state}, ...]` sorted ascending by `t_ms`. Public-read (no auth — timelines are public game data).

### Estimated storage
- D1 events: ~120-240 per 2hr game · ~60 games/season · 3 teams = ~50k rows/season. Trivial.
- R2 timelines: ~50 KB per game · 180 games/season = ~9 MB/season. Negligible cost.

---

## Worker — `canonniers-live-scorebug-worker`

### Folder layout
```
repo-working/workers/canonniers-live-scorebug-worker/
├── wrangler.toml
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts            (route dispatcher)
    ├── auth.ts             (JWKS verify — verbatim from cards-worker)
    ├── validate.ts         (PUT payload validation)
    ├── games.ts            (game registry: start, list, lookup)
    ├── timeline.ts         (event append, R2 archive on END GAME)
    ├── spordle.ts          (Spordle proxy for today's games)
    └── types.ts            (State, GameRow, Env)
```

### Routes (complete API across all 3 phases)

| Method | Path | Auth | Phase | Behavior |
|---|---|---|---|---|
| `OPTIONS /api/scorebug/*` | None | 1 | CORS preflight |
| `GET /api/scorebug/:team` | None | 1 | Live state from KV. 404 if absent. 4h stale guard. |
| `PUT /api/scorebug/:team` | JWT + allowlist | 1 → 2 | Phase 1: KV write only. Phase 2: ALSO D1 insert into `scorebug_events`. |
| `DELETE /api/scorebug/:team` | JWT + allowlist | 1 → 2 | Phase 1: delete KV key only. Phase 2: archive to D1.scorebug_games + R2 timeline blob, THEN delete KV. |
| `GET /api/scorebug/games?team=u15&date=2026-05-24` | None | 1 | List today's Spordle games for picker + recent manual games (last 7 days) for the team. Returns `[{game_id, source, home_name, away_name, start_time, venue, already_started}]`. |
| `POST /api/scorebug/games/start` | JWT + allowlist | 1 | Register a game start. Body: `{team, source: 'spordle'|'manual', spordle_game_id?, home_name?, away_name?, notes?}`. Generates `game_id`, inserts into D1.scorebug_games, returns it. Manual `game_id = "manual:{team}:{YYYYMMDD-HHMMSS}"`. |
| `GET /api/scorebug/games/recent?team=u15&limit=20` | None | 2 | List recent ended games for the team (for admin "load past game" + future browse UI). |
| `GET /api/scorebug/games/{game_id}/final` | None | 2 | Final state JSON. 404 if game not ended. Cache 1h. |
| `GET /api/scorebug/games/{game_id}/timeline` | None | 3 | Timeline events as JSON array. If `r2_timeline_key` set, 302 redirect to R2 URL (cached at CDN). Else inline from D1 (for live games). |

### Validation (PUT)
- Body limit 4KB.
- Reject unknown top-level keys; only `game_id | visible | score | game | featured_player`.
- `game_id` required, must match `^(spordle:\d+|manual:u15:\d{8}-\d{6}|manual:u17d1:\d{8}-\d{6}|manual:u17d2:\d{8}-\d{6})$`.
- All other field rules as in the original directive.
- **Server overrides:** `updated_at` (ISO) and `version: 1` on every write.

### END GAME behavior
1. Verify JWT + email allowlist.
2. Read current KV state to get `game_id`.
3. (Phase 2 only) D1: `UPDATE scorebug_games SET ended_at = ?, final_state_json = ? WHERE id = ?`.
4. (Phase 2 only) D1: `SELECT t_ms, state_json FROM scorebug_events WHERE game_id = ? ORDER BY t_ms`.
5. (Phase 2 only) R2: `PUT timelines/{game_id}.json` with `[{t_ms, state}, ...]`.
6. (Phase 2 only) D1: `UPDATE scorebug_games SET r2_timeline_key = ? WHERE id = ?`.
7. Delete KV `current:{team}`.
8. Return `{ok: true, archived: true, game_id, timeline_url?}`.

### Spordle proxy for games list
Re-use `spordle-proxy.chisholm2000.workers.dev` for today's games via service binding. Filter by team's Spordle team ID:
- 15U AAA = `156779`, 17U D1 = `156780`, 17U D2 = `156781` (from `CLAUDE.md`).

### wrangler.toml
```toml
name = "canonniers-live-scorebug-worker"
main = "src/index.ts"
compatibility_date = "2026-05-01"

[[kv_namespaces]]
binding = "SCOREBUG"
id = "<from wrangler kv:namespace create>"

[[d1_databases]]
binding = "DB"
database_name = "canonniers-db"
database_id = "<paste from existing roster-worker wrangler config>"

[[r2_buckets]]
binding = "TIMELINES"
bucket_name = "canonniers-scorebug-timelines"

[[services]]
binding = "SPORDLE"
service = "spordle-proxy"

[vars]
CF_ACCESS_AUD = "<paste from cards-worker>"
CF_ACCESS_TEAM_DOMAIN = "<paste from cards-worker>"
```

### Auth gate
```ts
const identity = await verifyAccessJwt(request, env);
if (identity.email !== 'jay@canonniers.ca') {
  return json({ error: 'forbidden' }, 403);
}
```

---

## Admin pages

### Three sibling files
- `admin-scorekeeper.html` (15U canonical)
- `admin-scorekeeper-17u-d1.html` (copy with `TEAM='u17d1'`)
- `admin-scorekeeper-17u-d2.html` (copy with `TEAM='u17d2'`)

Each file embeds: `const TEAM = 'u15';` (or `u17d1`/`u17d2`).

### New: "Start Game" modal (Phase 1)

When admin loads and there's no active game (KV `current:{TEAM}` returns 404), show a full-screen modal:

```
┌────────────────────────────────────────────┐
│  DÉMARRER UNE PARTIE                       │
│  Start a game                              │
├────────────────────────────────────────────┤
│  PARTIES PROGRAMMÉES AUJOURD'HUI           │
│  Scheduled games today                     │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ 19:00 · vs Titans de Trois-Rivières  │  │
│  │ Stade Canac           [ DÉMARRER ]   │  │
│  └──────────────────────────────────────┘  │
│  ┌──────────────────────────────────────┐  │
│  │ 14:00 · @ Aigles de Lévis            │  │
│  │ Parc Pierre-Bertrand  [ DÉMARRER ]   │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ──────────────── OU ────────────────      │
│                                            │
│  [ + PARTIE MANUELLE / + MANUAL GAME ]     │
└────────────────────────────────────────────┘
```

Manual game modal:
```
┌────────────────────────────────────────────┐
│  PARTIE MANUELLE                           │
│  Manual game                               │
├────────────────────────────────────────────┤
│  Adversaire / Opponent                     │
│  [ ___________________________________ ]   │
│                                            │
│  Côté / Side                               │
│  ( ) Domicile / Home                       │
│  ( ) Visiteur / Away                       │
│                                            │
│  Notes (optionnel)                         │
│  [ ___________________________________ ]   │
│                                            │
│  [ ANNULER ]            [ DÉMARRER ]       │
└────────────────────────────────────────────┘
```

On start (either path):
1. POST `/api/scorebug/games/start` with the relevant body.
2. Receive `game_id`.
3. Store in `localStorage.canonniers_scorekeeper_active_game_{TEAM}`.
4. Initialize local state with default scoreboard + `game_id`.
5. First PUT establishes `current:{TEAM}` in KV.

### On reopen (game already active)
If KV `current:{TEAM}` exists with `visible: true`, the admin loads INTO that game directly — no start-game modal. localStorage `active_game` is restored from the KV state's `game_id`. Scorekeeper picks up exactly where they left off.

### END GAME button
Same UI as original directive. Triggers `DELETE /api/scorebug/:team`. Worker handles archive transparently (Phase 2). Admin then re-shows the Start Game modal.

### Drop-in source
- Lift `design_handoff_scorebug_player_cards/admin-scorekeeper.html` as the visual starting point for `admin-scorekeeper.html`.
- Modifications:
  1. Add the Start Game modal + manual game sub-modal (new).
  2. Add game-id awareness to all state mutations (every change increments local state, every PUT includes current `game_id`).
  3. Remove the stubbed `ROSTER` constant — replace with the roster fetch + adapter (versioned-schema-aware).
  4. Replace the 5s on/off pill with **5-chip latency selector** `[INSTANT] [3s] [5s] [7s] [9s]` (persists to `localStorage.canonniers_scorekeeper_push_delay_ms`).
  5. Wire `// TODO: wire to worker PUT` markers to real fetch with `Cf-Access-Jwt-Assertion` header.
  6. Add **Batter/Pitcher segmented toggle** at top of CARTES tab.
  7. Remove any `sessionStorage.admin_auth` / `canonniers2026` password gate. CF Access is the gate.

### Roster adapter (versioned-schema-aware)
```js
function rosterToFeaturedPlayer(p, mode) {
  let photo_url = p.photo_url || null;
  if (photo_url && !photo_url.startsWith('http')) {
    photo_url = ROSTER_BASE + photo_url;
  }

  const name = (p.name || '').trim();
  const lastSpace = name.lastIndexOf(' ');
  const first_name = lastSpace > 0 ? name.slice(0, lastSpace) : name;
  const last_name  = lastSpace > 0 ? name.slice(lastSpace + 1) : '';

  const [bats = '', throws = ''] = (p.bats_throws || '').split('/').map(s => s.trim());

  let stats = { AVG: null, OPS: null, HR: null, RBI: null, SB: null,
                ERA: null, IP: null, K: null, WHIP: null };
  try {
    const root = p.stats_json ? JSON.parse(p.stats_json) : null;
    const years = root ? Object.keys(root).filter(k => /^\d{4}$/.test(k)).sort().reverse() : [];
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
  } catch (e) { /* leave all-null */ }

  return {
    number: Number(p.number) || 0,
    mode,
    first_name, last_name,
    position: p.position || '',
    bats, throws,
    photo_url,
    stats
  };
}
```

### Network integration
```js
const WORKER_BASE = 'https://canonniers-live-scorebug-worker.chisholm2000.workers.dev';

function getCFJwt() {
  const m = document.cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

async function fetchTodaysGames() {
  const today = new Date().toISOString().slice(0,10);
  const r = await fetch(`${WORKER_BASE}/api/scorebug/games?team=${TEAM}&date=${today}`);
  return r.ok ? r.json() : [];
}

async function startGame(body) {
  const jwt = getCFJwt();
  if (!jwt) { window.location.href = '/cdn-cgi/access/login/canonniersdequebec.ca?redirect_url=' + encodeURIComponent(window.location.pathname); return null; }
  const r = await fetch(`${WORKER_BASE}/api/scorebug/games/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt },
    body: JSON.stringify({ team: TEAM, ...body })
  });
  return r.ok ? r.json() : null;
}

async function pushToWorker(state) {
  const jwt = getCFJwt();
  if (!jwt) { /* login redirect */ return false; }
  if (!state.game_id) { console.error('Push without game_id — rejecting'); return false; }
  try {
    const r = await fetch(`${WORKER_BASE}/api/scorebug/${TEAM}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt },
      body: JSON.stringify(state)
    });
    return r.ok;
  } catch (e) { return false; }
}

async function endGame() {
  const jwt = getCFJwt();
  if (!jwt) return;
  await fetch(`${WORKER_BASE}/api/scorebug/${TEAM}`, {
    method: 'DELETE',
    headers: { 'Cf-Access-Jwt-Assertion': jwt }
  });
  localStorage.removeItem(`canonniers_scorekeeper_active_game_${TEAM}`);
  resetLocalStateAndShowStartGameModal();
}
```

### Admin tile
Add three tiles to `admin.html`, all role-gated to `admin`:
- 🥎 **POINTAGE 15U / SCOREKEEPER 15U**
- 🥎 **POINTAGE 17U D1 / SCOREKEEPER 17U D1**
- 🥎 **POINTAGE 17U D2 / SCOREKEEPER 17U D2**

Add to `robots.txt`:
```
Disallow: /admin-scorekeeper.html
Disallow: /admin-scorekeeper-17u-d1.html
Disallow: /admin-scorekeeper-17u-d2.html
```

---

## diffusion.html integration

### Phase 1: Live overlay (matching original directive)
Lift `.live-overlay` CSS + markup + `renderOverlay()` function from `design_handoff_scorebug_player_cards/diffusion-overlay.html` into all three `#stage-u15` / `#stage-u17d1` / `#stage-u17d2` panels. Poll `/api/scorebug/{team}` every 2s; pause on hidden tab and inactive panel; hide on `fullscreenchange`. Use CSS `order` to flip batting team (avoids the screen-reader re-announcement issue from DOM reorder).

### Phase 3: Replay overlay (new)

When a replay tile is clicked, the page currently swaps the iframe to load a specific replay video. Extend that click handler:

```js
async function loadReplay(team, replay) {
  // 1. Swap iframe to the replay video (existing behavior).
  const iframe = panel.querySelector('.cf-iframe');
  iframe.src = `https://iframe.videodelivery.net/${replay.videoUid}?...`;

  // 2. NEW: load timeline for this game (if it has one).
  if (!replay.gameId) return;  // no Spordle match → no timeline

  const game_id = `spordle:${replay.gameId}`;
  let timeline;
  try {
    const r = await fetch(`${SCOREBUG_BASE}/api/scorebug/games/${encodeURIComponent(game_id)}/timeline`);
    if (r.ok) timeline = await r.json();
  } catch (e) { return; }

  if (!timeline || !timeline.length) return;  // game wasn't scorekept

  // 3. Compute wall-clock origin for this video.
  // CF Stream's `created` is the recording start time (UTC, ms).
  const videoCreatedMs = new Date(replay.created || replay.date).getTime();

  // 4. Subscribe to CF Stream Player API.
  const player = Stream(iframe);  // loaded via embed/sdk.latest.js
  player.addEventListener('timeupdate', () => {
    const wallclock = videoCreatedMs + (player.currentTime * 1000);
    const event = binarySearchTimeline(timeline, wallclock);
    if (event) renderOverlay(event.state, panel.querySelector('.live-overlay'));
  });

  // 5. Also handle seek (timeupdate fires on seek too — same logic).
}

function binarySearchTimeline(events, t_ms) {
  // Largest event.t_ms <= t_ms. Returns undefined if t_ms < first event (overlay stays hidden).
  let lo = 0, hi = events.length - 1, result;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t_ms <= t_ms) { result = events[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}
```

Add to diffusion.html `<head>`:
```html
<script src="https://embed.cloudflarestream.com/embed/sdk.latest.js"></script>
```

### Mevo segment handling
A single game can be 3-7 separate replay videos (per memory `project_replays_system.md`). Each video has its own `created` timestamp from CF Stream. The timeline is **one continuous wall-clock log** spanning the entire game. Each replay video computes its own origin (`videoCreatedMs`); the binary search returns the right event for that segment. No special segment-stitching code needed — just use the right `created` per loaded replay.

### When user switches between replays of the same game
Click a different replay tile → `loadReplay()` called again → new `videoCreatedMs` computed → same timeline (cached) → overlay re-syncs. Works for free.

### Live overlay vs replay overlay state
- Live overlay element: `.live-overlay[data-overlay-team="u15"]` in the panel
- Replay overlay: SAME element. When a replay loads, we stop the live polling for that panel (cancel the interval), and start the replay subscription. When viewer clicks "back to live" (or closes the replay), we restart the polling.

### Live + replay handoff state machine
Each team panel has one of three states:
- `live` — polling /api/scorebug/{team} every 2s, rendering live state
- `replay` — subscribed to Stream Player timeupdate, rendering from timeline
- `idle` — overlay hidden (no live game, no replay loaded)

Transitions:
- Page load → live (poll starts; if 404, overlay hidden)
- Replay tile clicked → live polling cancelled → replay loaded → replay state
- "Retour à la diffusion en direct / Back to live" button (in replay panel) → replay cancelled → live polling restarts

---

## Build order

Five phases of work, mapping to three deployment phases.

### Build Phase 1 — Worker scaffolding + live KV state
1. Scaffold `repo-working/workers/canonniers-live-scorebug-worker/`. Copy `cards-worker` structure, strip what isn't needed.
2. Clone `src/auth.ts` verbatim from cards-worker; swap role-gate for `jay@canonniers.ca` allowlist.
3. Write `src/validate.ts` with all validation rules.
4. Write `src/index.ts` route dispatcher with only KV-backed live endpoints (no D1/R2 yet — those land in Build Phase 3).
5. `wrangler kv:namespace create SCOREBUG` → paste id into wrangler.toml.
6. Deploy. Smoke: GET 404, PUT no-JWT 401, PUT bad-payload 400.

### Build Phase 2 — Games endpoints + Spordle proxy + D1 games table
1. `wrangler d1 execute canonniers-db --command "CREATE TABLE scorebug_games ..."` (and the index).
2. Service binding to spordle-proxy in wrangler.toml.
3. Write `src/games.ts`: `listTodaysGames()` (Spordle proxy + recent manual), `startGame()` (D1 insert).
4. Add routes `GET /api/scorebug/games`, `POST /api/scorebug/games/start`.
5. Deploy. Smoke: list returns today's u15 games; manual start returns a game_id.

### Build Phase 3 — Timeline writes + R2 archive + games/timeline endpoint
1. `wrangler d1 execute canonniers-db --command "CREATE TABLE scorebug_events ..."`.
2. `wrangler r2 bucket create canonniers-scorebug-timelines`.
3. R2 binding in wrangler.toml.
4. Write `src/timeline.ts`: append-on-PUT, archive-on-END-GAME.
5. Modify `PUT` handler to insert into `scorebug_events` (via `ctx.waitUntil` after response to avoid latency hit).
6. Modify `DELETE` handler to do full archive flow before deleting KV.
7. Add route `GET /api/scorebug/games/{id}/timeline` (returns D1 events for live games, R2 redirect for finished).
8. Deploy. Smoke: live PUT writes a D1 row; END GAME writes R2 blob; timeline endpoint returns events.

### Build Phase 4 — Admin pages (all 3 siblings)
1. Build `admin-scorekeeper.html` (15U canonical). All UX from original directive + Start Game modal + manual game sub-modal + game_id in state.
2. Duplicate to `admin-scorekeeper-17u-d1.html` / `-17u-d2.html` with TEAM constant swap.
3. Add 3 tiles to `admin.html`, 3 entries to `robots.txt`.
4. Smoke each: open via canonniersdequebec.ca → CF Access → Start Game modal → pick Spordle game OR enter manual → tap +1 → status pill green → END GAME → modal returns.

### Build Phase 5 — diffusion.html overlay integration (live + replay)
1. Inject `.live-overlay` CSS + markup into all 3 panels.
2. Wire live polling (paused on hidden tab + inactive panel + replay active).
3. Add CF Stream Player SDK script tag.
4. Extend replay tile click handler with `loadReplay()` per spec.
5. Add "Retour à la diffusion en direct" button for live↔replay handoff.
6. Smoke: live game shows scorebug; click a finished replay → scorebug animates through the game.

---

## Deploy phase mapping

| Deploy Phase | Includes (Build Phases) | Test before next |
|---|---|---|
| **Deploy 1 — Live only** | Build Phase 1 + Phase 4 (admin) + Phase 5 live-only path | Real game smoke test. Confirms scorekeeper UX, worker auth, live overlay timing. |
| **Deploy 2 — Silent timeline capture** | Build Phase 2 + Phase 3 (D1/R2 writes, no public replay UI) | Inspect a real game's D1 events + R2 blob. Confirm timeline matches the actual broadcast. |
| **Deploy 3 — Public replay overlay** | Build Phase 5 replay path | Load a finished game's replay on diffusion.html; verify scorebug animates correctly with video. |

Each deploy phase = one git commit + push. Worker re-deploys are additive (Phase 2 doesn't break Phase 1's API; Phase 3 doesn't break Phase 2).

---

## Rollback per deploy phase

| Failure | Recovery |
|---|---|
| Deploy 1 worker bug | `wrangler rollback --name canonniers-live-scorebug-worker` |
| Deploy 1 admin page bug | `git revert <commit>`; CF Access still gates page even if HTML is broken |
| Deploy 1 stuck KV state | `wrangler kv:key delete --binding=SCOREBUG "current:u15"` |
| Deploy 2 D1 corruption | `wrangler d1 execute canonniers-db --command "DROP TABLE scorebug_events"` (data loss for in-flight games is acceptable); re-create from schema |
| Deploy 2 R2 missing | Worker continues serving timeline from D1 events as fallback |
| Deploy 3 replay overlay misaligned | Comment out the `loadReplay()` timeline subscription block; live overlay still works |
| CF Stream Player SDK incompatible | Fall back to **Option 2** (pinned final state on replay) — change `loadReplay()` to fetch `final_state_json` once and render statically; no `timeupdate` subscription |

---

## Out of scope for v1 (capture in backlog)

- **Tournament replay auto-link.** Manual games create timelines but won't auto-attach to a CF Stream replay (the replays-worker joins via Spordle gameId only). For tournament replays, admins would need a "link this replay to game_id X" step. Deferred.
- **Multi-scorekeeper conflict resolution.** KV is last-write-wins; admin has 50-step undo. One scorekeeper per game at a time.
- **Calibration UI for video-time vs wall-clock drift.** If we discover the CF Stream `created` field is consistently off by N seconds, we'd add a per-game offset. For v1, accept whatever drift the platform gives us.
- **Animated "moments" (HR, K, etc.) overlay on replays.** The data is in the timeline (state transitions), but rendering motion graphics on top is a separate design pass.
- **Opponent logo upload.** Brief mentioned R2-stored logos; for v1 the `away_logo_url` stays null and overlay uses the dashed-initials fallback.
- **Auth widening from Jay-only to coach-with-team-access.** Swap the hardcoded email check for an auth-worker role lookup matching cards-worker's `verifyRole()`.
- **Post-game box score panel below the player.** A static box score below the iframe would complement the animated overlay nicely — backlog for after Phase 3 ships.

---

## Memory notes to capture after each deploy phase

After **Deploy 1**:
- New worker `canonniers-live-scorebug-worker` (KV-only, JWT-gated by single admin email).
- New admin pages (3 siblings, CF Access gated).
- Game-id formats and Start Game modal flow.

After **Deploy 2**:
- D1 tables `scorebug_games`, `scorebug_events` (schema, indexes).
- R2 bucket `canonniers-scorebug-timelines` (public read).
- END GAME flow (D1 update + R2 archive + KV delete).

After **Deploy 3**:
- CF Stream Player SDK integration pattern (postMessage to iframe, timeupdate event).
- Replay overlay handoff state machine (live ↔ replay ↔ idle).
- Mevo segment handling (one game = multiple videos sharing one timeline).

---

## Delivery convention reminders (from CLAUDE.md)

- Complete files only — no diffs.
- Review-before-write for any HTML page or worker JS.
- Each Build Phase = its own commit. Push after each phase confirmed working.
- `wrangler deploy` only after explicit "deploy" from Jay.
- After this directive is fully complete (all 3 deploy phases shipped), move from `Updates/` to `repo-working/docs/`.
