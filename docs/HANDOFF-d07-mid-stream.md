# Handoff — Directive #7 Mid-Stream (commits 1–3 landed)

**Date:** 2026-05-14
**Branch:** `d07-compose-stage`
**Main HEAD:** `9646937` (commits 1–3 fast-forwarded into `main` after each commit)
**Author:** Claude Code session ending mid-D07
**For:** next Claude Code session that picks up at commit 4

---

## TL;DR

D07 (compose-stage UI in admin-social.html) is **half-built**. Commits 1, 2, 3 are merged to `main` and live on Pages. Commits 4, 5, 6, 7 are not started. Several directive instructions have been corrected mid-stream — read § Directive Corrections before picking up.

---

## What's merged to main through commit 3

All on `main`, fast-forwarded from `d07-compose-stage` after each commit. Pages auto-deploys main on push.

| SHA | Title | Files touched | What it does |
|---|---|---|---|
| `8bdee20` | D07 commit 1 — library-worker filters + cutout generation | `workers/library/src/index.js`, `workers/library/wrangler.toml`, `update_schema_v8_library_cutouts.sql` (new) | Adds `cutout_r2_key` column to `photo_library`; extends `GET /api/library` with `?team=`, `?player_id=`, `?type=cutout` filters (legacy `?filter=` preserved); adds `POST /api/library/:id/generate-cutout` (idempotent via cached `cutout_r2_key`, calls `canonniers-claude-proxy/removebg`, stores result at `canonniers-cards/cutouts/{uuid}.png`); adds `CARDS_BUCKET` R2 binding |
| `409253e` | D07 commit 2 — compose-stage scaffold + team header + template picker | `admin-social.html` (+410 lines) | New `<section id="compose-stage">` below the existing /removebg card-generator section. Sticky team-selector header populated from auth-worker (JWT email → role/teams), 4-tile template picker (game-day-v2, blueprint, result, hype), composeState persisted to sessionStorage |
| `9646937` | D07 commit 3 — step-2 field forms + client validation | `admin-social.html` (+511 / -5) | Step-2 form replaces placeholder. Common fields (opponent_name, game_date, game_time, venue_name, is_home toggle, opponent_logo_url) + result-specific block (title_line_1, title_line_2, title_pill_text, vs_divider_text, score_canonniers, score_opponent). Client-side validation mirrors render.ts (max lengths, date/time formats, https URL, int 0–999). FR/EN inline errors. Back button warns + clears result-specific data on template switch. Continue button gated on opponent_name + game_date (+ title_line_1 if result) |

**Also on main (from D06 work that landed pre-D07):** `d757b25` (templates), `d9a6a27` (D06 archive), `aca2341` (Hype design refresh).

---

## Worker / infrastructure state

### Deployment versions (rollback targets)

| Worker | Current version | Deployed |
|---|---|---|
| `canonniers-cards-worker` | `ab99c91f-d6b6-4739-82da-b299805b4f63` | 2026-05-14 (Hype refresh — pre-D07) |
| `canonniers-library-worker` | `b8debbf2-fa85-4249-941e-38a0231b96f7` | 2026-05-14 (D07 commit 1) |

**D07 has not deployed cards-worker yet.** That happens in commit 7.

### D1 — `canonniers-db`

- **Schema version applied:** v8 (`update_schema_v8_library_cutouts.sql`, committed in `8bdee20`)
- **Last backup pre-v8:** `canonniers-backups/canonniers-db-pre-v8-20260513-234441.sql` (194KB)
- `photo_library.cutout_r2_key TEXT NULL` exists
- `generated_cards` schema (verified live via PRAGMA): already has `created_by NOT NULL`, `deleted_at NULL`, `published NOT NULL DEFAULT 0`, `archived NOT NULL DEFAULT 0`, `content_hash NULL`. **No further schema migration needed for D07** — see directive correction #2 below.

### R2

- `canonniers-cards` bucket now bound to library-worker as `env.CARDS_BUCKET` (writes to `cutouts/` prefix)
- Test assets all 200: `test/test-cutout.png`, `test/test-opponent-logo.png` (uploaded fresh 2026-05-14, 229KB version), `logos/canonniers.png`

---

## Directive corrections (do NOT follow the original directive on these points)

These were discovered during D07 pre-flight and approved by Jay. The original `DIRECTIVE-07-compose-stage.md` text in `docs/` is unchanged — follow these overrides instead.

### 1. `/list` endpoint shape — **option B (separate endpoints)**
Original directive said extend `/list?scope=mine|all`. **Override:**
- Keep existing `GET /list?game_id=X[&published=1]` unchanged (it powers public game-page card lookups)
- **Commit 7 adds two NEW endpoints alongside it:**
  - `GET /list/mine` → `WHERE created_by = caller_email AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`
  - `GET /list/all` → admin-only; if caller role ≠ admin, silently return mine
- Reason: game-page lookups (by game_id) and user-history lookups (by caller email) are different use cases with different sort/filter needs; coupling via a `?mode=` param would complicate the handler.

### 2. Drop commit 7 schema migration entirely
Original directive said `ALTER TABLE generated_cards ADD COLUMN created_by`, `ADD COLUMN deleted_at`. **Override: DO NOT add these — they already exist.** `created_by` is even `NOT NULL` (the directive assumed NULL). `render.ts:428` already binds caller email. The migration is fully redundant.

### 3. Drop commit 1 "loosen role check on /upload"
Original directive said loosen `POST /api/library/upload` from admin-only to `admin|coach|social`. **Override: dropped — no-op.** Library-worker's `getCallerIdentity` returns `role: 'admin'` for every valid bearer-token caller (line 53). The `caller.role !== 'admin'` check at line 212 never fires for token-bearing callers. Nothing to loosen until library-worker gets real per-user role gating (separate future directive).

### 4. `/removebg` worker URL — `canonniers-claude-proxy`, NOT `spordle-proxy`
Original directive said "via spordle-proxy worker /removebg endpoint" (line 112). **Override:** the actual worker is `https://canonniers-claude-proxy.chisholm2000.workers.dev/removebg`. CLAUDE.md memory was out of date. Memory fixed in `project_tech_stack.md` this session. Library-worker's generate-cutout endpoint (already shipped in commit 1) calls the correct URL.

### 5. Cutout storage — `canonniers-cards/cutouts/{uuid}.png` (public bucket)
Original directive said `library/cutouts/{uuid}.png` (private library bucket). **Override:** cutouts must be Puppeteer-reachable WITHOUT auth headers (browser-inside-Puppeteer fetches `<img src>`). Library bucket is bearer-token-gated. **Solution implemented in commit 1:** store cutouts in `canonniers-cards` R2 (which has public domain binding at `cards.canonniersdequebec.ca`), at key `cutouts/{uuid}.png`. Same privacy posture as generated cards (unguessable keys, no auth gate, no enumeration risk).

### 6. Spordle logo coverage = 100%
Pre-flight check across all 128 upcoming games for u15/u17d1/u17d2 found `logoUrl` populated on every opponent. **Commit 4 does NOT need a first-class "manual logo paste" UI** per the directive's 80% rule. Keep manual paste as a hidden override that auto-shows only when a future game returns null logoUrl (defensive, free). Don't make it primary UX.

---

## Mid-stream decisions (Jay's calls — overrides to defaults)

| Topic | Decision |
|---|---|
| Smoke tests per commit | **Skipped** for commits 2 and 3 (Jay: "no smoke test"). Commit 1 had a single 200-check curl on extended GET. Resume smoke testing in commits 4+ at Jay's call. |
| Branch flow | **Fast-forward main after each commit**, not after end-to-end. Jay's call: "push, merge to main". Each commit is independently safe (additive, no breaking changes). |
| Watermark loss on cutouts | **Accepted.** remove.bg strips photographer watermark; cards don't display photographer credit anyway. No re-watermarking pipeline. |
| Open auth-worker `?email=` endpoint | **Accepted as known-low-risk.** Anyone can query any email's role/teams. Threat model: leaks role/team membership, not credentials or data. Logged in `memory/project_future_hardening.md` as item 2a. Not scheduled for fix. |
| Open `canonniers-claude-proxy/removebg` endpoint | **Accepted as known cost-exposure.** Anyone can burn remove.bg credits. Logged in `memory/project_future_hardening.md` item 1. Capped by remove.bg monthly credit limit; not scheduled for fix. |
| Frontend → auth-worker call from admin-social | Admin-social decodes the CF Access JWT client-side (base64) to get the user email, then calls auth-worker `?email=` to get role/teams. Trust boundary remains the workers (cards-worker re-verifies JWT on /render). Frontend call is UI-display only. |
| Compose UI placement | New section below the existing /removebg / canvas card-generator section. Both flows visible on the same page. /removebg flow untouched. |
| Team selector | Sticky header element across all compose steps, scoped to `auth-worker.teams`. Single-team users see one option (defaulted); multi-team users see "— Choisir une équipe —" placeholder until they pick. Disabled until auth-worker resolves. |
| Compose state model | `composeState = { team, template, content, cutout }` persisted to sessionStorage keys `compose-stage:state` and `compose-stage:team`. State auto-restores on page refresh; user picks up where they left off. "Réinitialiser" clears template/content/cutout but keeps team. |
| Cache surface to users | Hidden. `/render` returns cached URLs silently. `cached: true` stays in JSON response for debugging but no UI badge. |
| `published`/`archived` columns on `generated_cards` | D07 cards default to `published=0, archived=0` (schema defaults). Compose flow ignores both. `/list/mine` and `/list/all` filter only on `created_by` + `deleted_at`. **Side effect:** compose-rendered cards are NOT visible on public game pages (which filter `WHERE published=1`). If "publish to game page" is wanted later, that's a separate small directive. |
| Bilingual scope | **FR only for D07** per Jay's deadline-pressure call. Schema headroom (`lang: 'fr' | 'en'`) preserved. EN labels + template placeholder refactor = separate future directive. See `memory/feedback_bilingual_law.md` + `memory/project_en_compliance_debt.md`. |

---

## Compose state model (live shape in admin-social.html)

```js
// sessionStorage keys
const COMPOSE_STATE_KEY = 'compose-stage:state';
const COMPOSE_TEAM_KEY  = 'compose-stage:team';

// shape
composeState = {
  team: 'u15' | 'u17d1' | 'u17d2' | null,
  template: 'game-day-v2' | 'blueprint' | 'result' | 'hype' | null,
  content: {
    // Common fields (all templates)
    opponent_name: string | null,
    game_date: 'YYYY-MM-DD' | null,
    game_time: 'HH:MM' | null,
    venue_name: string | null,
    is_home: boolean,                // default true
    opponent_logo_url: string | null, // must startsWith 'https://' if set
    // Result-only (only populated when template === 'result')
    title_line_1: string | null,
    title_line_2: string | null,
    title_pill_text: string | null,
    vs_divider_text: string | null,
    score_canonniers: number | null,  // integer 0-999
    score_opponent: number | null,    // integer 0-999
  },
  cutout: null,  // populated in commit 5
};

// Auth context (in-memory, not persisted)
composeAuthContext = {
  email: string,
  role: 'admin' | 'coach' | 'social' | 'manager' | 'photo' | 'treasurer' | 'unknown',
  teams: ('u15' | 'u17d1' | 'u17d2')[],
};
```

**Field validation constants (from render.ts ground truth):**
- `opponent_name`: required, ≤80 chars
- `game_date`: required, regex `^\d{4}-\d{2}-\d{2}$`
- `game_time`: optional, regex `^\d{2}:\d{2}$`
- `opponent_logo_url`: optional, must startsWith `https://`
- `title_line_1`: required when `template === 'result'`, ≤80
- `title_line_2`: optional, ≤80
- `title_pill_text`: optional, ≤40
- `vs_divider_text`: optional, ≤20
- `score_canonniers`, `score_opponent`: optional, integer 0–999

---

## Current state of commit 4 (NOT STARTED)

**Locked scope** (per directive + mid-stream decisions):

- Add "Pick from schedule" / "Manual entry" toggle at top of step-2's field form
- Spordle picker UI:
  - Dropdown of upcoming games for `composeState.team`
  - URL: `GET https://spordle-proxy.chisholm2000.workers.dev?officeId=4168&teamId={156779|156780|156781}` (u15=156779, u17d1=156780, u17d2=156781)
  - Reference invocation: `calendrier.html:620`
  - Per-option format: `2026-05-24 14:00 · vs Vipères de Saint-Eustache · Stade Canac`
  - Selecting a game autofills: `opponent_name`, `game_date`, `game_time`, `venue_name`, `is_home`, `opponent_logo_url`
- Logo field name: `homeTeam.logoUrl` or `awayTeam.logoUrl` (string). **`logoId` is null on every game — use `logoUrl` exclusively.**
- 100% Spordle logo coverage confirmed → manual paste fallback stays as hidden override (auto-shows if a future game returns null logoUrl). Not primary UX.
- Toggle switching: Manual ↔ Spordle. Manual mode hides picker; fields stay user-editable.
- Even in Spordle mode, all autofilled fields stay user-editable (override is first-class).
- No worker changes. Pure UI + Spordle proxy call.
- File: `admin-social.html` only.

**Open questions for commit 4 execution:**

1. **UI placement of the toggle:** above the form (= the picker is the default entry point) or below the opponent_name field (= manual stays default)? My read: top of form, "Pick from schedule" defaulted ON when user just transitioned from step 1, so picker shows first.
2. **Failure modes:** if Spordle proxy is down or returns empty, what does the UI show? Recommendation: show a "Spordle indisponible — saisie manuelle" message + auto-switch toggle to Manual mode. Don't hard-fail.
3. **Game-not-on-Spordle case:** per locked scope ("Free-form manual entry as fallback for unscheduled games") — the manual mode is the answer. Confirm.
4. **Spordle date format quirk:** the proxy returns ISO timestamps. Need to split into `YYYY-MM-DD` (game_date) + `HH:MM` (game_time). Verify the timezone — Quebec games are EST/EDT; if proxy returns UTC, may need offset.
5. **`is_home` derivation:** if Canonniers is `homeTeam` in the game payload → `is_home: true`. If `awayTeam` → false. Spordle proxy returns both teams' info; need to identify which is the Canonniers side (by `teamId` matching the selected team's known ID).
6. **State reset on Spordle pick:** when user picks a game from the dropdown, should we overwrite ALL filled fields silently, or confirm if any are non-default? Recommendation: silently overwrite when in Spordle mode (that's the point of picking); user can edit any field after.

**Suggested commit 4 file changes:**
- `admin-social.html` only (CSS + HTML + JS for picker UI)
- ~200-300 lines added
- No worker changes
- No D1 / R2 changes

---

## Pending commits (after 4)

| # | Scope | Files |
|---|---|---|
| 5 | Step-3 cutout picker (library mode + upload-on-the-fly mode) + client-side drag/scale preview (port `CUTOUT_PRESETS` + `anchorToTranslate` to JS helper from `workers/canonniers-cards-worker/src/render.ts`). Cutout grid calls `GET /api/library?team={team}&type=cutout`. Upload mode → `POST /api/library/upload` → `POST /api/library/:id/generate-cutout` → use returned URL. | `admin-social.html` |
| 6 | Step-4 render submit + "My Cards" list. CF Access JWT pattern, `composeStateToPayload()` mapper, render call to cards-worker /render, soft-delete via DELETE button. | `admin-social.html` |
| 7 | cards-worker server-side enforcement (role gate on /render, team_id ∈ caller.teams check) + new `/list/mine` + `/list/all` endpoints + DELETE `/api/cards/:id` soft-delete. **No D1 migration** (columns already exist). | `workers/canonniers-cards-worker/src/index.ts`, `src/handlers/list.ts` (new file `list-mine.ts` or extend existing), new soft-delete handler |

---

## Memory files updated this session

- `MEMORY.md` — added entries for bilingual law, EN compliance debt, future hardening
- `feedback_bilingual_law.md` (new) — never recommend FR-only as final state; Jay-override clause added later
- `project_en_compliance_debt.md` (new) — D07 ships FR-only by Jay's explicit decision
- `project_future_hardening.md` (new) — open /removebg, open auth-worker ?email=, library-worker bearer=admin, soft-delete R2 leak
- `project_tech_stack.md` — fixed CLAUDE.md drift: /removebg lives on `canonniers-claude-proxy`, not `spordle-proxy`

---

## Known not-D07 items in the working tree

- `workers/canonniers-cards-worker/templates/cards/game-day/test-assets/test-opponent-logo.png` shows as locally modified (24,609 → 229,157 bytes). This is a pre-existing local working-tree change from before D07 started. Kept unstaged across all D07 commits. Not part of D07 scope.
- `.claude/settings.local.json` (untracked) — Claude Code session settings, ignored.

---

## Where to pick up

```powershell
cd "C:\Users\Potato\Documents\Canonniers Website\repo-working"
git fetch --all --prune
git checkout d07-compose-stage
git log --oneline -8       # confirm last commit is 9646937
# main should be at the same SHA (FF'd after each commit)
```

Read this handoff. Then read the original directive at `docs/DIRECTIVE-07-compose-stage.md` for commit 4 spec, applying the corrections in § Directive Corrections above. Pre-flight is light — Spordle URL pattern is at `calendrier.html:620`, logo field is `logoUrl`, all infrastructure is in place. Patch lives entirely in `admin-social.html`.

Commit 4 commit message convention (matches commits 1–3):
```
feat(admin-social): Spordle game picker autofill (D07 commit 4)
```

After patching: dry-test in browser at canonniersdequebec.ca/admin-social.html (Pages auto-deploys main after each FF). Confirm with Jay before committing if UI placement decisions need his sign-off. Push to d07-compose-stage, FF main, push main.

---

**End of handoff.**
