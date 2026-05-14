# Directive #7 — D03 Compose Stage UI in admin-social

**Date drafted:** 2026-05-13
**Author:** Claude (web architect session)
**Executor:** Claude Code
**Scope:** Multi-commit feature branch `d07-compose-stage`. Library-worker additions + admin-social.html compose UI + cards-worker list endpoint wiring. FR only. Merge to main after end-to-end smoke pass.

---

## Goal

Replace the DevTools-fetch smoke-test pattern with a real UI in `admin-social.html` so Jay (and authorized coaches/social) can compose, preview, and render cards with cutouts via the actual tool. No 5th template. No bilingual. No FB auto-post.

---

## Locked scope (from D07 planning, do NOT re-litigate)

- **Languages:** FR only. D06 templates stay hardcoded. `lang` field stays in schema for future use.
- **Cutout source:** Photo Library (primary) + upload-on-the-fly (escape hatch).
- **Opponent picker:** Spordle game picker fills opponent + date + time + venue + is_home in one click. Free-form manual entry as fallback for unscheduled games.
- **Drag/resize:** Client-side preview only. Worker render on "Update preview" / "Save" button.
- **Cutouts per card:** 1 slot in UI, schema cap stays at 2.
- **Card history:** "My Cards" list backed by `generated_cards` D1 table.
- **Template selection:** Template-first stepper. Hide deprecated `game-day` (v1). Show `game-day-v2`, `blueprint`, `result`, `hype`.
- **Team selector:** Sticky header across all steps, scoped to user's authorized teams.
- **Mobile:** Desktop-first, mobile-tolerant.
- **Cache surface:** Hidden. Cached URL returned silently.
- **Compose access:** `admin | coach | social` roles only. Server-side enforced.
- **Cutout flow:** Library is sole source for cards. Existing `/removebg` flow stays alive but is not touched.
- **No status column** on `generated_cards`. Soft delete via `deleted_at` only.

---

## Pre-flight (mandatory)

### 1. Branch + worker state

```powershell
cd <repo-root>
git fetch --all --prune
git checkout main
git pull
git checkout -b d07-compose-stage
```

Capture current deployed worker versions for rollback:

```powershell
cd workers/canonniers-cards-worker
wrangler deployments list
# capture top version ID

cd ../canonniers-library-worker
wrangler deployments list
# capture top version ID
```

### 2. Read source files

Read and report back the current state of:

- `workers/canonniers-library-worker/src/index.js` — confirm endpoint inventory matches the planning notes (GET `/api/library?filter=`, POST `/api/library/upload`, assign-player, assign-coach). Identify the schema (column list).
- `workers/canonniers-auth-worker/index.js` — confirm `{role, teams}` response shape. Capture the exact role enum and how teams array is formatted.
- `workers/canonniers-cards-worker/src/render.ts` — confirm `validateRenderRequest()` field names, cutout `preset` enum values, and `CUTOUT_PRESETS` coordinate map.
- `workers/canonniers-cards-worker/src/handlers/list.ts` — confirm what's already there (handoff said "partially wired"). Report the current shape.
- `admin-social.html` — current state of the page. Identify the existing `/removebg` flow code (do NOT touch it). Identify where compose UI will slot in (new section vs. replace existing).

### 3. Spordle logo coverage check

Non-optional. Query Spordle for 5-10 upcoming opponents for u15 (team_id=156779), u17d1 (156780), u17d2 (156781). For each game payload, check whether the opponent object carries a logo URL field. Report:

- Coverage % overall (across all three teams' upcoming games)
- Which field on the Spordle response carries the logo (or "none")
- Sample payloads (truncated, just the team/opponent objects)

**Decision rule:** if coverage <80%, the Spordle picker MUST include a "logo override / manual paste" field as first-class UI in commit 4. Report coverage before patching commit 4.

### 4. Existing test assets in R2

Confirm still present:
- `https://cards.canonniersdequebec.ca/test/test-cutout.png`
- `https://cards.canonniersdequebec.ca/test/test-opponent-logo.png`
- `https://cards.canonniersdequebec.ca/logos/canonniers.png`

---

## Commit plan (multi-commit on `d07-compose-stage`)

Each commit is independently deployable + smoke-testable in browser. Push branch after each commit. Final merge to main after end-to-end pass.

### Commit 1 — library-worker: filters + cutout generation

**Schema:**
```sql
ALTER TABLE photo_library ADD COLUMN cutout_r2_key TEXT NULL;
```

Migration file: `update_schema_v8_library_cutouts.sql`. Backup D1 to `..\canonniers-backups\` before applying (memory convention).

**Endpoints to add:**

- `GET /api/library?team=u15&player_id=42&type=cutout`
  - `team` filter: server-side JSON contains check against `linked_teams`
  - `player_id` filter: server-side JSON contains check against `linked_player_ids`
  - `type=cutout` filter: rows where `cutout_r2_key IS NOT NULL`
  - All three filters AND-combined when multiple passed
  - Existing `?filter=` param stays for backwards compat with admin-roster/admin-coaches

- `POST /api/library/:id/generate-cutout`
  - Auth: `LIBRARY_TOKEN` bearer (existing convention)
  - Reads original from library R2
  - Calls remove.bg via spordle-proxy worker `/removebg` endpoint
  - Stores result at `library/cutouts/{uuid}.png`
  - Updates row's `cutout_r2_key`
  - Returns `{ cutout_url, cutout_r2_key }`
  - Idempotent: if `cutout_r2_key` already present, return existing URL without re-calling remove.bg

- `POST /api/library/upload` (existing endpoint — modify)
  - Loosen role check from admin-only to `admin | coach | social`
  - All other behavior unchanged

**Smoke test (commit 1):**

```powershell
# 1. Confirm filter works
curl.exe -H "Authorization: Bearer $env:LIBRARY_TOKEN" `
  "https://canonniers-library-worker.chisholm2000.workers.dev/api/library?team=u15"

# 2. Confirm cutout generation works (pick an existing photo_library row ID)
curl.exe -X POST -H "Authorization: Bearer $env:LIBRARY_TOKEN" `
  "https://canonniers-library-worker.chisholm2000.workers.dev/api/library/{id}/generate-cutout"
# Expect: {cutout_url: "...", cutout_r2_key: "library/cutouts/..."}

# 3. Confirm idempotency — call generate-cutout again on same ID
# Expect: same URL returned, no second remove.bg call (check spordle-proxy logs for call count)
```

Pass = all three return expected results. Deploy library-worker. Push commit.

---

### Commit 2 — admin-social: compose section scaffold + team header + template picker

Add a new `<section id="compose-stage">` to `admin-social.html`. Do NOT touch the existing `/removebg` flow code. Place compose section above or below it (Jay's preference — flag for decision during execution).

**Layout:**

- **Sticky header bar** (top of compose section): team selector dropdown + "compose a card" label
  - Team options populated from `auth-worker.teams` response
  - Single-team users: dropdown shows one team, defaulted
  - Multi-team users: real choice, no default
  - Selection persists in `sessionStorage` keyed by `compose-stage:team`

- **Step 1 — Template picker:**
  - 4-tile grid: game-day-v2, blueprint, result, hype
  - Each tile: template name, one-line description, thumbnail (use a placeholder gradient if no thumbnail asset exists yet)
  - Click tile → step 2

**State model:**
- Single JS object `composeState = { team, template, content: {}, cutout: null }`
- Persisted to `sessionStorage` keyed by `compose-stage:state`
- Restored on page load; "Reset" button clears

**No worker calls yet** in this commit. Pure UI scaffold + state.

**Smoke test (commit 2):** Open admin-social.html. Confirm team header populates from auth. Click each template tile. Confirm state persists across refresh. No console errors.

---

### Commit 3 — admin-social: template-specific field forms

For each template, render the appropriate field form in step 2. Use real `validateRenderRequest()` field names from pre-flight step 2.

**Common fields (all templates):**
- `game_date` — `<input type="date">`
- `game_time` — `<input type="time">`
- `venue_name` — text input
- `is_home` — checkbox/toggle
- `opponent_name` — text input
- `opponent_logo_url` — text input (manual paste; Spordle picker in commit 4 will autofill)

**Template-specific fields:**
- `game-day-v2`: no extras
- `blueprint`: no extras (subtitle interpolates opponent_name)
- `result`: `title_line_1`, `title_line_2`, `title_pill_text`, `score_canonniers`, `score_opponent`, `vs_divider_text`
- `hype`: no extras

**"Back to template picker" button** at top of step 2. Warns if state would be lost (only if template-specific fields are filled).

**Validation:** mirror render.ts validation client-side (max lengths, required fields, date format). Display inline errors.

**No worker calls yet.** Form state writes to `composeState.content`.

**Smoke test (commit 3):** Pick each template. Confirm correct fields appear. Fill fields. Refresh page. Confirm state restored. No console errors.

---

### Commit 4 — admin-social: Spordle game picker integration

Add a "Pick from schedule" / "Manual entry" toggle at the top of step 2's field form.

**Picker UI:**
- Dropdown of upcoming games for the selected team from the existing Spordle proxy worker
- Format per option: `2026-05-24 14:00 · vs Vipères de Saint-Eustache · Stade Canac`
- Selecting a game autofills: `opponent_name`, `game_date`, `game_time`, `venue_name`, `is_home`
- If Spordle coverage check (pre-flight step 3) shows opponents have logos, also autofill `opponent_logo_url`. Otherwise leave manual.

**Manual entry mode:** picker hidden, fields editable directly. Toggle switches between modes.

**Edge case (logo coverage <80%):** even when "Pick from schedule" is selected, `opponent_logo_url` remains user-editable and shows a "logo not auto-detected — paste a URL" hint when Spordle didn't return one.

**Smoke test (commit 4):** Switch to Spordle picker, pick a game, confirm all fields populate. Switch back to manual, confirm fields editable. Confirm logo override works when Spordle has no logo for an opponent.

---

### Commit 5 — admin-social: cutout picker + client-side drag/scale preview

**Step 3 — Cutout:**

- **Source selector:** "From library" / "Upload new" toggle
- **Library mode:**
  - Calls `GET /api/library?team={selected_team}&type=cutout`
  - Grid of thumbnails (filename or player name as label)
  - Click thumbnail → selected
  - "Generate cutout" button next to non-cutout photos (`type=cutout` filter inverted), calls `POST /api/library/:id/generate-cutout`, then refreshes the grid
- **Upload mode:**
  - File input → POST to `/api/library/upload` → server returns library row ID → call `generate-cutout` → use returned URL
  - Uploaded photo defaults to `unassigned` (no linked player/coach), can be assigned later via admin-roster/admin-coaches

**Client-side preview pane:**

- Static card backdrop (use a pre-rendered "blank template" PNG per template, generated once and stored at `https://cards.canonniersdequebec.ca/previews/{template}.png` — or fall back to a CSS-styled placeholder)
- Cutout positioned absolutely on top, `cursor: move`
- `mousedown` + `mousemove` deltas update `composeState.cutout.x_offset` / `y_offset`
- Scale slider (range input, 0.5–2.0) updates `scale_override`
- Preset dropdown for slot selection (`center-top-tall`, `behind-score-band`, `left-half-tall`, `right-action`) — defaults per template
- Port `CUTOUT_PRESETS` + `anchorToTranslate` from render.ts to a JS helper so client preview math matches worker output

**No worker render call in this commit.** Preview is local CSS positioning only.

**Smoke test (commit 5):** Pick a photo from library. Drag it. Scale it. Confirm offsets/scale update state. Upload a new photo. Confirm cutout generation runs. Confirm position state persists across refresh.

---

### Commit 6 — admin-social: render submit + "My Cards" list

**Step 4 — Preview/Render/Save:**

- "Update preview" button → calls `POST /render` on cards-worker with current `composeState`
- Shows returned PNG URL inline (loads as `<img>`)
- "Copy URL" button (clipboard copy)
- "Render again" button (re-submits, useful after editing fields)

**Render call uses CF Access JWT pattern from D05/D06:**

```javascript
const jwt = document.cookie.split('CF_Authorization=')[1]?.split(';')[0] || '';
const r = await fetch('https://canonniers-cards-worker.chisholm2000.workers.dev/render', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Cf-Access-Jwt-Assertion': jwt
  },
  body: JSON.stringify(composeStateToPayload(composeState))
});
```

`composeStateToPayload()` maps internal state to the real `validateRenderRequest()` contract.

**Cached responses:** if `cached: true`, hide that fact. Just show the URL. (Keep `cached: true` in console.log for debugging.)

**"My Cards" section** (separate from compose flow, e.g. tab or scrollable section below):

- Calls cards-worker `GET /api/cards/list?scope=mine` (commit 7 wires this — for now stub the endpoint or call list.ts as it currently exists)
- Renders cards in a grid: thumbnail (the PNG itself), template name, opponent, date, "Copy URL" + "Delete" buttons
- Delete = soft delete (PATCH or DELETE setting `deleted_at`)
- Admin users see a "View all teams' cards" toggle that adds `?scope=all` to the request

**Smoke test (commit 6):** Compose a full card end-to-end via UI. Confirm render returns PNG. Confirm "My Cards" list shows the new card. Compose a second identical card — confirm cached URL returned (no duplicate row). Soft-delete a card, confirm it disappears from list.

---

### Commit 7 — cards-worker: handlers/list.ts wiring + server-side scope enforcement

Modifications to `canonniers-cards-worker`:

**1. `created_by` column on `generated_cards`:**

```sql
ALTER TABLE generated_cards ADD COLUMN created_by TEXT NULL;
ALTER TABLE generated_cards ADD COLUMN deleted_at TEXT NULL;
```

Migration file: `update_schema_v6_compose_metadata.sql`. Backup D1 first.

Existing rows: `created_by = 'system'` (orphaned to system, not visible in any user's "My Cards").

**2. Render endpoint extension:**

Modify `/render` handler to:
- Extract caller email from CF Access JWT (verification already happens — extend to capture email claim)
- Verify caller role ∈ `{admin, coach, social}` — reject 403 otherwise
- Verify `team_id` ∈ caller.teams from auth-worker service binding — reject 403 otherwise UNLESS role is admin
- Write `created_by = caller_email` on insert

**3. `/api/cards/list` endpoint** (finish `handlers/list.ts`):

- `GET /api/cards/list?scope=mine` (default) — `WHERE created_by = caller_email AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`
- `GET /api/cards/list?scope=all` — admin-only. If caller role ≠ admin, silently ignore and return mine.
- Returns: `[{card_id, template, variant, team_id, url, created_at, created_by, content_summary}]`

**4. Soft delete endpoint:**

- `DELETE /api/cards/:card_id` — caller must own the card OR be admin. Sets `deleted_at = NOW()`. Does not delete R2 object (preserves URLs that may already be shared externally).

**Smoke test (commit 7):**

- Render a card as coach user → confirm `created_by` populated
- List cards as same coach → confirm only their cards returned
- List cards as admin with `?scope=all` → confirm all cards returned
- List cards as coach with `?scope=all` → confirm silently degraded to mine
- Render with team_id outside caller.teams as coach → confirm 403
- Render same payload as admin → confirm success
- Soft-delete a card as owner → confirm gone from list, R2 PNG still accessible directly

---

## End-to-end smoke test (before merge to main)

After commit 7 is deployed:

1. Sign in to admin-social.html as admin user.
2. Compose a `hype` card for u15 vs a Spordle-scheduled opponent. Use a library cutout.
3. Confirm render returns PNG URL. Verify visual correctness against D06 standards.
4. Compose a second card, `result` template, with `title_line_1` / `title_line_2` / scores filled.
5. Open "My Cards", confirm both visible.
6. Sign out, sign in as a coach user (test account if available). Confirm only their own cards visible.
7. Mobile check: open admin-social.html on phone, confirm "My Cards" list renders without horizontal scroll, copy-URL button tappable.

If all pass → merge `d07-compose-stage` to main.

---

## Rollback

- Each commit deploys independently. `git revert <commit-sha>` + appropriate `wrangler rollback --version-id <captured>` per worker.
- D1 schema changes (cutout_r2_key, created_by, deleted_at) are additive — leaving them in place on rollback is safe.
- R2 cutout objects in `library/cutouts/` are inert if the cutout endpoint is rolled back.

---

## Out of scope (do NOT do)

- 5th template (Schedule Card)
- Bilingual / EN rendering
- FB auto-post integration
- Replacing or touching the existing `/removebg` flow in admin-social
- `photo` / `manager` / `treasurer` role compose access
- Status column / draft-vs-published lifecycle
- Two-cutout split-screen UI (schema headroom only)
- Auto-thumbnail generation for "My Cards" list (use the PNG itself for now)
- Live re-render on drag (client-side preview only)

---

## Attack vectors / how this can break

1. **Server-side team scoping bypassed.** If render endpoint trusts client-supplied `team_id` without checking against caller.teams, a coach for u15 can render u17d2 cards. Mitigation: commit 7 enforces server-side, with admin override only.
2. **`created_by` spoofing.** Same risk — if `created_by` is client-supplied, anyone can render as anyone. Mitigation: server extracts from JWT email claim, never from request body.
3. **remove.bg credit burn.** If cutout-generation endpoint isn't idempotent, repeated calls burn credits. Mitigation: idempotency check (`if cutout_r2_key is not null: return existing`). Cache for the life of the original photo.
4. **Stale `composeState` after schema change.** If sessionStorage state from before a schema change is restored, fields may be missing. Mitigation: include a schema version in state, clear if mismatch.
5. **Spordle picker breaks on tournament games.** If a Spordle response shape varies for non-league games, picker may crash. Mitigation: defensive parsing, fall back to manual mode on parse failure.
6. **Library upload allows arbitrary file types.** Mitigation: server-side content-type validation in existing `/upload` endpoint (verify in pre-flight; if missing, add).
7. **Soft-delete leaks data.** R2 PNGs remain accessible after soft-delete (URLs are unguessable hashes but still public). Mitigation: documented, not fixed in D07. Future directive if this matters.

---

**End of directive.**
