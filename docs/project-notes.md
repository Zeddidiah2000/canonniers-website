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

