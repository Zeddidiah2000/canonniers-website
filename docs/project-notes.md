# Project Notes — Canonniers Website

## 2026-04-28: Roster Update v1 (Historical Stats Injection)
- **Status:** COMPLETED.
- **Action:** Injected 2025 historical stats for 19 approved players into `alignement.html`.
- **Details:** 
  - Players processed from `u15`, `u17d1`, and `u17d2` JSON updates.
  - Validation: Passed all 14 structural checks (scripts preserved in `/scripts` for audit).
  - Git: Committed and pushed to `main`.

## 2026-04-28: Cloudflare Roster Infrastructure Upgrade
- **Status:** COMPLETED.
- **Action:** Moved roster management from static HTML to Cloudflare D1/R2.
- **Details:**
  - Infrastructure: Created `canonniers-db` (D1) and `player-photos` (R2).
  - API: Deployed `canonniers-roster-worker` for CRUD operations and image serving.
  - Management: Created `/EditRoster` portal with advanced sorting, filtering, and photo upload.
  - Frontend: Refactored `alignement.html` to be fully dynamic with `cache: 'no-store'`.
  - Migration: Successfully migrated all 47 players and their 2025 historical stats into the database.
- **Security:** Portal protected by standard admin password; photos made public via Worker routing.

## 2026-04-29: Admin Tile-Grid Refactor (3-commit sequence)
- **Status:** COMPLETED.
- **Action:** Converted `admin.html` from a multi-tool single page into a tile-grid landing hub; split tools into per-page files.
- **Details:**
  - **Commit 1:** Created `admin-social.html` — copy of old `admin.html` with Coming Soon section removed, bilingual "Admin Social" badge, back-link to `/admin.html`. `admin.html` untouched.
  - **Commit 2:** Reduced `admin.html` to tile-grid landing only. Removed post generator, game day card generator, coming soon section, and all associated JS. Added `TILES` array with 5 modules (2 active, 3 coming soon), `getCurrentRole()` with `?role=` URL param gating, `renderTiles()` / `renderTileSection()`, inline Lucide SVG icons, `escapeHtml()`. Bug fixed: session-restore block must run after `const TILES` is declared (moved to bottom of script).
  - **Commit 3:** Promoted `EditRoster/index.html` → `admin-roster.html` at repo root. Deleted `EditRoster/` entirely. Created `robots.txt` with Disallow entries for all three admin pages. `admin-roster.html` has noindex meta, bilingual "Éditeur d'alignement" badge, and back-link to admin portal.
- **D1 schema:** `height_inches INTEGER` column added (`update_schema_v2.sql`), populated from existing `height` text for Noah Chisholm (71 inches). `height` TEXT column retained for rollback.
- **Worker:** Partial PUT update pattern — allow-list prevents field-wipe on omitted keys; empty string → NULL.
- **Admin role gating:** `?role=coach` → Social Tools + Roster Editor unlocked, Photo Gallery + Team Finance locked. `?role=treasurer` → Team Finance unlocked, others locked. Full Cloudflare Access migration path documented in `docs/DIRECTIVE-admin-tile-grid-refactor.md`.

## 2026-04-30 → 2026-05-01: Cloudflare Access Authentication Migration
- **Status:** COMPLETED.
- **Directives:** `DIRECTIVE-admin-auth.md`, `DIRECTIVE-auth-fix.md` (both archived in `docs/`)
- **Action:** Replaced hardcoded password gate on `admin.html` with Cloudflare Access identity flow; removed password gates entirely from all admin sub-pages.

### canonniers-auth-worker (new Worker)
- **Deployed:** `https://canonniers-auth-worker.chisholm2000.workers.dev`
- **Source:** `workers/canonniers-auth-worker/index.js` — ES module, reads `email` query param, looks up role in `ROLE_MAP` secret (Wrangler secret, JSON string), returns `{ email, role }`.
- **ROLE_MAP secret:** 11 email → role mappings set via `npx wrangler secret put ROLE_MAP`.
- **Roles:** `admin`, `coach`, `manager`, `social`, `treasurer`.

### admin.html — identity screen
- Removed `ADMIN_PASSWORD`, `doLogin()`, `doLogout()`, `sessionStorage` check, `#login-screen` div.
- Added `#identity-screen` div: logo, email display, role badge, "Entrer →" button.
- **Two-step auth flow in `initAuth()`:**
  1. Fetch `/cdn-cgi/access/get-identity` (same-origin CF Access endpoint) → get email
  2. Fetch `canonniers-auth-worker?email=<email>` → get role
- Unknown role shows differentiated error: "Accès non autorisé · Contactez l'administrateur info@canonniers.ca"
- **Auth bug fixed mid-session:** Original design tried to pass CF Access JWT via fetch header — CF Access does NOT inject the JWT into client-side fetch calls, only server-side. Fixed by switching to identity endpoint + email query param.
- **URL fix:** Identity endpoint initially pointed to `https://quebecsports.cloudflareaccess.com/cdn-cgi/access/get-identity`; changed to same-origin `/cdn-cgi/access/get-identity`.

### admin-social.html, admin-roster.html, admin-photos.html
- Removed all password gate code from all three sub-pages: `ADMIN_PASSWORD` (or renamed to `ROSTER_TOKEN` in roster), `doLogin()`, `doLogout()`, `sessionStorage` check, `#login-screen` div, login CSS block.
- `#admin-screen` is now `display: block` by default — CF Access handles auth at the edge before page loads.
- `ADMIN_PASSWORD` in `admin-roster.html` was also used as Bearer token in API calls — renamed to `ROSTER_TOKEN`, value unchanged.
- Init functions (`loadPlayers()`, `initPage()`, `loadGames('u15')`) now called directly on page load.
- **Bug fix (2026-05-01):** Orphaned `}` left in both `admin-social.html` and `admin-roster.html` after auth block removal — broke script parsing. Removed.

### Manual step pending (Jay)
- In Cloudflare Zero Trust → Access controls → Applications → admin application → Destinations: remove `canonniers-auth-worker.chisholm2000.workers.dev` entry (causes redirect loop if present).

## 2026-04-28: Dedicated Player Profiles & Roster UI Upgrade
- **Status:** COMPLETED.
- **Action:** Migrated from stat drawers to dedicated profile pages (`joueur.html`) and improved Roster UI.
- **Details:**
  - **Database:** Added `birthdate` and `hometown` columns to the D1 `players` table.
  - **Backend:** Updated Worker API to support new player metadata.
  - **Management:** Upgraded `/EditRoster` portal with new fields and bilingual support.
  - **Profile Page:** Launched `joueur.html` featuring a hero banner, dynamic career pills (elite performance logic), and detailed 2025/2026 stats.
  - **Roster UI:** Refactored `alignement.html` with heavier visual weight, direct profile links, and mobile layout fixes (overflow-x protection and scrollable tables).
- **Git:** Pushed all fixes and new files to `main`.

