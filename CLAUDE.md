# CLAUDE.md — Canonniers de Québec Website

Standing brief for Claude Code. Read this before touching anything.

---

## What this project is

An **unofficial fan site** for the Canonniers de Québec AAA baseball program at **canonniersdequebec.ca**. Three teams: 15U AAA, 17U Division 1, 17U Division 2. Fully bilingual FR/EN. Never imply the site is operated by the association.

**Owner:** Jay (maintainer, all technical decisions). **JP** runs the Facebook page and leads the association.

**GitHub:** `Zeddidiah2000/canonniers-website` (public). Push to `main` → Cloudflare Pages auto-deploys to canonniersdequebec.ca. Drag-and-drop deploy is fully retired — never use it.

---

## Folder structure

Working root: `C:\Users\Potato\Documents\Canonniers Website\`

- `repo-working\` — **the active git repo**. All edits happen here. Run all git commands from this folder.
- `Updates\` — drop zone for directive files and input data. When Jay says he's dropped something in, check here first.
- `Canonniers WEB\` — backup/reference copy. Do not edit.

**Inside `repo-working\`:**
- `docs/` — archived directives, project notes, stats schema. Completed directive files move here.
- `scripts/` — Node.js injection/validation scripts for the stats pipeline.
- `stats-input/` — drop zone for incoming GameChanger JSON (gitignored).
- `backups/` — pre-injection backups (gitignored).
- `src/index.js` — `canonniers-roster-worker` source.
- `photo-worker/`, `canonniers-news-worker/`, `canonniers-replays-worker/`, `canonniers-standings-worker/` — top-level self-contained worker folders.
- `workers/` — second-tier workers: `canonniers-auth-worker`, `canonniers-cards-worker`, `canonniers-email-router`, `canonniers-live-scorebug-worker`, `canonniers-results-worker`, `library`.

---

## Tech stack

- **Hosting:** Cloudflare Pages (static HTML)
- **Database:** Cloudflare D1 `canonniers-db` (roster, photos, coaches)
- **Storage:** Cloudflare R2 (`player-photos`, photo library media, card outputs)
- **KV:** Multiple namespaces (STANDINGS, RESULTS, SCOREBUG, NEWS, others — bound by worker)
- **Images:** Cloudflare Images — delivery URL pattern `https://imagedelivery.net/XuWXX2Hn8HGMN14wNLQAMA/<cf_image_id>/<variant>`
- **Live streaming:** Cloudflare Stream (three live input UIDs, one per team)
- **Live data:** **GameChanger** (`api.team-manager.gc.com`) is the live source of truth for scores, schedules, and game state once the season is underway — the league pays scorekeepers to keep it updated in real time. **Spordle** (`page.spordle.com`) is the start-of-season schedule/roster system; the league migrates to GC as the season progresses. Default to GC for anything game-state-related.

**Workers** (all live at `<name>.chisholm2000.workers.dev`):

- `canonniers-auth-worker` — auth oracle. Returns `{email, role, teams[]}` for a hardcoded jay + regex on aliases. No JWT validation — never gate UI on response alone.
- `canonniers-cards-worker` — FB Game Day card generator. Schema field is `size_variant`. Soft-delete leaks R2 (future-hardening item).
- `canonniers-email-router` — `*@canonniers.ca` routing. `routes.json` is a static import — redeploy required after changes. Hardcoded fallback to `chisholm2000@gmail.com`.
- `canonniers-live-scorebug-worker` — KV-backed score state for the broadcast overlay. 15U only v1.
- `canonniers-news-worker` — proxies Spordle league news API → homepage Nouvelles card.
- `canonniers-replays-worker` — chains CF Stream → Spordle → results-worker; renders scoreboard thumbnails for replays.
- `canonniers-results-worker` — game-results KV. Now auto-populated by standings-worker backfill; manual entry via `admin-results.html` is a fallback for non-GC games. Manual entries (no `source: 'gc'`) are never overwritten by the harvester.
- `canonniers-roster-worker` — D1 CRUD + R2 player photos (source at `src/index.js`). Public photo route is intentional — protected routes break images on the site.
- `canonniers-standings-worker` — leagues + tournaments + per-team `season_games` from GC. 4×/day full refresh + `*/2 min` lightweight refresh (idle-skip when no game is in [-6h, +30min] activity window).
- `library` (`canonniers-library-worker`) — photo library backend for `admin-photo-library.html`.
- `photo-worker` — CF Images direct upload + D1 photos table.
- `spordle-proxy` — Spordle schedule proxy + Claude API + remove.bg. Service-bound by other workers (cross-worker fetch is blocked same-account; use service bindings).

**Team IDs:**
- Spordle: 15U AAA = `156779`, 17U D1 = `156780`, 17U D2 = `156781`
- GameChanger: 15U = `aMDDLssAvjFT`, 17U D1 = `ri4fPQu1DiQS`, 17U D2 = `0DLnmx5bPCGz`
- GC league orgs: u15 = `xnQjeQyO7cFq`, u17 = `x2GrNpCrYJa0`

---

## Design system — non-negotiable on every page

```css
--navy: #0d1f4e   --navy-mid: #152960   --navy-light: #1e3a8a
--sky: #6ab0d4    --sky-light: #a8d4ec  --sky-pale: #daeef8
--white: #ffffff  --off-white: #f4f7fa  --gray: #6b7280  --gray-light: #e5e7eb
```

- Fonts: `Barlow Condensed` (700–900, uppercase) for headings/UI; `Barlow` for body. Both from Google Fonts.
- Content width breakpoints: **1100px** (default) → **1380px** (`min-width: 1400px`) → **1680px** (`min-width: 1800px`). All three must be wired on every page.
- Shared chrome: lang bar → header (centered logo) → nav → page-header → team tabs → content → footer.
- Nav has sky-blue underline on the active page. Three-tab team structure (`u15` / `u17d1` / `u17d2`) on all multi-team pages.
- Footer: 3-column grid (logo+blurb / Navigation links / Contact address).

**Reference page for chrome conventions:** `alignement.html`.

---

## Bilingual rules

Every user-facing string lives twice in the DOM, toggled by a CSS class on `<body>`:

```html
<span class="fr-text">Accueil</span><span class="en-text">Home</span>
```

```css
.en-text { display: none !important; }
body.lang-en .fr-text { display: none !important; }
body.lang-en .en-text { display: revert !important; }
```

- **No exceptions.** Quebec's Bill 96 / Charter make bilingual public output mandatory — not a "nice to have", not deferrable as YAGNI. Never recommend "FR-only" or "ship EN later" for public-facing surfaces.
- French copy must use **québécois register**: "Calendrier" not "Programme", "Alignement" not "Composition", "Matchs" not "Jeux", "Pratiques" not "Entraînements".
- Language preference stored in `localStorage` key `lang`.

---

## Delivery conventions

**Always start from the current file.** Read it fresh before every edit. Never work from memory of a previously generated version.

**Complete files only.** Every response that touches an HTML file must contain the entire file. No diffs, patches, or partial snippets — Jay commits and pushes directly.

**Review before write.** For any non-trivial file (HTML pages, worker JS), output the complete contents in a code block and wait for explicit "approved" or "write it" before calling the Write tool.

**Trust mode.** When Jay says "trust you / proceed / push live", treat that as a session-level go-ahead — write, commit, push, and `wrangler deploy` end-to-end without re-asking per file. Default to that interpretation when he steps away mid-task.

---

## Git / deploy protocol

1. Write files → `git add <specific files>` → `git commit`
2. Show `git show HEAD --stat` + full diff
3. **Wait for explicit "push"** before running `git push` (unless trust-mode is active for the session)
4. If the commit includes a `wrangler deploy`: show the plan first, **wait for explicit "deploy"** (unless trust-mode)

Never include "Co-Authored-By: Claude" in commit messages.

**SSL on Windows:** Stale CA bundles bite all three of git, Node/wrangler, and curl.
- Git push: `git -c http.sslBackend=schannel push origin main`
- Wrangler / Node: `NODE_OPTIONS=--use-system-ca`
- Curl: `--ssl-no-revoke`

**Wrangler binary** lives at `workers/canonniers-cards-worker/node_modules/.bin/wrangler.cmd` (only worker dir with node_modules installed) — reuse this binary for all worker deploys.

**Wrangler secret put** — use `printf "%s"` not `echo` when piping secrets. `echo` appends `\n` which silently breaks auth.

---

## Updates folder workflow

Jay drops directive files and data inputs into `Updates\`. When he says he's dropped something in, check that folder.

After a directive is **complete**, move its file from `Updates\` to `repo-working\docs\` — always ask Jay first (the answer is always yes, but ask anyway). Commit the move as its own small commit.

---

## Admin pages

All `/admin*.html` pages use:
- Worker-level auth: `Authorization: Bearer <token>` (token varies by worker — check the page's JS constants)
- `noindex` meta tag, `Disallow` entry in `robots.txt`
- Obscure URLs (not linked from public nav)

Page-level `sessionStorage` password gating has been **removed** from per-page checks — relies on obscure URL + `noindex` + robots.txt + Cloudflare Access on the admin hub itself. Full CF Access migration for individual admin pages is still on the backlog.

Admin pages are accessible via `admin.html` tile grid (role-gated by `?role=` URL param from the auth-worker oracle).

---

## Key pages

| File | Purpose |
|---|---|
| `index.html` | Bilingual homepage — hero video (1.4× zoom of an in-game home-run loop, muted autoplay), tournament banner, per-team next-up cards (live → recent ≤6h → upcoming), news, recent results sidebar, upcoming games sidebar, FB Page plugin |
| `calendrier.html` | Per-team schedule. Spordle-spined; overlays EN DIRECT chip + running score for in-progress games (from `season_games`) and final scores from results-worker KV. 60s auto-refresh. |
| `classement.html` | League standings + tournament standings widget (15U / 17U D1 / 17U D2 tabs, league-scoped tournament visibility) |
| `alignement.html` | Dynamic roster from D1; rows link to `joueur.html?id=`. Reference page for chrome conventions. |
| `joueur.html` | Player profile — hero banner, career pills, year-versioned `stats_json` (consumers pick latest year) |
| `coach.html` | Coach profile (mirror of joueur for staff) |
| `diffusion.html` | Cloudflare Stream live streaming + replay archive. **Standard HLS only** — LL-HLS broke playback on Lightstream + CF Stream. Reads `localStorage.activeStreamTeam`. |
| `galerie.html` | Public photo gallery — CF Images, team tabs, type filter, lightbox |
| `scorebug.html` | Transparent score overlay for golightstream / OBS (KV-driven via scorebug-worker, 15U only v1) |
| `admin.html` | Admin hub — tile grid, role-gated |
| `admin-roster.html` | Roster CRUD + R2 headshot upload |
| `admin-coaches.html` | Coach bios editor |
| `admin-photos.html` | Photo upload portal (CF Images direct upload, D1 insert) |
| `admin-photo-library.html` | Photo library admin (306 media-day photos in R2) |
| `admin-results.html` | Manual game-result entry — **fallback only**; standings-worker auto-backfills GC finals |
| `admin-social.html` | FB post generator + Game Day card composer (D07 compose UI, FR — EN debt) |
| `admin-scorekeeper.html` | Phone-first scorekeeper writing to the scorebug KV |
| `faq.html` | FAQ |

---

## Live data architecture

GameChanger is the live source of truth for the regular season. The standings worker harvests:
- `data.season_games: { u15, u17d1, u17d2 }` — every game on each team's GC schedule, with live `game_status` + running `score`
- 4×/day full refresh (11:00 / 17:00 / 22:00 / 02:30 UTC) + `*/2 min` lightweight refresh
- Lightweight cron idle-skips when no cached game's `start_ts` is in [-6h, +30min] — cheap idle, tight during games
- Finals auto-backfill into the `canonniers-results-worker` KV via a date+opponent join against the Spordle schedule (`spordle_game_id` remains the canonical join key). Manual entries (no `source: 'gc'`) are never overwritten.

**Frontend consumers:**
- `index.html` per-team cards: live → recent (≤6h) → next upcoming, 60s page-side refresh
- `calendrier.html` EN DIRECT chip overlay on in-progress games, 60s refresh
- `diffusion.html` replay thumbnails read final scores from results-worker KV (now auto-populated)

**Diagnostic endpoint:** `https://canonniers-standings-worker.chisholm2000.workers.dev/api/standings` returns the whole KV blob (public).

---

## Known gotchas

**GameChanger:** GC `game_status='completed'` is canonicalized to `'final'` on results-KV writes (the results-worker's enum is `final/forfeit/cancelled/postponed`). GC `score` shape is `{ team, opponent_team }` from our side — map to home/away via the game's `home_away` flag. GC team `avatar_url` is signed for ~7 min — mirror PNGs to `/assets/team-logos/` and map via the worker's `LOGO_OVERRIDES`. Don't web-search "is there a public API" — sniff DevTools first.

**Spordle API:** Do NOT include `venue` in the `include` array — causes 500 errors. Read venue from `surface.venue.name`. Required headers: `Origin: https://page.spordle.com`, `X-Page-Type: LEAGUE`.

**Date parsing:** Bare `new Date("YYYY-MM-DD")` parses as UTC midnight; EDT viewers see prev day. Always append `T12:00:00Z`. For GC↔Spordle joins, normalize both sides to `YYYY-MM-DD` in `America/Toronto` via `Intl.DateTimeFormat`.

**Cron auto-harvesters** must NEVER let an empty upstream fetch wipe previously-good KV data. Per-team preservation pattern: `preserveOnEmpty(fetched, cached)` in `canonniers-standings-worker`. Copy this pattern to any new cron writer.

**Cross-worker fetch is blocked same-account** — use service bindings (`[[services]]` in wrangler.toml) or direct KV binds, not HTTP-to-sibling-worker URLs.

**Worker syntax:** `export default { fetch }` (ES module) — not the old `addEventListener('fetch', ...)` style.

**Player photos** must be on a public route in the roster Worker — protected routes = broken images on the site.

**Cloudflare Pages cache:** `cpuTimeMs: 0` in Worker logs means the Worker isn't executing (stale deploy), not a code bug. Re-deploy or check route binding.

**Browser cache on static assets** — the static MP4/JS/etc. URLs aren't fingerprinted. After replacing a binary asset, add a `?v=N` query bump to the `src` so browsers don't keep serving the cached version.

**www SSL:** Both `www.canonniersdequebec.ca` as a custom domain in Pages AND a 301 redirect rule to apex must exist — don't remove either.

**Diffusion HLS:** Standard HLS only — LL-HLS (any flavor) caused heavy buffering on Lightstream + CF Stream. Don't propose LL-HLS optimizations.

---

## Active backlog

1. **EN compliance debt** — card generator (D06 templates + D07 compose UI) shipped FR-only by Jay's time-pressure decision; EN required by law as follow-up.
2. **Cloudflare Access migration** for individual admin pages (replacing static password + the open auth-worker oracle).
3. **Future hardening** — known security/cost gaps: open `/removebg`, library-worker bearer = "admin", soft-delete R2 leak on cards.
4. **Bunny.net migration** (paused 2026-05-27): hits 65% transcode wall on long 1080p videos. Paying CF Stream summer surcharge while evaluating alternatives. **Do NOT delete CF Stream originals while paused.**
5. **Auto background removal** in `admin-roster.html` upload flow.
6. **Scorebug v2** — extend beyond 15U to 17U D1 and 17U D2.

**Completed since the prior brief:** photo tokens rotated; admin tile grid + role gating; coach bios + coach.html; photo library (306 media-day photos); results-worker + admin-results; replays system; Spordle league news + FB Page plugin; standings + tournaments; standings auto-backfill of finals; live scorebug v1; card generator (FR); GameChanger live-source integration (homepage per-team cards + calendrier live badges); hero video.

---

## Archived directives (in `docs/`)

The `docs/` folder has 40+ archived directives + handoff notes covering completed features in full. Browse there when touching related code — naming is `DIRECTIVE-<topic>.md` (or `Directive-NN-<topic>.md` for the cards series). High-value references:

- `STATS_SCHEMA.md` — versioned `stats_json` schema (year-keyed, optional catching section)
- `project-notes.md` — accumulated Spordle / GC / D1 / R2 notes
- `DIRECTIVE-photo-vault-v4.2.md` — photo gallery + admin-photos pipeline
- `DIRECTIVE-results-worker-and-admin.md` — manual results entry stack (now fallback)
- `DIRECTIVE-live-scorebug-and-scorekeeper.md` — broadcast overlay + phone scorekeeper
- `DIRECTIVE-photo-library.md` — photo library + admin-photo-library
- `DIRECTIVE-email-router-migration.md` — `*@canonniers.ca` routing
- `Directive-01..07` (cards series) — Game Day card generator end-to-end
