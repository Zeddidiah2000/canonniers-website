# Handoff: D02 Card Generator — CORS Fix Pending

**Date written:** 2026-05-13, end of long debugging session
**Status:** D02 deployed, CORS preflight fix verified, **but browser-based POST /render returns 500 on all checks**
**Pick-up point:** Diagnose 500 errors on /render, fix, re-verify, get JP feedback, scope D03

---

## ⚠️ FIRST THING TO READ TOMORROW

After CORS fix deployed and OPTIONS preflight verified via curl, Jay ran the browser verification (Checks 3, 4, 5, 5b, 6, 7) via Claude in Chrome at `https://canonniersdequebec.ca/admin-social.html`. **All checks failed with HTTP 500.**

This is NOT a CORS issue — CORS preflight is passing (otherwise the browser would error with `TypeError: Failed to fetch` before hitting the worker). The 500s mean the worker is reachable, accepting the request, then erroring server-side during `/render` execution.

**This is unexpected because Claude Code's curl-based verification of /render passed earlier in the session.** Something differs between curl-from-Claude-Code and browser-fetch-from-canonniersdequebec.ca that the worker doesn't handle.

### Possible causes (do not speculate — investigate)

- **Cloudflare Worker logs.** First step. `wrangler tail canonniers-cards-worker` while reproducing one request. Real stack trace.
- **JWT verification difference.** The browser sends an actual CF Access JWT from a logged-in session. Claude Code's curl tests may have used a manually-pasted JWT, a service token, or bypassed CF Access entirely. The worker's JWT verifier may be choking on real cookie-sourced tokens vs. header-sourced ones, or rejecting the audience claim.
- **`credentials: 'include'` behavior.** Browser fetch with credentials triggers different cookie/header handling than curl. Worker may be reading cookies it didn't expect.
- **Origin check inside the worker.** Beyond CORS preflight, the worker may be doing an `Origin` header allowlist check that fails for some reason.
- **Schema mismatch on INSERT.** If `render.ts` INSERT is shaped slightly wrong against the v5c schema, it'd 500 on first cache miss. (But this would have caught Claude Code's earlier verification too — so probably not.)
- **Template/font fetch failure under browser-originated load.** Less likely. R2 is R2 regardless of who triggered the render.

### Diagnostic plan for tomorrow

1. **Get real logs first.** `wrangler tail` against the worker. Reproduce one 500 from the browser. Read the actual error. Don't guess.
2. **If logs show JWT failure:** compare the verifier against `admin-photos.html`'s working JWT-flow. Reference impl is in repo.
3. **If logs show DB/render error:** check the error path. Whatever it is.
4. **If no logs appear:** the 500 may be coming from CF Access or the runtime, not the worker code. Check Zero Trust logs and Worker error tab in dashboard.

### What NOT to do tomorrow

- **Do not redeploy without logs.** Random patches without root cause = more rabbit holes.
- **Do not re-run browser checks expecting different results.** Same code, same input = same 500.
- **Do not assume it's CORS.** It isn't. Preflight passed, that's verified.

---

## TL;DR for the next session

D02 (card generator backend) is deployed. CORS preflight is fixed and verified. **But browser-based `/render` calls return 500.** The bug is server-side inside the worker, hit only by browser-originated requests (Claude Code's curl tests passed earlier in the session). Diagnose with `wrangler tail` first — get real logs, don't speculate.

When you pick up:

1. **Read the `⚠️ FIRST THING TO READ` section above.** Don't skip.
2. **`wrangler tail canonniers-cards-worker`**, then reproduce one 500 from the browser, get the stack trace.
3. **Fix based on the actual error**, not on guesses.
4. **Re-run browser verification** once the fix is deployed.
5. **Get JP's feedback on rendered cards** before scoping D03.
6. **Then scope D03** — compose stage UI in `admin-social.html`.

---

## Where we are in the 5-directive plan

| Directive | Status | Notes |
|---|---|---|
| ADR-001 v2 | ✅ Approved | In project files |
| D01 — cards-worker foundation | ✅ Shipped (with gaps) | §F rate limiting and §G cost guardrails permanently deferred (YAGNI) |
| D02 — game-day template + Browser Rendering | ⚠️ Deployed but broken | CORS verified; browser POST /render returns 500. Bug not yet diagnosed. |
| D03 — compose stage UI in admin-social.html | Not started | Blocked on D02 fix |
| D04 — multi-cutout, photo picker, remaining templates | Not started | |
| D05 — gallery integration, publish toggle | Not started | |

---

## D02 — Full Story of What Shipped

### What's actually deployed and working

- **canonniers-cards-worker** at `https://canonniers-cards-worker.chisholm2000.workers.dev`
- **Worker version ID** (post-D02 initial deploy): `68148e9e` — verify Claude Code's CORS fix bumped this
- **D1 schema:** `generated_cards` table with v5 + v5b + v5c migrations all applied. `game_id` and `season` nullable. `content_hash TEXT` with unique partial index `WHERE content_hash IS NOT NULL`.
- **R2 bucket:** `canonniers-cards` with public read at `cards.canonniersdequebec.ca`. CORS-scoped to `https://canonniersdequebec.ca` apex only (not www).
- **R2 contents:** Templates, fonts (Barlow Condensed 400 + 700 WOFF2 + OFL license), shared base.css, test cutout PNG, test opponent logo PNG.
- **Templates:** `game-day` with two variants (`with-cutout`, `graphic-only`) at 1080×1080. Style 4 / Action Blueprint aesthetic — schematic field diagram + huge outlined "CANONNIERS" wordmark behind info panel.
- **TypeScript migration:** All `.js` files renamed to `.ts`. Standard CF Workers tsconfig (es2022, strict mode, types: `@cloudflare/workers-types`).
- **Browser Rendering:** Workers Binding pattern, `env.BROWSER` typed as `Fetcher`. `compatibility_flags = ["nodejs_compat"]` set.
- **Dependencies pinned:** `@cloudflare/puppeteer@1.1.0`, `wrangler@4.90.1`, `typescript@6.0.3`, `@cloudflare/workers-types@4.20260511.1`.

### What's confirmed working via Claude Code curl tests

| Behavior | Status |
|---|---|
| `/render` returns 200 with R2 URL on cache miss | ✅ |
| D1 content-hash cache returns same `card_id` and URL on identical second call | ✅ |
| `cached: true` flag on cache hits | ✅ |
| `render_ms: null` on cache hits (post-fix) | ✅ pending browser re-verify |
| Validation rejects bad `game_date` with 400 | ✅ |
| Long opponent names wrap to 2 lines without overflow | ✅ |
| TBD time fallback in both FR ("À DÉTERMINER") and EN ("TBD") | ✅ |
| Bilingual rendering (FR/EN) | ✅ |
| Missing cutout returns 200 with `warnings: ["cutout image was unreachable: ..."]` | ✅ pending browser re-verify |
| Cutout-fetch timeout reduced (no more 11s renders on 404 cutouts) | ✅ pending browser re-verify |
| Test cutout PNG at `https://cards.canonniersdequebec.ca/test/test-cutout.png` | ✅ uploaded post-initial-deploy |
| CORS preflight on `/render`, `/list`, `/delete` | ✅ all 204, all 5 headers present |

### What's NOT working

- **Browser-based POST /render returns 500.** All 6 checks (3, 4, 5, 5b, 6, 7) fail when called from Claude in Chrome at `https://canonniersdequebec.ca/admin-social.html`. CORS preflight passes (otherwise would be `Failed to fetch`). Worker is reached, then 500s server-side.
- Curl-based verification from Claude Code passed earlier in the session — something differs between curl and browser context that the worker doesn't handle.
- **Not yet diagnosed.** First step tomorrow is `wrangler tail` to get real logs.

### CORS fix verification (2026-05-13)

Claude Code deployed the CORS preflight fix and verified all three JWT-protected endpoints:

```
/render  → 204 | ACAO: https://canonniersdequebec.ca | Credentials: true | Max-Age: 86400
/list    → 204 | ACAO: https://canonniersdequebec.ca | Credentials: true | Max-Age: 86400
/delete  → 204 | ACAO: https://canonniersdequebec.ca | Credentials: true | Max-Age: 86400
```

All five required CORS response headers confirmed present on each endpoint:
- `Access-Control-Allow-Origin: https://canonniersdequebec.ca`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: content-type, cf-access-jwt-assertion`
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Max-Age: 86400`

Browser-based fetch from `canonniersdequebec.ca` with `cf-access-jwt-assertion` in headers will pass preflight.

### Open / Deferred items from D02 scope

- **Rate limiting rule (D01 §F):** Permanently deferred. CF Access auth + D1 content-hash cache + credit card monitoring = sufficient threat model for a 50-player volunteer-run fan site.
- **Cost guardrails (D01 §G):** Permanently deferred. Same reasoning. Jay watches credit card statements.
- **Real Canonniers logo SVG:** Templates currently use a placeholder "C" circle SVG. `TODO` comment in template files. Replace before D03 ships, or as part of D03.
- **Cutout URL validation:** D02's threat model §2 flagged that cutout URLs aren't restricted to `cards.canonniersdequebec.ca` or `images.canonniersdequebec.ca` domains. Known gap, deferred to when cutout pipeline becomes real (Directive 03 or later).
- **Test asset placement convention:** Test cutout lives at `r2://canonniers-cards/test/test-cutout.png`. If the convention should be `templates/cards/game-day/test-assets/`, it's not enforced — both paths exist now. Pick one.

---

## D02 — Full Story of What We Hit

This was a long session. The points below are the bugs and decisions we hit so the next session doesn't re-litigate them or re-discover them.

### The schema bugs (two migrations)

D01 shipped the `generated_cards` table with three wrong columns:

1. **No `content_hash` column** — D02 needs it for caching. Fixed in `update_schema_v5b_content_hash.sql`: `ADD COLUMN content_hash TEXT` + `CREATE UNIQUE INDEX idx_cards_content_hash`.
2. **`game_id TEXT NOT NULL`** — should be nullable per ADR v2. Cards rendered without a specific game (e.g. season-opener announcements) need NULL, not a synthesized value. Fixed in `update_schema_v5c_game_id_nullable.sql` via rename-recreate-drop pattern (table was empty, so safe).
3. **`season TEXT NOT NULL`** — should be nullable for same reason as game_id. Folded into v5c.
4. **`idx_cards_content_hash` missing `WHERE content_hash IS NOT NULL`** — without this, multiple NULL content_hash rows could fight on the unique index. Folded into v5c.

All three v5/v5b/v5c migrations are in repo. Forward-only, do not edit. Take D1 backups before any future schema change: `wrangler d1 export canonniers-db --remote --output=backups/canonniers-db-pre-<change>-<timestamp>.sql`. Latest backup is `backups/canonniers-db-pre-d02-20260512-2337.sql`.

### The Puppeteer / TS / wrangler.toml deviations from the directive

The D02 v1 directive was written against `@cloudflare/puppeteer 0.0.14`. By the time we executed it, that line was abandoned. We pinned `1.1.0` (current latest stable) and made four code deviations from the directive:

1. **Drop `.buffer.slice()` ceremony** — `page.screenshot()` returns `Uint8Array` directly usable in `R2.put()`. No `Buffer` import needed.
2. **`compatibility_flags = ["nodejs_compat"]`** required in wrangler.toml.
3. **`compatibility_date`** bumped from `2026-05-01` to `2026-05-12`.
4. **`Fetcher` type from `@cloudflare/workers-types`** for `BROWSER` binding, not `BrowserWorker` from `@cloudflare/puppeteer`.

If a future directive references the old patterns, ignore and use the above.

### The font loading bug

Initial render output had a massive "ANONNIE" text overlay across all four cards. The hypothesis chain was:

1. **Claude in chat (me):** "It's intentional design — outlined wordmark bleeding off edges. Need to decide A/B/C on design direction." → **Wrong.** I was speculating from one HTML file without seeing the actual rendered output context.
2. **Claude Code:** "Fonts aren't loading in Puppeteer. Barlow Condensed at 280px fits 960px container; a system fallback at 280px overflows and gets clipped to 'ANONNIE'." → **Right.**
3. Root cause: `body` in `base.css` had `overflow: hidden` but no `position: relative`, plus possibly other font-load timing issues. Claude Code fixed it.

**Lesson for next session:** when post-deploy renders look broken, trust Claude Code's hands-on diagnosis over my speculation. I don't have the files; Claude Code does.

### The CORS gap (current pending fix)

D02 was verified by Claude Code via curl, which doesn't trigger browser CORS. When we tried browser-based verification via DevTools console, every preflight failed. **D03 is entirely browser-based**, so this fix isn't optional — it's a prerequisite for D03.

Claude Code's task: add `cf-access-jwt-assertion` to `Access-Control-Allow-Headers` for `/render` and any other JWT-protected endpoint (`/list`, `/delete`). Apply the same OPTIONS preflight pattern across all of them.

### The token-burning lessons

This session went off the rails multiple times before we got to actual work. Logged here so the next session avoids the same traps:

1. **Memory drift:** Project memory said "D01 deployed" — actually D01 was approved-and-handed-off but Claude Code hadn't verified deployment. Took two reversals to ground-truth via wrangler/curl. **Lesson:** trust verification output, not memory, not handoff prompts, not Claude Code's first claim. Verify infrastructure with actual API calls.
2. **Rabbit holes on deferred items:** Spent ~30+ exchanges on rate limit rule + cost guardrail setup before deciding both were YAGNI for a 50-player volunteer-run site. **Lesson:** mitigations should match the threat, not the architecture diagram. Credit card monitoring is a real, working guardrail. Don't build cost alerts to back up an alert that already works.
3. **Defensive padding:** Claude in chat (me) repeatedly added "verify before action" gates on reversible changes. Trim ratio was about 50% — half the prep work was unnecessary. **Lesson:** if the user says "trim," cut. If the action is reversible and the table is empty, just do it.
4. **Verification gates that mattered:** Gate 2 (`tsc --noEmit` + `wrangler deploy --dry-run` before deploy) and Gate 3 (post-deploy verification) caught real issues — missing `[browser]` binding, schema mismatch on game_id, fonts not loading, CORS gap. **Keep these. Skip everything else.**

---

## Critical context the next session needs

### Architecture
- **Cards worker:** `https://canonniers-cards-worker.chisholm2000.workers.dev`
- **Auth pattern:** CF Access JWT verification + service binding (`env.AUTH_WORKER`) to `canonniers-auth-worker` for role/team resolution. Reference impl is `admin-photos.html`.
- **CF Access app:** `AuthCanonniers`, scoped to `canonniersdequebec.ca/admin*`, email OTP, allowlist of `@canonniers.ca` addresses.
- **Team IDs:** Lowercase `u15`, `u17d1`, `u17d2` everywhere (D1, R2 paths, queries).
- **Secrets on cards-worker:** `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN=quebecsports.cloudflareaccess.com`.
- **R2 binding:** `env.CARDS_BUCKET` → `canonniers-cards`.
- **D1 binding:** `env.DB` → `canonniers-db`.

### Card render contract
- `POST /render` with JSON body. See `src/render.ts` for `RenderRequest` interface.
- Returns `{ url, cached, card_id, render_ms }` on success.
- Returns `{ url, cached, card_id, render_ms, warnings: [...] }` if any non-fatal issues (e.g., cutout 404).
- Returns 400 on validation failure.
- Returns 401 on missing/invalid JWT.

### Template paths in R2
- Templates: `templates/cards/game-day/{with-cutout,graphic-only}.html`
- Layout JSON: `templates/cards/game-day/layout.json`
- Shared CSS: `templates/cards/_shared/css/base.css`
- Fonts: `templates/cards/_shared/fonts/barlow-condensed-{400,700}.woff2`
- Test assets: `test/test-cutout.png`, `test/test-opponent-logo.png`

### D1 schema (generated_cards)
```
id           INTEGER PK AUTOINCREMENT
game_id      TEXT NULL                -- v5c made nullable
team_id      TEXT NOT NULL            -- u15 / u17d1 / u17d2
season       TEXT NULL                -- v5c made nullable
template     TEXT NOT NULL            -- e.g. "game-day"
lang         TEXT NOT NULL            -- "fr" or "en"
size_variant TEXT NOT NULL            -- e.g. "1080x1080"
r2_key       TEXT NOT NULL            -- relative R2 path
published    INTEGER NOT NULL DEFAULT 0
published_at INTEGER NULL
archived     INTEGER NOT NULL DEFAULT 0
created_by   TEXT NOT NULL            -- email from CF Access JWT
created_at   INTEGER NOT NULL         -- epoch seconds
deleted_at   INTEGER NULL
metadata     TEXT NULL                -- JSON: render_ms, payload, etc.
content_hash TEXT NULL                -- v5b added; UNIQUE partial index
```

### Operational rules
- **Claude Code does ALL operational work.** Wrangler, Cloudflare API, dashboard, git, file operations, grep, curl. Jay only pastes values from masked UIs and approves irreversible/billing actions.
- **Jay runs PowerShell on Windows.** Any commands for Jay to run locally must be PowerShell-compatible: `curl.exe` not `curl`, backtick continuation not backslash, `$env:VAR` not `VAR=` prefix.
- **Directives delivered as `.md` files** via `create_file` + `present_files`, not inline.
- **GitHub `main` is single source of truth.** Fetch raw URLs at session start to verify state.

---

## Re-verification checklist for next session

### Step 1: Browser verification via Claude in Chrome

Navigate to `https://canonniersdequebec.ca/admin-social.html`. Open DevTools console.

Grab JWT:
```javascript
const jwt = document.cookie.split(';').find(c => c.trim().startsWith('CF_Authorization='))?.split('=')[1];
console.log('JWT:', jwt ? jwt.slice(0,40)+'...' : 'NOT FOUND');
```

Then run Checks 3, 4, 5, 5b, 6, 7 from the test script (see previous session's chat or D02 verification logs). Each check posts to `/render` with a different payload. Screenshot rendered cards.

### Step 2: Expected outcomes

| Check | Expected |
|---|---|
| C3 | 200, `cached:false`, renders FR card for Tyrans match |
| C4 | 200, `cached:true`, `render_ms:null`, same card_id as C3 |
| C5 | 200, renders EN card for Condors with test cutout visible in bottom-right |
| C5b | 200, `warnings: ["cutout image was unreachable: ..."]`, no 11s delay |
| C6 | 200, long opponent name wraps cleanly, no overflow |
| C7 | 200, "TBD" time label in EN |

### Step 3: Show JP one rendered card

Pick the best of C3/C5/C6/C7. Send to JP. Get reaction. **This is the decision point for whether D03 builds against this template or a redesigned one.** Do not skip.

### Step 4: Scope D03

If JP likes the design → D03 directive: compose stage UI in `admin-social.html`. Single cutout, mobile-first drag/scale/rotate, snap-to-presets, haptics, safe-zone warnings. Wires to `/render`.

If JP wants changes → separate template-redesign directive before D03.

---

## Things NOT to redo

Don't waste tokens re-litigating these:

- Whether D01 is deployed. **It is.** Worker version ID before D02 was its own (find via wrangler deployments list).
- Whether to set up rate limiting or cost alerts. **Deferred indefinitely.**
- Whether to use Workers Binding vs REST API for Browser Rendering. **Workers Binding, env.BROWSER.**
- Whether to use sync or async render endpoint. **Synchronous with D1 content-hash cache.**
- Whether to commit a real cutout image or hardcode test PNG. **Test PNG in R2 at `/test/test-cutout.png`.**
- Whether to migrate JS → TS. **Done. All `.js` renamed to `.ts`.**
- Whether `Fetcher` or `BrowserWorker` is the right binding type. **`Fetcher`.**
- Whether `position: relative` belongs on body in base.css. **Yes, it does. Already there.**
- What template aesthetic to use. **Style 4 / Action Blueprint, pending JP feedback.**

---

## Final state at handoff

- **GitHub `main`:** clean, all D02 work committed and pushed (including CORS fix)
- **canonniers-cards-worker:** deployed with CORS preflight fix applied to `/render`, `/list`, `/delete`
- **D1:** all migrations applied (v5, v5b, v5c), table shape correct, backup taken
- **R2:** all assets uploaded including post-deploy fix uploads (test cutout, opponent logo)
- **Pending:** Browser-based `/render` returns 500. Root cause unknown. `wrangler tail` first thing tomorrow.

Next session: diagnose 500 with logs → fix → re-verify in browser → show JP a card → scope D03.
