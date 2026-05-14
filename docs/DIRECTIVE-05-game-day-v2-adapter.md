# Directive #5 — Game Day Card v2 Adapter

**Owner:** Claude Code
**Author:** Jay (drafted with Claude)
**Date:** 2026-05-13 / next session
**Status:** Draft, awaiting execution

---

## Goal

Adapt `Game_Day_Card.html` (Claude-designed) into the cards-worker pipeline as a new template key `game-day-v2`. Verify the pipeline renders a PNG that visually matches the HTML preview, using Jay's real player cutout. Existing `game-day` template (Action Blueprint) stays in place untouched.

**Pass criterion:** rendered PNG matches HTML preview within ~5% visual deviation (anti-aliasing differences are normal). Then proceed to Directive #6 (Blueprint + Result + Hype in one batch).

**Fail criterion:** any deviation that suggests pipeline bug rather than template-specific tweak. Diagnose the adapter pattern before adapting more templates.

---

## Scope (do NOT exceed)

- One template (`game-day-v2`), one variant (`with-cutout` only).
- One language (French only). Bilingual strategy deferred until after first render proves the pipeline.
- One asset path fix (relative `assets/...` → absolute URLs).
- Font injection list extended to cover weights actually used across the four new templates (this is a one-time engine change; #6 won't need to repeat it).
- No `graphic-only` variant for Directive #5 — defer to Directive #6.
- No new render-contract fields beyond what `validateRenderRequest()` already accepts.
- No shared `tokens.css` extraction. Templates remain self-contained.

---

## Pre-flight verification

Before any file edits, confirm baseline state. Report findings; do NOT proceed if any check fails — surface the discrepancy first.

1. **Confirm deployed worker matches git.**
   ```powershell
   wrangler deployments list --name canonniers-cards-worker
   git log -1 --oneline d02-deployed-baseline
   ```
   The latest deployed version ID should match a commit on `d02-deployed-baseline` (or `main` if merged). If drift exists, stop and report.

2. **Confirm existing `game-day` template renders successfully.** Run a `POST /render` with the same payload that produced `card_id: 9` on 2026-05-13. Confirm 200 + valid PNG URL. This proves the engine is still healthy before we touch anything.

3. **Read these files from the repo (NOT from any project uploads — uploads may be stale):**
   - `render.ts` — focus on `validateRenderRequest()` (the field schema for `content`), the template-router section, and the inline font injection block.
   - `templates/cards/game-day/with-cutout.html` (existing Action Blueprint) — to understand the current placeholder syntax (Mustache `{{x}}`? Custom regex? `${x}`?). The new template must use the same syntax so the engine doesn't need a parser change.
   - `templates/cards/_shared/css/base.css` — confirm `@font-face` is still removed (per 2026-05-13 fix). New template must NOT re-link any font CSS that references `cards.canonniersdequebec.ca`.

4. **Confirm Jay's player cutout PNG is uploadable to R2.** Either:
   - `wrangler r2 object put canonniers-cards/test/jay-player.png --file=<local path> --remote`, OR
   - already exists at a known R2 path.
   Report the absolute URL.

5. **Report findings before proceeding.** Include:
   - Current placeholder syntax (verbatim example from existing template).
   - Exact `content` field names that `validateRenderRequest()` accepts.
   - Line range of the inline font injection block in `render.ts`.
   - Confirmation engine is healthy (step 2).
   - Cutout URL.

---

## Patch — template adaptation

Source: `Game_Day_Card.html` (uploaded to Jay's project, 2026-05-13).

### Step 1 — Strip preview wrapper

Remove:
- `<div class="stage">` wrapper element (keep its children).
- `.stage` CSS block.
- `transform: scale(calc(100vmin / 1080))` from `.canvas`.
- The `transform-origin: center center;` line on `.canvas`.

Puppeteer renders at native 1080×1080. The preview-scaling wrapper is dead weight.

### Step 2 — Remove Google Fonts link

Remove:
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
```

Fonts come from worker-side inline base64 injection (see Step 6).

### Step 3 — Replace hardcoded text with placeholders

**Use the same placeholder syntax as the existing `game-day` template** (confirm in pre-flight step 3). Map hardcoded preview values to placeholders matching `validateRenderRequest()` field names exactly.

Game Day Card uses these strings (verify against Claude Code's read of the actual file — list below is from Jay's uploaded copy):

| Hardcoded preview | Placeholder | Notes |
|---|---|---|
| `Patriotes` (opponent_name) | `{{opponent_name}}` | Apply three-tier sizing if template includes it; otherwise plain |
| `Samedi · 24 Mai` | `{{date_text}}` | Day + month, pre-formatted FR string |
| `19:30` | `{{time_text}}` | 24h format |
| `Stade Canonnier · Québec` | `{{venue_text}}` | Venue name + city |
| (any other hardcoded strings — Claude Code: list them in execution report) | (TBD per actual file content) | |

**Do NOT placeholder-ize:**
- The "CANONNIERS" wordmark text (organization identity, hardcoded).
- The "Game Day" panel header in French — for this directive, FR only.
- The "DE QUÉBEC" brand sub-text.
- The "vs" / "VS" particle.

### Step 4 — Fix asset paths

Find every `src="assets/test-opponent-logo.png"` and `src="assets/..."` reference in the template.

Replace per use-case:
- Canonniers brand chip / brand lockup logo → `{{canonniers_logo_url}}`
- Opponent logo (if Game Day Card has one — verify) → `{{opponent_logo_url}}`

All URLs passed to the template MUST be absolute (e.g., `https://cards.canonniersdequebec.ca/logos/canonniers.png`). Puppeteer's `about:blank` context cannot resolve relative paths.

**Confirm `canonniers_logo_url` exists in R2** at a stable path before this directive runs. If not, either:
- Upload Canonniers logo to R2 at `logos/canonniers.png`, OR
- Hardcode the data URI inline in the template (one-time payload cost, eliminates a fetch).

Pick whichever Claude Code judges faster.

### Step 5 — Remove `hue-rotate` and other preview hacks

If Game Day Card has any preview-only CSS hacks (e.g., `hue-rotate` filters used to fake a second team color from a single PNG), remove them.

### Step 6 — Extend worker font injection

In `render.ts`, locate the inline font injection block (was lines 295-311 as of 2026-05-13; verify current line range in pre-flight).

**Current state:** injects Barlow Condensed 400 + 700 only.

**Required:** add Barlow Condensed 600, 800, 900.

Audit of weights used across all four new templates (Game_Day, Blueprint, Result, Hype):

| Weight | Used by |
|---|---|
| 400 | (kept — base body text) |
| 600 | Hype Card `.info-stack .venue` |
| 700 | (kept — already present) |
| 800 | Blueprint hero, Result watermark, Hype `.info-stack .when` |
| 900 | Result title-line, Hype headline, all `.score-num` |

So injection list becomes: **400, 600, 700, 800, 900** (Barlow Condensed).

**JetBrains Mono decision (recommended):** do NOT add to injection. All Mono usage in the four templates is caption-sized (9-13px), with one edge case in Result Card at 32px (`.vs-divider`). Fall back to `ui-monospace` system stack — already declared in every template's `--font-mono`. Saves ~80-120KB base64 payload per render.

If the Result Card 32px Mono looks visually wrong in Directive #6, revisit then. For Directive #5 (Game Day only), Mono is only used at small caption sizes — `ui-monospace` fallback is safe.

Document this decision in a comment above the injection block.

### Step 7 — Register the new template

In `render.ts` template-router section, add `game-day-v2` as a recognized template key. Map it to the new template file path.

**Naming convention:**
- File path: `templates/cards/game-day-v2/with-cutout.html`
- Template key in request payload: `game-day-v2`
- Variant: `with-cutout` only for this directive.

Existing `game-day` route stays unchanged.

### Step 8 — Upload to R2

```powershell
wrangler r2 object put canonniers-cards/templates/cards/game-day-v2/with-cutout.html --file=<path> --remote
```

Cache-bust: append `?v=1` in the worker's fetch URL for this template, matching the existing `?v=N` pattern (the `wrangler cache_purge` scope is still missing per 2026-05-13 handoff).

### Step 9 — Deploy gates (in order)

1. `cd cards-worker && npx tsc --noEmit` — no TypeScript errors.
2. `wrangler deploy --dry-run` — no Wrangler errors.
3. `git add -A && git commit -m "feat(cards): add game-day-v2 template (Claude-designed)"` on a feature branch off `d02-deployed-baseline`.
4. `wrangler deploy` — capture the new version ID for rollback reference.
5. `git push origin <feature-branch>` — keep main clean until verified.

**Capture pre-deploy worker version ID before step 4.** Required for rollback.

---

## Post-deploy verification

### Render test

```powershell
curl.exe -X POST https://cards.canonniersdequebec.ca/render `
  -H "Content-Type: application/json" `
  -H "<CF Access JWT header — same as current working pattern>" `
  -d '{
    "template": "game-day-v2",
    "variant": "with-cutout",
    "team_id": "u15",
    "lang": "fr",
    "content": {
      "opponent_name": "Patriotes de Trois-Rivières",
      "date_text": "Samedi · 24 Mai",
      "time_text": "19:30",
      "venue_text": "Stade Canonnier · Québec",
      "canonniers_logo_url": "<absolute R2 URL>",
      "opponent_logo_url": "<absolute R2 URL, if template uses it>",
      "cutout_url": "<Jay player cutout R2 URL>"
    }
  }'
```

(Adjust field names per pre-flight step 3 findings — this is illustrative, not authoritative.)

**Expected:**
- HTTP 200
- Response includes `card_id`, public PNG URL.
- D1 row inserted in `generated_cards` table.
- R2 object exists at the response URL.

### Visual comparison

Jay opens both side-by-side in a browser:
1. The static HTML preview (Jay's local copy of `Game_Day_Card.html`).
2. The rendered PNG from the response URL.

**Pass checklist:**
- [ ] Wordmark renders (chrome gradient visible, no clipping at edges).
- [ ] Glassmorphism info panel has visible blur (NOT flat translucent — see backdrop-filter risk below).
- [ ] Player cutout layered correctly (z-index per template design — typically in front of wordmark, behind info panel).
- [ ] Fonts load at the expected weights (no thin-text fallback artifacts).
- [ ] Opponent name fits without overflow on a realistic long name ("Patriotes de Trois-Rivières" is the test case — 28 chars).
- [ ] No missing texture overlays (grain, spotlight backdrop visible).
- [ ] No relative-path 404 artifacts (logos render correctly, not broken-image icons).
- [ ] Edge frame and corner ticks render.

**Backdrop-filter risk:** if the glass info panel renders as flat translucent (no blur), Puppeteer's Chromium is rendering without GPU acceleration support for `backdrop-filter`. Fallback: pre-bake a blurred background image OR replace `backdrop-filter` with a higher-opacity gradient fill. Diagnose only if it surfaces.

### Health check

- D1: `wrangler d1 execute canonniers-db --command="SELECT COUNT(*) FROM generated_cards WHERE template='game-day-v2';"` — expect ≥1.
- R2: confirm PNG object exists at returned URL with `Content-Type: image/png`.
- Worker logs: tail briefly during render — no error-level entries.

---

## Open questions for Claude Code

Surface these in the execution report. Do NOT decide unilaterally without flagging:

1. **Existing template placeholder syntax** — confirm exact form (`{{x}}` vs `${x}` vs other). If the existing engine uses a syntax other than Mustache-style `{{x}}`, the directive's placeholder examples above are illustrative — match the actual syntax.

2. **`content` field names** — the field names in the curl example above (`opponent_name`, `date_text`, etc.) are guesses based on the handoff. Verify against `validateRenderRequest()` and use the real names. Report any mismatch with the directive's assumptions.

3. **Canonniers logo location** — is there a stable R2 URL for it already, or does it need uploading? If uploading, where in the R2 path tree?

4. **Game Day Card-specific cutout position** — the uploaded `Game_Day_Card.html` has `<!-- <img class="cutout" src="path/to/player.png" alt=""> -->` commented out. Claude Code: confirm the `.cutout` CSS positioning by reading the actual file. The handoff noted `right: 40px; bottom: 60px; height: 720px` but that may have changed in Jay's latest version.

5. **Three-tier opponent-name sizing** — handoff mentioned `.tier1/2/3` with `-webkit-line-clamp` for long Quebec team names. Confirm if Game_Day_Card.html includes this system. If yes, the worker may need to assign the tier class based on opponent_name length, OR the template uses pure CSS-driven sizing (preferable — no worker logic). Report which.

---

## Rollback plan

If post-deploy verification fails:

1. **Re-deploy previous worker version**:
   ```powershell
   wrangler rollback --version-id <captured pre-deploy version ID>
   ```

2. **Existing `game-day` template stays in place untouched.** No data migration needed; D1 rows with `template='game-day-v2'` can be left in place (harmless) or deleted (`DELETE FROM generated_cards WHERE template='game-day-v2'`).

3. **Diagnose root cause before re-attempting.** Likely causes:
   - Placeholder syntax mismatch (engine didn't substitute).
   - Font injection list incomplete (visible text-weight regression).
   - Asset path 404 (logos missing).
   - `backdrop-filter` failure (glass panels flat).

4. **Do NOT proceed to Directive #6** until #5 verifies. Adapting three more templates on a broken pattern wastes the next session.

---

## What this directive does NOT do

Explicitly out of scope. Do NOT bundle these:

- **`graphic-only` variant of Game Day Card.** Defer to Directive #6.
- **Blueprint, Result, Hype adapters.** Directive #6.
- **Schedule Card.** Not yet designed.
- **Double-Header Card.** Mothballed per Jay 2026-05-13.
- **Bilingual support (English version of Game Day Card).** Defer until after Jay validates FR render visually.
- **`tokens.css` extraction.** Templates remain self-contained.
- **Admin Social tool UI changes.** No UI work in this directive — render endpoint only.
- **Touching `render.ts` core logic.** Only changes permitted: template router addition, font injection list extension.
- **Adding multi-cutout support.** Each new template has N=1 cutout slot at a fixed template-internal position.

---

## Decision log (for memory after success)

After Directive #5 passes, update Jay's memory with:

- Schema state at v5c (drift noted in earlier session).
- D02 fully shipped (card_id 9 baseline render).
- `d02-deployed-baseline` branch pushed to origin.
- `base.css` `@font-face` removed permanently — never re-add (cross-origin from `about:blank` throws DOMException → 500).
- `wrangler` OAuth missing `cache_purge:edit` scope; `?v=N` cache-bust is the workaround.
- Template pivot: 4 Claude-designed templates (Game_Day, Blueprint, Result, Hype) + 1 TBD Schedule Card. Action Blueprint retired after adaptation complete.
- `game-day-v2` template registered, FR-only, single variant.
- Font injection list extended to 400/600/700/800/900 (Barlow Condensed). JetBrains Mono falls back to `ui-monospace`.
- Cutout cap N=1 per template (overriding ADR-001 v2's N=2 cap).

---

## Estimated execution time

- Pre-flight: 5-10 min.
- Template edit + R2 upload: 15-20 min.
- Worker font injection patch + deploy: 10 min.
- Verification + visual comparison: 10 min.

**Total target: ~45 min**, assuming no pipeline bugs. If a bug surfaces, halt and diagnose — do not push through.

---

**End of directive.**
