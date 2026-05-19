# Directive — Game results (new worker + admin + public render)

**Scope:** One new worker (`canonniers-results-worker`) backed by KV. One new admin page (`admin-results.html`). Patch `calendrier.html` to render entered scores. Patch `index.html` to show recent results in sidebar.

No changes to `canonniers-roster-worker`. No D1. No auth migration.

---

## Pre-flight

Fetch raw current state:
```powershell
curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/calendrier.html -o calendrier.html.current
curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/index.html -o index.html.current
curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin.html -o admin.html.current
curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/robots.txt -o robots.txt.current
```

Confirm anchors exist exactly once:
- `calendrier.html`: `function isPastGame(g) {` and `<span class="meta-pending fr-text">Résultat à venir</span>` and `async function loadSchedule(teamKey) {`
- `index.html`: `<div class="sidebar-card-body" id="upcoming-games-body">`
- `admin.html`: the tile-grid array (locate the existing tiles to mirror shape)

Stop if any missing.

---

## Part 1 — New worker `canonniers-results-worker`

Create new worker project (separate from roster-worker). Structure:

```
canonniers-results-worker/
  wrangler.toml
  src/index.js
```

**`wrangler.toml`:**
```toml
name = "canonniers-results-worker"
main = "src/index.js"
compatibility_date = "2024-09-23"

kv_namespaces = [
  { binding = "RESULTS", id = "<TO_CREATE>" }
]
```

Create the KV namespace:
```powershell
wrangler kv namespace create RESULTS
```
Paste the returned `id` into `wrangler.toml`.

Set the bearer secret (new dedicated token, not reused):
```powershell
wrangler secret put RESULTS_TOKEN
```
Generate the value with `[System.Guid]::NewGuid().ToString("N")` or similar — long random string. Save it; admin page will need it.

**`src/index.js`:**

```javascript
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const STATUSES = ['final', 'forfeit', 'cancelled', 'postponed'];
const TEAMS = ['u15', 'u17d1', 'u17d2'];
const KEY = 'all';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function validate(r) {
  const id = Number(r.spordle_game_id);
  if (!Number.isInteger(id) || id <= 0) return 'spordle_game_id must be positive integer';
  if (!TEAMS.includes(r.team_category)) return 'team_category invalid';
  if (!r.game_date || isNaN(new Date(r.game_date))) return 'game_date invalid';
  if (!STATUSES.includes(r.status)) return 'status invalid';
  const h = Number(r.home_score), a = Number(r.away_score);
  if (!Number.isInteger(h) || h < 0 || h > 99) return 'home_score 0-99';
  if (!Number.isInteger(a) || a < 0 || a > 99) return 'away_score 0-99';
  if (r.game_number && String(r.game_number).length > 32) return 'game_number too long';
  if (r.notes && String(r.notes).length > 500) return 'notes too long';
  return null;
}

function clean(r) {
  return {
    spordle_game_id: Number(r.spordle_game_id),
    team_category: r.team_category,
    game_date: r.game_date,
    game_number: r.game_number ? String(r.game_number).slice(0, 32) : null,
    home_score: Number(r.home_score),
    away_score: Number(r.away_score),
    status: r.status,
    notes: r.notes ? String(r.notes).trim().slice(0, 500) : null,
    updated_at: new Date().toISOString(),
  };
}

async function loadAll(env) {
  const raw = await env.RESULTS.get(KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveAll(env, arr) {
  await env.RESULTS.put(KEY, JSON.stringify(arr));
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // GET /api/results — public
    if (request.method === 'GET' && path === '/api/results') {
      const results = await loadAll(env);
      return new Response(JSON.stringify(results), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60',
          ...CORS,
        },
      });
    }

    // Authed routes below
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${env.RESULTS_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // PUT /api/results/:id
    const putMatch = path.match(/^\/api\/results\/(\d+)$/);
    if (request.method === 'PUT' && putMatch) {
      const id = Number(putMatch[1]);
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
      body.spordle_game_id = id;
      const err = validate(body);
      if (err) return json({ error: err }, 400);
      const all = await loadAll(env);
      const idx = all.findIndex(r => r.spordle_game_id === id);
      const row = clean(body);
      if (idx >= 0) all[idx] = row; else all.push(row);
      await saveAll(env, all);
      return json(row);
    }

    // DELETE /api/results/:id
    if (request.method === 'DELETE' && putMatch) {
      const id = Number(putMatch[1]);
      const all = await loadAll(env);
      const next = all.filter(r => r.spordle_game_id !== id);
      if (next.length === all.length) return json({ error: 'Not found' }, 404);
      await saveAll(env, next);
      return json({ deleted: id });
    }

    return json({ error: 'Not found' }, 404);
  },
};
```

Deploy:
```powershell
wrangler deploy
```

Worker URL: `https://canonniers-results-worker.chisholm2000.workers.dev`

**Quick smoke test:**
```powershell
curl.exe https://canonniers-results-worker.chisholm2000.workers.dev/api/results
# Expect: []
```

---

## Part 2 — `admin-results.html`

New file at repo root. Pattern-match `admin-roster.html` for layout/header. Include `<meta name="robots" content="noindex">`.

**Behavior:**

1. On load, prompt for bearer token if not in `sessionStorage`. Store under key `results_token`. (CF Access already gates the page itself; this token is for the worker API.)
2. Fetch in parallel:
   - All three Spordle teams: `spordle-proxy.chisholm2000.workers.dev?officeId=4168&teamId=...` for each of `156779`, `156780`, `156781`. Map each team's games with a `team_category` tag (`u15`, `u17d1`, `u17d2`).
   - `GET /api/results` from results-worker.
3. Filter to past games: `startTime + 4h < now`.
4. Two sections:
   - **À saisir / Needs entry** (no result yet) — show first.
   - **Saisis / Entered** (has result) — collapsed, expandable.
5. Each row:
   - Date · Game # · Matchup · `[home_score]` `–` `[away_score]` · status `<select>` · notes input · **Save** / **Delete**
   - Status options: `final / forfeit / cancelled / postponed` (FR: `Final / Forfait / Annulé / Reporté`).
   - When status is `cancelled` or `postponed`, disable score inputs and force 0–0.
6. Team filter tabs: `Tous / 15U / 17U D1 / 17U D2`, with counts.
7. Save calls `PUT https://canonniers-results-worker.chisholm2000.workers.dev/api/results/:id` with `Authorization: Bearer <token>`. Payload: `{ team_category, game_date, game_number, home_score, away_score, status, notes }`.
8. Delete calls `DELETE /api/results/:id` with confirmation prompt.
9. On 401, clear `sessionStorage.results_token` and re-prompt.

Add to `admin.html` tile grid (mirror existing tile shape):
- Label FR: `Résultats`, EN: `Results`
- Icon: ⚾ or 📊
- href: `admin-results.html`
- `allowed: ['admin', 'coach']`

Add to `robots.txt`: `Disallow: /admin-results.html`

---

## Part 3 — `calendrier.html` public render

**Find** the `isPastGame` helper (added in prior directive). **Add immediately after it:**

```javascript
    let resultsCache = null;
    async function fetchResults() {
      if (resultsCache !== null) return resultsCache;
      try {
        const resp = await fetch('https://canonniers-results-worker.chisholm2000.workers.dev/api/results');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const arr = await resp.json();
        const map = {};
        (Array.isArray(arr) ? arr : []).forEach(r => { map[r.spordle_game_id] = r; });
        resultsCache = map;
        return map;
      } catch (e) {
        resultsCache = {};
        return {};
      }
    }
```

**Find** the pill block (from prior directive):
```
                  ${isPastGame(g)
                    ? `<span class="meta-pending fr-text">Résultat à venir</span>
                       <span class="meta-pending en-text">Result pending</span>`
                    : `<span class="meta-time">${time ? `🕐 ${time}` : ''}</span>
                       <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} fr-text">${isHome ? 'Domicile' : 'Visiteur'}</span>
                       <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} en-text">${isHome ? 'Home' : 'Away'}</span>
                       ${park.name ? mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener">📍 ${park.name}</a>` : `<span>📍 ${park.name}</span>` : ''}`}
```

**Replace with:**

```
                  ${(() => {
                    if (!isPastGame(g)) {
                      return `<span class="meta-time">${time ? `🕐 ${time}` : ''}</span>
                              <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} fr-text">${isHome ? 'Domicile' : 'Visiteur'}</span>
                              <span class="meta-location badge ${isHome ? 'badge-home' : 'badge-away'} en-text">${isHome ? 'Home' : 'Away'}</span>
                              ${park.name ? mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener">📍 ${park.name}</a>` : `<span>📍 ${park.name}</span>` : ''}`;
                    }
                    const r = (window.__results || {})[g.id];
                    if (!r) {
                      return `<span class="meta-pending fr-text">Résultat à venir</span>
                              <span class="meta-pending en-text">Result pending</span>`;
                    }
                    if (r.status === 'cancelled') {
                      return `<span class="meta-status meta-status-cancel fr-text">Annulé</span>
                              <span class="meta-status meta-status-cancel en-text">Cancelled</span>`;
                    }
                    if (r.status === 'postponed') {
                      return `<span class="meta-status meta-status-postpone fr-text">Reporté</span>
                              <span class="meta-status meta-status-postpone en-text">Postponed</span>`;
                    }
                    const ourScore = isHome ? r.home_score : r.away_score;
                    const theirScore = isHome ? r.away_score : r.home_score;
                    const outcome = ourScore > theirScore ? 'W' : ourScore < theirScore ? 'L' : 'T';
                    const outcomeFr = outcome === 'W' ? 'V' : outcome === 'L' ? 'D' : 'N';
                    const forfeitTag = r.status === 'forfeit'
                      ? `<span class="meta-forfeit fr-text">Forfait</span><span class="meta-forfeit en-text">Forfeit</span>`
                      : '';
                    return `<span class="meta-score outcome-${outcome}">${ourScore} – ${theirScore} <span class="outcome-tag fr-text">${outcomeFr}</span><span class="outcome-tag en-text">${outcome}</span></span>${forfeitTag}`;
                  })()}
```

**Find** the `.meta-pending` CSS block (added in prior directive). **Add immediately after it:**

```css
    .meta-score { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 3px; font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 800; color: var(--navy); background: #f0f4fa; border: 1px solid #c9d7e8; }
    .meta-score .outcome-tag { font-size: 11px; font-weight: 800; padding: 2px 6px; border-radius: 2px; letter-spacing: 0.08em; }
    .meta-score.outcome-W { background: #e8f3ec; border-color: #b8d9c1; color: var(--green); }
    .meta-score.outcome-W .outcome-tag { background: var(--green); color: #fff; }
    .meta-score.outcome-L { background: #f3f4f6; border-color: #d1d5db; color: #4b5563; }
    .meta-score.outcome-L .outcome-tag { background: #4b5563; color: #fff; }
    .meta-score.outcome-T { background: #f1f3f7; border-color: #d3dae5; color: var(--navy); }
    .meta-score.outcome-T .outcome-tag { background: var(--navy); color: #fff; }
    .meta-status { display: inline-flex; padding: 5px 12px; border-radius: 3px; font-family: 'Barlow Condensed', sans-serif; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
    .meta-status-cancel { background: #fdecec; border: 1px solid #f5c2c2; color: var(--red-accent); }
    .meta-status-postpone { background: #fef6e0; border: 1px solid #f0d58a; color: #7a5a00; }
    .meta-forfeit { display: inline-flex; padding: 5px 10px; border-radius: 3px; background: #f3f4f6; border: 1px solid #d1d5db; color: #4b5563; font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
```

**Find** `async function loadSchedule(teamKey) {` and **replace the body of the try block** so it fetches results in parallel:

```javascript
    async function loadSchedule(teamKey) {
      if (cache[teamKey]) { renderGames(teamKey, cache[teamKey]); return; }
      try {
        const [games] = await Promise.all([
          fetchSchedule(teamKey),
          fetchResults().then(map => { window.__results = map; })
        ]);
        cache[teamKey] = games;
        renderGames(teamKey, games);
      } catch (err) {
        renderError(teamKey, err.message);
      }
    }
```

Note: confirm the original `loadSchedule` body shape matches the replacement above. If it has more logic, preserve it; this directive only adds the parallel `fetchResults` call.

---

## Part 4 — `index.html` recent results sidebar

**Find:**
```
      <div class="sidebar-card">
        <div class="sidebar-card-header">
          <span class="fr-text">Prochains matchs</span>
          <span class="en-text">Upcoming games</span>
        </div>
```

**Insert immediately before it:**

```html
      <div class="sidebar-card">
        <div class="sidebar-card-header">
          <span class="fr-text">Derniers résultats</span>
          <span class="en-text">Recent results</span>
        </div>
        <div class="sidebar-card-body" id="recent-results-body">
          <div class="loading-news" style="padding:20px 0;">
            <div class="spinner-news"></div>
            <span class="fr-text">Chargement…</span>
            <span class="en-text">Loading…</span>
          </div>
        </div>
      </div>
```

In the index.html `<script>` block, add a renderer that:
1. Fetches `https://canonniers-results-worker.chisholm2000.workers.dev/api/results`.
2. Sorts by `game_date` descending.
3. Renders the most recent 5 in `#recent-results-body` with: team-badge (U15 / U17 D1 / U17 D2) · score · opponent · date.
4. On error or empty: "Aucun résultat / No results yet."

Mirror existing sidebar item markup for visual consistency. Match the patterns CC sees in the `upcoming-games-body` renderer.

---

## Commit

Single commit:
```
results: KV-backed results worker, admin entry, public render

- New canonniers-results-worker (KV-backed, bearer auth)
- New admin-results.html for manual score entry
- calendrier.html: pill becomes score when entered
- index.html: new "Derniers résultats" sidebar card
- Status: final / forfeit / cancelled / postponed
```

---

## Post-deploy verification

1. `curl.exe https://canonniers-results-worker.chisholm2000.workers.dev/api/results` → `[]`
2. Visit `/admin-results.html`, paste token. Past games appear in "Needs entry."
3. Enter a 17U D2 game score from 2026-05-14. Save → success. Row moves to "Entered."
4. Re-fetch `/api/results` → 1 entry visible.
5. Visit `/calendrier.html` 17U D2 tab. The May 14 game shows the score with V/W tag. Other past games still show "Résultat à venir."
6. Visit `/`. "Derniers résultats" card shows the entered result.
7. Test cancelled/postponed/forfeit statuses, confirm each renders correctly.
8. Delete from admin → schedule reverts to pill.
9. `wrangler tail canonniers-results-worker` during clicks — no errors, non-zero `cpuTimeMs`.

---

## Open questions

None. Token is generated, stored as worker secret, pasted into admin sessionStorage on first use.

---

## Rollback

```powershell
git revert HEAD
git push origin main
```

To kill the worker entirely: `wrangler delete canonniers-results-worker`. KV namespace can be left or deleted separately. No data loss for the public site — schedule reverts to pill-only state.
