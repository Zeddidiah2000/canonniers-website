# Directive #6 — Adapt Blueprint, Result, Hype Templates

**Date drafted:** 2026-05-13
**Author:** Claude (web architect session)
**Executor:** Claude Code
**Scope:** Single commit, three template adapters, smoke-test all three at the end.

---

## Goal

Adapt three Claude-designed templates (`Blueprint_Card.html`, `Result_Card.html`, `Hype_Card.html`) into the `canonniers-cards-worker` pipeline as template keys `blueprint`, `result`, `hype`. Reuse the verified game-day-v2 adapter pattern from Directive #5. One variant per template (`with-cutout`). French only. Smoke-render one card per template using `test/test-cutout.png`.

**One commit. Three templates. One worker deploy. Three smoke renders at the end.** Rollback is `git revert` + `wrangler rollback --version-id <pre-deploy>`.

---

## Pre-flight (mandatory — do NOT skip)

Run all checks before touching any file. Report results before proceeding to the patch.

### 1. Branch state

```powershell
cd <repo-root>
git fetch --all --prune
git branch -a
git log --oneline -10 origin/main
git log --oneline -10 origin/d05-game-day-v2
```

**Decide working base:**
- If `d05-game-day-v2` is already merged into `main` → branch off `main`: `git checkout main && git pull && git checkout -b d06-blueprint-result-hype`
- If `d05-game-day-v2` is NOT merged → merge it to `main` first (fast-forward if possible), then branch from `main`. Do not stack #6 on top of `d05-game-day-v2` as a feature-of-a-feature.

Report which scenario applied.

### 2. Worker deployment vs. git HEAD

```powershell
cd canonniers-cards-worker
wrangler deployments list
```

Capture the current deployed version ID — this is the rollback target. Confirm it matches `010a2fa7-8f3c-4922-a432-8b0686a26534` (D05 baseline). If it doesn't, stop and report.

### 3. R2 assets exist

```powershell
curl.exe -sI https://cards.canonniersdequebec.ca/logos/canonniers.png
curl.exe -sI https://cards.canonniersdequebec.ca/test/test-cutout.png
curl.exe -sI https://cards.canonniersdequebec.ca/test/test-opponent-logo.png
```

All three must return `HTTP/2 200` and `content-type: image/png`. If any 404s, stop and report.

### 4. Read render.ts ground truth

Read `canonniers-cards-worker/src/render.ts` (or wherever `validateRenderRequest` lives in the current tree). Capture verbatim:

- The exact field names accepted by `validateRenderRequest()`
- The exact `cutouts[]` shape (`image_url`, `preset`, `x_offset?`, `y_offset?`, `scale_override?` per memory #26)
- The template router — specifically the type union of allowed template keys and how the equality/includes check is structured

**Do not guess field names. Use what the file says.** Memory #27 captures the schema but the file is the source of truth.

### 5. Read reference template

Read `templates/cards/game-day-v2/with-cutout.html` from R2 (or local working copy). This is the verified adapter from D05. The placeholder syntax, brand-chip URL pattern, and texture-overlay structure are the reference for all three new adapters.

### 6. Read base.css

Read `templates/cards/_shared/css/base.css`. Confirm `@font-face` is still absent. If present, stop — something regressed since D05.

### 7. Read source HTMLs from updates folder

Read all three source files from the standard updates folder (same convention as prior directives):

- `Blueprint_Card.html`
- `Result_Card.html`
- `Hype_Card.html`

For each, identify upfront and report back:

- All preview-only artifacts to strip (e.g., the leftover "DOUBLE HEADER" tagline removed from game-day-v2 in D05)
- The cutout slot CSS (the equivalent of `.cutout.demo` — the rule that demo-positions the cutout)
- All hardcoded asset paths that need replacement with absolute `https://cards.canonniersdequebec.ca/...` URLs
- All hardcoded text strings that need to become `{{placeholders}}`
- Any Google Fonts `<link>` tags to remove
- Any `.stage` wrapper / `transform: scale(...)` on `.canvas` to strip
- Font weights used — confirm all fall within Barlow Condensed 400/500/600/700/800/900 (already injected). If any template uses a weight outside that range, stop and report.

---

## Patch — Per-template adapter work

Apply the D05 adapter pattern to each template. Reference: "Engine + adapter pattern verified" section of `HANDOFF-2026-05-13-d05-passed.md`, steps 1–9.

For each of `Blueprint_Card.html`, `Result_Card.html`, `Hype_Card.html`:

1. Strip `.stage` wrapper + `transform: scale(calc(100vmin / 1080))` from `.canvas`. Puppeteer renders at native 1080×1080.
2. Remove Google Fonts `<link>`. Fonts come from worker inline base64.
3. Strip the cutout-slot demo-positioning CSS rule. Engine emits inline-positioned `<img class="cutout">`.
4. Replace hardcoded text with `{{placeholders}}` matching real `validateRenderRequest()` field names captured in pre-flight step 4.
5. Convert all asset paths to absolute URLs against `https://cards.canonniersdequebec.ca/...`
6. Remove preview-only artifacts identified in pre-flight step 7.
7. Save adapted templates to:
   - `templates/cards/blueprint/with-cutout.html`
   - `templates/cards/result/with-cutout.html`
   - `templates/cards/hype/with-cutout.html`

### Per-template specifics

**Blueprint Card**
- Minimal informational content. Subtitle is the only string ("Game Day · Canonniers VS [opponent]" pattern).
- Cutout slot: center-top tall (per handoff).
- Map subtitle to the appropriate placeholder field from render.ts (likely `{{opponent_name}}` interpolated into a static FR string in the template itself).

**Result Card**
- `title_line_1` and `title_line_2` are user-controlled headline lines. Coach types the headline. **No auto win/loss logic.** These need to map to whatever fields render.ts exposes for headline text — if those fields don't exist yet in `validateRenderRequest()`, stop and report; we'll either extend the schema in a follow-up or hardcode a placeholder name and add the schema field as part of this directive (Jay's call).
- Cutout slot: behind score band.
- The 32px `.vs-divider` uses JetBrains Mono. Acceptable to fall back to `ui-monospace` (memory #28). If smoke render shows the divider visually broken, flag it but don't block — Jay decides whether to inject JBM.

**Hype Card**
- Player-spotlight template. Cutout slot: left-half tall.
- Real player cutouts come post-D03. For this smoke render, `test/test-cutout.png` is fine.

### R2 uploads

Upload each adapted template with `?v=1` cache-bust on the fetch URL in the worker (memory #29 — wrangler still lacks `cache_purge:edit`). Use `wrangler r2 object put`.

### Worker router update

In the template router (location captured in pre-flight step 4):

1. Extend the template-key type union to include `'blueprint' | 'result' | 'hype'`.
2. Extend the equality/includes check accordingly.
3. Bump the `?v=N` query string in the fetch URL for each new template key by 1 (cache-bust per memory #29).

### Deploy gates (mandatory order)

```powershell
cd canonniers-cards-worker
npx tsc --noEmit          # must pass
wrangler deploy --dry-run # must pass
git add -A
git commit -m "feat(cards): adapt blueprint, result, hype templates (Directive #6)"
wrangler deploy           # capture new version ID — this is the new rollback target
git push origin d06-blueprint-result-hype
```

---

## Verification — Smoke renders

After deploy, run three smoke renders using the verified browser DevTools fetch pattern (same as D05). Memory #19 captures the pattern; Jay knows the snippet.

**Jay's steps:**

1. Open `https://canonniersdequebec.ca/admin-social.html` (or any CF-Access-authenticated admin page) in a browser already authenticated to CF Access.
2. Open DevTools → Console.
3. Paste the smoke-render snippet with `template: "blueprint"` (full payload below). Send. Capture the returned PNG URL.
4. Repeat for `template: "result"`.
5. Repeat for `template: "hype"`.

### Smoke render payload template

Use real field names from pre-flight step 4. **This is a placeholder — Claude Code must regenerate using actual field names before delivering the snippet to Jay.**

```javascript
fetch('https://canonniers-cards-worker.chisholm2000.workers.dev/render', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Cf-Access-Jwt-Assertion': document.cookie.split('CF_Authorization=')[1]?.split(';')[0] || ''
  },
  body: JSON.stringify({
    template: 'blueprint',       // change per render
    variant: 'with-cutout',
    team: 'u15',
    opponent_name: 'Vipères de Saint-Eustache',
    opponent_logo_url: 'https://cards.canonniersdequebec.ca/test/test-opponent-logo.png',
    game_date: '2026-05-24',
    game_time: '14:00',
    venue_name: 'Stade Canac',
    is_home: true,
    language: 'fr',
    cutouts: [
      {
        image_url: 'https://cards.canonniersdequebec.ca/test/test-cutout.png',
        preset: 'right-action'   // adjust per template; presets defined in render.ts
      }
    ]
    // Result Card additional fields: title_line_1, title_line_2 (or whatever the real names are)
  })
})
.then(r => r.json())
.then(console.log);
```

### Pass criteria (per template)

- HTTP 200 + PNG URL returned
- `card_id` row inserted in D1 `generated_cards` table
- PNG renders all design-system elements: wordmark/watermark, glass/wood/concrete textures, brand chip, all font weights, cutout layered at the template's intended slot
- No clipping
- `backdrop-filter` blur visible where used
- French strings render correctly (date formatting, accented characters)

### Fail criteria → stop, report, do NOT iterate without consultation

- Any HTTP 500 from worker
- Missing or misplaced design elements
- Cutout in wrong slot
- Fonts falling back to system serif (indicates @font-face regression or worker font injection issue)

---

## Open questions for Jay (answer before Claude Code starts, OR inline during execution)

1. **Result Card headline fields.** If `validateRenderRequest()` doesn't currently accept `title_line_1` / `title_line_2`-equivalent fields, do you want this directive to (a) extend the schema, or (b) hardcode placeholder text in the template for now and defer schema extension? Pick before Claude Code starts.
2. **Cutout presets.** The handoff mentions `right-action` as the preset used for game-day-v2. Do Blueprint, Result, Hype need new preset coordinate definitions in render.ts? Or do existing presets cover the three slots (center-top tall, behind score band, left-half tall)? If new presets needed, Claude Code adds them as part of this directive.
3. **JetBrains Mono.** If Result Card's `.vs-divider` looks broken in `ui-monospace` fallback, do you want to inject JBM into the worker (one-time font addition) or accept the fallback? Decide if/when it comes up.

---

## Rollback plan

Single commit, single deploy. Two-step rollback:

```powershell
# Code rollback
git revert <commit-sha>
git push origin d06-blueprint-result-hype

# Worker rollback (use captured pre-deploy version ID from pre-flight step 2)
cd canonniers-cards-worker
wrangler rollback --version-id 010a2fa7-8f3c-4922-a432-8b0686a26534
```

R2 templates can stay uploaded — they're inert until the worker router references them. No need to delete on rollback.

D1 rows for failed smoke renders are harmless — leave them. They'll show as orphaned `generated_cards` rows pointing at templates the worker no longer routes to.

---

## Out of scope (do NOT do)

- Schedule Card (5th template, undesigned)
- Double-Header Card (mothballed)
- `graphic-only` variants for any of the three
- Bilingual / English rendering
- Compose-stage UI (D03)
- Admin Social tool `/render` caller wiring (D03)
- Real player cutout integration
- Real opponent logo integration from Spordle
- Photo Library integration for cutouts
- JetBrains Mono injection unless Result Card explicitly fails on it

---

## Attack vectors / how this can break

1. **Field-name mismatch.** If Claude Code guesses field names instead of reading render.ts, smoke renders 4xx and the directive is wasted. Mitigation: pre-flight step 4 is mandatory.
2. **Preview artifacts ship to production.** If Claude Code misses a leftover demo string in one of the source HTMLs (the "DOUBLE HEADER" tagline pattern from D05), it renders into the smoke card. Mitigation: pre-flight step 7 requires reporting all preview artifacts before patching.
3. **Template router includes-check breaks game-day / game-day-v2.** If the router edit is sloppy, existing templates 4xx. Mitigation: deploy gates (`tsc --noEmit` + `--dry-run`) catch type errors; smoke render at minimum one existing template after deploy if there's any doubt.
4. **Cache stale.** Worker fetches old R2 template because `?v=N` wasn't bumped. Mitigation: pre-flight step 4 captures the current `?v` value per template; patch bumps each.
5. **Font weight missing.** If a template uses a weight outside 400/500/600/700/800/900, render falls back to system font. Mitigation: pre-flight step 7 requires confirming weights are in range; if not, stop and report before patching.
6. **base.css regression.** If `@font-face` is back in base.css (it shouldn't be, but verify), Puppeteer cross-origin font fetch fails → DOMException → 500. Mitigation: pre-flight step 6.

---

**End of directive.**
