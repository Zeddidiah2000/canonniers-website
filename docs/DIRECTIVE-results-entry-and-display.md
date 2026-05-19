# Directive — Game results entry + public display

**Scope:** Backend (D1 table + roster-worker endpoints), admin tool (`admin-results.html`), public rendering (`calendrier.html` swaps pill for score, `index.html` gets a recent-results sidebar card). Manual entry only — OCR is a follow-up.

---

## Pre-flight

1. Fetch raw current state from GitHub:
   ```powershell
   curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/calendrier.html -o calendrier.html.current
   curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/index.html -o index.html.current
   curl.exe https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin.html -o admin.html.current
   ```
2. Read the roster-worker source from wherever it lives in CC's workspace. Confirm:
   - It uses `env.DB` binding to `canonniers-db`.
   - It already verifies CF Access JWT for write endpoints (the `admin-photos` pattern).
   - It has an existing `validatePlayer()` shape we can mirror for `validateResult()`.
3. **Backup D1 before migration:**
   ```powershell
   wrangler d1 export canonniers-db --remote --output ../backups/canonniers-db-pre-v9-$(Get-Date -Format yyyyMMdd-HHmm).sql
   ```
4. Confirm anchor strings exist exactly once in `calendrier.html`:
   - `function isPastGame(g) {` (added in prior directive)
   - `<span class="meta-pending fr-text">Résultat à venir</span>`
5. Confirm anchor exists in `index.html`:
   - `<div class="sidebar-card-body" id="upcoming-games-body">`
6. If any anchor fails, **stop and report.**

---

## Part 1 — D1 migration

Create `update_schema_v9_results.sql`:

```sql
CREATE TABLE game_results (
  spordle_game_id INTEGER PRIMARY KEY,
  team_category   TEXT    NOT NULL,
  game_date       TEXT    NOT NULL,
  game_number     TEXT,
  home_score      INTEGER NOT NULL DEFAULT 0,
  away_score      INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'final',
  notes           TEXT,
  updated_at      TEXT    NOT NULL,
  updated_by      TEXT
);
CREATE INDEX idx_game_results_team ON game_results(team_category);
CREATE INDEX idx_game_results_date ON game_results(game_date);
```

Apply:
```powershell
wrangler d1 execute canonniers-db --remote --file=./update_schema_v9_results.sql
```

`status` allow-list: `final | forfeit | cancelled | postponed`. For `cancelled`/`postponed`, scores stay 0/0 and the UI renders the status badge instead of the score.

---

## Part 2 — Roster worker endpoints

Add to existing `canonniers-roster-worker`:

**`GET /api/results`** — public, no auth. Returns all results as `{ "156779": [...], "156780": [...], "156781": [...] }` keyed by Spordle team-ID-mapped category, or flat array — match whatever `getAllPlayers` already returns for consistency. `Cache-Control: public, max-age=300`.

**`GET /api/results/:team`** — public. `team` ∈ `u15 | u17d1 | u17d2`. Filtered list.

**`PUT /api/results/:spordle_game_id`** — CF Access JWT required (existing pattern). Validate:
- `spordle_game_id`: positive integer (URL param)
- `team_category`: must be in `['u15','u17d1','u17d2']`
- `game_date`: ISO date string, parses to a real `Date`
- `home_score` / `away_score`: integers 0–99
- `status`: must be in `['final','forfeit','cancelled','postponed']`
- `game_number`: optional, max 32 chars, strip non-alphanumeric/dash
- `notes`: optional, max 500 chars, trim
- `updated_by`: extracted from JWT `email` claim, not from request body

Reject anything else with `400` + error message. Use D1 `.prepare().bind()` — no string interpolation. `INSERT OR REPLACE` on `spordle_game_id`. Set `updated_at = new Date().toISOString()`.

**`DELETE /api/results/:spordle_game_id`** — CF Access JWT required. For fixing mistakes.

Deploy:
```powershell
wrangler deploy
```

---

## Part 3 — `admin-results.html`

New file at repo root. Pattern match `admin-roster.html` for layout/header/auth glue. CF Access already gates `/admin*`. Include `<meta name="robots" content="noindex">`.

**Behavior:**

1. On load, fetch in parallel:
   - All three teams from `spordle-proxy.chisholm2000.workers.dev` (loop the three team IDs).
   - All existing results from `canonniers-roster-worker.chisholm2000.workers.dev/api/results`.
2. Compute "past games" = `startTime + 4h < now`. Same `isPastGame()` rule as `calendrier.html`.
3. Join past games against existing results by `spordle_game_id`. Three buckets:
   - **Needs entry** (past, no result) — show first, expanded.
   - **Entered** (past, has result) — show second, collapsed by default, expandable to edit.
   - Future games are not shown at all.
4. Each row in **Needs entry**:
   - Date · Game # · Matchup (Canonniers vs/at Opponent) · `[home_score]` `–` `[away_score]` · status `<select>` defaulting to `final` · optional notes input · **Save** button.
   - Status field: `final / forfeit / cancelled / postponed` (FR labels: `Final / Forfait / Annulé / Reporté`).
   - When status is `cancelled` or `postponed`, disable score inputs and force 0–0.
   - Save → `PUT /api/results/:id` with the payload. Show inline success/error. On success, the row moves to "Entered."
5. Each row in **Entered**: same fields, pre-filled, with **Save** and **Delete** buttons. Delete confirms first.
6. Team filter tabs at top (All / 15U / 17U D1 / 17U D2), preserving counts: `Needs entry (3) · Entered (5)`.
7. Add to `admin.html` tile grid: tile linking to `admin-results.html` with icon (📊 or similar) and label "Résultats / Results."
8. Add `Disallow: /admin-results.html` to `robots.txt`.

**Threat model:**
- All writes behind CF Access JWT (worker enforces, fail-closed).
- Client-side score-input `min="0" max="99"` is UX hint only — worker re-validates.
- Even if someone bypasses the page, `PUT` requires a valid JWT from `@canonniers.ca`.

---

## Part 4 — `calendrier.html` public render

**Find** the `isPastGame` helper added in the prior directive. **Immediately after it**, add:

```javascript
    let resultsCache = null;
    async function fetchResults() {
      if (resultsCache) return resultsCache;
      try {
        const resp = await fetch('https://canonniers-roster-worker.chisholm2000.workers.dev/api/results');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const map = {};
        (Array.isArray(data) ? data : []).forEach(r => { map[r.spordle_game_id] = r; });
        resultsCache = map;
        return map;
      } catch (e) {
        resultsCache = {};
        return {};
      }
    }
```

**Find** the existing meta-row block:
```
                  ${isPastGame(g)
                    ? `<span class="meta-pending fr-text">Résultat à venir</span>
                       <span class="meta-pending en-text">Result pending</span>`
                    : `<span class="meta-time">${time ? `🕐 ${time}` : ''}</span>
```

**Replace the entire `isPastGame(g) ? ... : ...` block with:**

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
                    const ourScore  = isHome ? r.home_score : r.away_score;
                    const theirScore = isHome ? r.away_score : r.home_score;
                    const outcome = ourScore > theirScore ? 'W' : ourScore < theirScore ? 'L' : 'T';
                    const outcomeFr = outcome === 'W' ? 'V' : outcome === 'L' ? 'D' : 'N';
                    const forfeitTag = r.status === 'forfeit'
                      ? `<span class="meta-forfeit fr-text">Forfait</span><span class="meta-forfeit en-text">Forfeit</span>`
                      : '';
                    return `<span class="meta-score outcome-${outcome}">${ourScore} – ${theirScore} <span class="outcome-tag fr-text">${outcomeFr}</span><span class="outcome-tag en-text">${outcome}</span></span>${forfeitTag}`;
                  })()}
```

**Add CSS** in the `:root`/styles block (find the `.meta-pending` rule, insert after it):

```css
    .meta-score { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 3px; font-family: 'Barlow Condensed', sans-serif; font-size: 16px; font-weight: 800; letter-spacing: 0.02em; color: var(--navy); background: var(--sky-pale); border: 1px solid var(--sky-light); }
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

**Find `loadSchedule` and patch to fetch results in parallel:**

```javascript
    async function loadSchedule(teamKey) {
      if (cache[teamKey]) { renderGames(teamKey, cache[teamKey]); return; }
      try {
        const [games] = await Promise.all([
          fetchSchedule(teamKey),
          fetchResults().then(map => { window.__results = map; })
        ]);
        renderGames(teamKey, games);
      } catch (err) {
        renderError(teamKey, err.message);
      }
    }
```

Note: losing colors on `outcome-L` to muted gray instead of red — matches your earlier ask not to red-flag losses. If you'd rather have red on losses, change `.meta-score.outcome-L` to use `--red-accent`. Recommend keeping gray.

---

## Part 5 — `index.html` recent-results sidebar card

**Find:**
```
      <div class="sidebar-card">
        <div class="sidebar-card-header">
          <span class="fr-text">Prochains matchs</span>
          <span class="en-text">Upcoming games</span>
        </div>
```

**Insert this block immediately before it (so "Recent results" appears above "Upcoming games"):**

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

In the existing index.html `<script>` block, find where `upcoming-games-body` is populated and add a sibling renderer for `recent-results-body`. It should:
1. Fetch `/api/results` once.
2. Sort by `game_date` descending.
3. Render the most recent 5, across all teams, in a row format: team-badge + score + opponent + date.
4. On error or empty: show "Aucun résultat / No results yet."

Mirror existing sidebar item markup for visual consistency. Mark each result with team category (U15 / U17D1 / U17D2) so it's clear which team played.

---

## Commit (single commit)

```
results: D1 table, admin entry tool, public render on schedule + home

- New table game_results (spordle_game_id PK, team_category, scores, status, notes)
- Roster worker: GET /api/results, PUT/DELETE /api/results/:id (CF Access auth)
- New admin-results.html, linked from admin.html tile grid
- calendrier.html replaces "Résultat à venir" pill with score for entered games
- index.html sidebar gains "Derniers résultats / Recent results" card
- Status: final / forfeit / cancelled / postponed
- Manual entry only; OCR is a follow-up
```

---

## Post-deploy verification

1. **D1 schema:** `wrangler d1 execute canonniers-db --remote --command "SELECT sql FROM sqlite_master WHERE name='game_results';"` — confirm table exists.
2. **Worker GET:** `curl.exe https://canonniers-roster-worker.chisholm2000.workers.dev/api/results` returns `[]` initially.
3. **Admin tool:**
   - Visit `/admin-results.html`. CF Access prompts login.
   - Past games appear in "Needs entry."
   - Enter a score for one game (e.g., 17U D2 game on 2026-05-14). Save → success message.
   - Row moves to "Entered."
4. **Public schedule:**
   - Visit `/calendrier.html`. The game whose score you entered shows the score (with V/W tag) instead of the pill.
   - Other past games still show "Résultat à venir."
5. **Index:**
   - Visit `/`. "Derniers résultats" card shows the entered result.
6. **Status edge cases:**
   - Enter a `cancelled` game. Calendrier shows "Annulé" badge. Index sidebar shows it appropriately.
   - Enter a `forfeit` game. Score visible + "Forfait" tag.
7. **Delete:** in admin, delete a result. Refresh schedule — pill returns.
8. **Worker logs:** `wrangler tail canonniers-roster-worker` while clicking — confirm no errors, `cpuTimeMs` non-zero.

---

## Open questions for Claude Code

- Confirm the exact roster-worker file path before editing.
- If the worker doesn't yet have a CF Access JWT verification helper factored out, add one — don't inline the verification logic per route.
- If `getCurrentRole()` is wired up in admin pages, gate the admin-results page to `admin` and `coach` roles only.

---

## Rollback

If anything breaks:

```powershell
git revert HEAD
git push origin main
```

D1 table stays (harmless, additive). To fully roll back the table:
```powershell
wrangler d1 execute canonniers-db --remote --command "DROP TABLE game_results;"
```

Worker endpoints will 404 cleanly once the code is reverted (no public page depends on them after revert).
