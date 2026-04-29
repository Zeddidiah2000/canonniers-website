# Canonniers de Québec — Project Handoff

> **Audience:** Claude Code (or any future AI assistant / developer picking up this project).
> **Purpose:** Complete operational memory for the unofficial fan website at **canonniersdequebec.ca**.
> Read this file **first** at the start of every session. Treat it as the source of truth for context, conventions, and gotchas.

---

## 1. Project Identity

- **Site:** https://canonniersdequebec.ca (also `www.canonniersdequebec.ca` → 301 to apex)
- **Organization:** Canonniers de Québec — a Quebec AAA baseball program with three teams:
  - **15U AAA** (Spordle team ID `156779`)
  - **17U Division 1** (Spordle team ID `156780`)
  - **17U Division 2** (Spordle team ID `156781`)
- **Status:** Strictly **UNOFFICIAL fan site.** This framing must be preserved everywhere. Never imply the site is operated by the association.
- **Language:** Fully bilingual — every piece of user-facing content has a French (québécois register, not international French) and an English version. Both are in the DOM; visibility is toggled by `body.lang-fr` / `body.lang-en` CSS classes via `localStorage` key `lang`.
- **Owner / Maintainer:** Jay (newer to web dev, but rapidly skilled up across this project). Collaborates with **JP**, who handles the Facebook page and leads the association.

---

## 2. Tech Stack

| Layer | Tech |
|---|---|
| Frontend | Static HTML / CSS / vanilla JS (no framework, no build step) |
| Hosting | Cloudflare Pages (Git-integrated to GitHub repo `canonniers-website`, public, branch `main`) |
| Server logic | Cloudflare Workers (multiple) |
| Database | Cloudflare D1 (SQL) for Roster data |
| Storage | Cloudflare R2 for Player Photos |
| Live data | Spordle public API (`pub-api.play.spordle.com`) |
| AI | Anthropic Claude API (`claude-sonnet-4-5`) via Worker proxy |
| Image processing | remove.bg API via Worker proxy (`/removebg` route) |
| Streaming | Cloudflare Stream (Live Inputs + recorded videos) |
| Calendar feeds | Cloudflare Worker generating `.ics` files |

**Deployment flow:** push to GitHub `main` → Cloudflare Pages auto-deploys to canonniersdequebec.ca.

---

## 3. File Inventory

| File | Role |
|---|---|
| `index.html` | Bilingual homepage — hero, stats strip, news cards, sidebar with upcoming games. |
| `calendrier.html` | Live schedule page — Spordle data via Worker proxy. |
| `alignement.html` | Dynamic Roster page — Fetches from D1 Worker; direct links to profiles. |
| `joueur.html` | **New** Player Profile page — Hero banner, dynamic career pills, detailed stats. |
| `diffusion.html` | Live streaming page — Cloudflare Stream integration. |
| `admin.html` | Bilingual Admin: FB Post Gen (Claude) + Game Day Card Gen (PNG). |
| `EditRoster/index.html` | Roster Management: Full CRUD for players + R2 photo upload. |
| `src/index.js` | `canonniers-roster-worker` — API for D1 (Players) and R2 (Photos). |
| `spordle-worker.js` | Cloudflare Worker — Spordle proxy. |
| `ical-worker.js` | Cloudflare Worker — iCal feed generator. |

---

## 4. Design System & Conventions

### Palette & Typography
- Navy (`#0d1f4e`), Sky Blue (`#6ab0d4`), White.
- `Barlow Condensed` for headings/UI (700-900, uppercase).

### Bilingual Pattern
- Every string: `<span class="fr-text">…</span><span class="en-text">…</span>`.
- JS/CSS toggles via `body.lang-fr/en`.
- French must be **québécois** (e.g., "Alignement", "Calendrier").

---

## 5. Roster System (D1/R2)

### `canonniers-roster-worker`
- **Public Routes:**
  - `GET /api/players` - Returns all players + `stats_json`. Uses `cache: 'no-store'`.
  - `GET /api/photos/:filename` - Public access to player images in R2.
- **Protected Routes** (Requires `Authorization: Bearer canonniers2026`):
  - `POST/PUT/DELETE /api/players` - CRUD operations (Supports `birthdate`, `hometown`).
  - `POST /api/upload` - Handles file uploads to R2.

### `alignement.html`
- Fetches data dynamically from the worker.
- **Navigation:** Clicking a player row navigates to `joueur.html?id=[id]`.
- **Mobile:** Uses horizontal scroll containers (`.table-container`) to prevent layout spill.
- **Caching:** Uses `cache: 'no-store'` in fetch to reflect `/EditRoster` changes instantly.

### `joueur.html`
- **Career Pills:** Dynamic "Elite" stat highlights (AVG >= .300, OPS >= .850, ERA <= 3.50, etc.) or fallback top-3 unique metrics.
- **Stats:** Shows "2026 Season" placeholder and full "2025 Season" historical data from `stats_json`.
- **Layout:** High-impact hero banner with jersey number circle and mobile-optimized viewport lockdown.

### `/EditRoster`
- Secure management portal.
- **Fields:** Supports name, number, position, B/T, height, weight, **birthdate**, and **hometown**.
- **Sorting:** Interactive column headers (Number, Name, Position, Team). 
- **Name Sorting:** Sorts by **Last Name** (last word in string).
- **Filtering:** Team-based pills (15U, 17U D1, 17U D2).

---

## 6. Critical Gotchas

- **Worker Routing:** Photos must be served from a **Public** route in the Worker to show on the site (fixed Noah Chisholm issue).
- **Accents:** Migration scripts use accent-normalized matching for French names.
- **Bilingual Dynamic Injection:** Always wrap dynamic JS output in `fr-text`/`en-text` spans to avoid mixed-language bugs.
- **Spordle:** `include` array is sensitive. Do not include `venue` (causes 500s).
- **Mobile Spill:** Wide tables must always be wrapped in `<div class="table-container" style="overflow-x: auto;">` to prevent horizontal layout breaks.

---

## 7. Backlog

- [ ] **Security:** Transition from static password to **Cloudflare Access** for `/admin.html` and `/EditRoster`.
- [ ] **Photo Polish:** Add automatic background removal to the `/EditRoster` upload flow (currently only on Game Day cards).
- [ ] **Stats Automation:** Move from historical JSON sources to a real-time 2026 stat update worker.

---

*Last updated: April 28, 2026 (Player Profiles & Roster UI Upgrade complete).*
