# Handoff — Cards Worker, End of 2026-05-13

**Status:** D02 pipeline verified end-to-end. Engine works. Action Blueprint template is being retired in favor of 4 (and one to be designed) Claude-designed HTML templates that match Jay's visual ambition.

**Pick-up point:** Adapter directive for first template (Game Day Card) into the cards-worker pipeline.

---

## TL;DR for the next session

1. Read this entire document first. Specifically the "What changed today" section.
2. The cards-worker engine is **shipped**. Don't reopen render.ts unless adapting templates surfaces a real bug.
3. Next directive is **template adapter, one template only** (Game Day Card). Replace hardcoded values with placeholders, swap Google Fonts → inline base64, upload to R2, render one card using Jay's real player cutout. Compare result against the HTML preview.
4. If it matches → adapt the other 3 templates + design the 5th. Then D03.
5. If it doesn't match → fix the adapter pattern before doing more templates.

---

## What changed today

### D02 fully shipped after a long debugging session

- Pipeline: browser → CF Access JWT → cards-worker → Puppeteer → R2/D1 → public URL. All verified end-to-end.
- Final verified render: `card_id: 9`, URL `https://cards.canonniersdequebec.ca/generated/game-day/with-cutout/4acc75154767c6af.png`. With-cutout variant rendered with test cutout in `right-action` preset. 200 status, fonts loaded, no clipping.

### Five bugs we burned through today (do NOT re-litigate)

1. **State drift** — D02 deployed worker (b32bbb0f) was never in git. Resolved: committed working tree to branch `d02-deployed-baseline`. Pushed to origin. Lesson: always verify deploy state matches git before any new work.
2. **A2 unrecoverable** — original Claude Code curl that "passed" D02 verification used unknown auth method. Marked unrecoverable, moved on.
3. **CSS hypothesis wrong** — initial hypothesis was that base.css wasn't loading in Puppeteer. Probe (`bodyWidth`, `bodyFontFamily`, `--canvas-w`) proved it was loading fine. Real bug was font loading.
4. **Font race condition** — `document.fonts?.ready` resolved before fonts actually started loading (read-only optional chain). Replaced with `document.fonts.load(...)` + `Promise.all` + `document.fonts.ready`. Patch deployed.
5. **Font CORS** — once `.load()` actively triggered fetch, base.css's `@font-face` linked to `cards.canonniersdequebec.ca` failed cross-origin from Puppeteer's `about:blank` context, threw DOMException → 500. Fix: removed `@font-face` from base.css, kept only the inline base64 injection in render.ts. Cache-busted templates with `?v=2/3`. Verified working.

### The Action Blueprint template renders correctly but looks programmer-drafted

After all bugs fixed, the rendered card is a thin geometric design (outlined wordmark, basic field SVG, semi-transparent panel). Compared to Jay's reference set (production cards images 1-5, plus the 8-style design spread), it's visually under-ambitious. **The render engine is fine. The template design is the problem.**

### Pivot: Claude-designed templates

Jay used Claude Design (claude.ai visualizer / artifacts) to produce 4 new HTML templates in a coherent design system:

- **Game_Day_Card.html** — chrome wordmark, glassmorphism info panel, spotlight backdrop, cutout preset bottom-right
- **Blueprint_Card.html** — wood-panel backing, schematic baseball field lineart, glowing cyan frame, cutout center-top
- **Result_Card.html** — wood-plank background, watermark wordmark + logo, score band, cutout layered behind score band
- **Hype_Card.html** — concrete wall texture, graffiti accents (read partially — not in detail yet)

5th template to be designed in next session.

These templates are **professional-grade** and solve the design ambition gap. They use:
- Layered SVG turbulence noise for grain/wood/concrete textures
- `backdrop-filter: blur()` for frosted glass panels
- Chrome-gradient `-webkit-background-clip: text` for hero wordmarks
- Multiple `drop-shadow()` stacks on cutouts for depth
- Proper z-index stacks designing where player goes in front of/behind decorations
- Three-tier opponent-name sizing (`.tier1/2/3` with `-webkit-line-clamp`) — solves the long-Quebec-team-name overflow bug

The four template files are in Jay's project. Read them in full before starting the adapter directive.

### Jay's player cutout PNG

Jay uploaded a real player cutout: ~2-3000px tall, clean alpha channel, batter in mid-stance with raised bat, light blue Canonniers jersey, black helmet. This is what should be used for the adapter test render, NOT the test-cutout PNG.

Path: Jay will need to make it accessible to the worker. Options:
- Upload to R2 at `r2://canonniers-cards/test/jay-player.png` (mirrors current `test/test-cutout.png` pattern)
- Or use Photo Library if applicable

Pick whichever is faster. The player cutout is the right reference for visual evaluation — the test-cutout PNG is the team logo, not a player, so it doesn't stress-test the cutout-positioning behavior.

---

## What's actually deployed right now

- **canonniers-cards-worker version:** `cac4ac9b-fae8-4531-9e81-8a66b3bdf3fe` (or whatever Claude Code's last `wrangler deployments list` showed at session end — verify before doing anything)
- **GitHub branch `d02-deployed-baseline`:** pushed to origin, all D02 + font fix commits committed
- **D1:** v5b + v5c schema, `generated_cards` table has 9 rows (cards 1-9 from today's testing). Backup at `..\canonniers-backups\` before any future migration.
- **R2 bucket `canonniers-cards`:** templates at `templates/cards/game-day/{with-cutout,graphic-only}.html` with `?v=3` cache-bust, base.css at `templates/cards/_shared/css/base.css` (with `@font-face` removed), fonts at `templates/cards/_shared/fonts/barlow-condensed-{400,700}.woff2`, test-cutout PNG at `test/test-cutout.png`.
- **Public R2 domain:** `cards.canonniersdequebec.ca` serves all of the above.
- **CORS preflight:** working, headers verified.
- **Memory updated:** zone ID for canonniersdequebec.ca is `559a0c9a14fbb321bee49ee89f3d2d1c` (different from canonniers.ca zone — the project memory had the wrong one before).

---

## Open items NOT touched today

- **`wrangler` OAuth missing `cache_purge:edit` scope.** Tonight's blocker — couldn't purge R2 edge cache from CLI, used `?v=N` query-string cache-bust as workaround. Permanent fix: add API token with cache_purge scope, or accept the `?v=N` pattern forever (works, just ugly).
- **CSS_PROBE in render.ts** — removed in commit. Confirmed.
- **`d02-deployed-baseline` branch** — confirm pushed to origin if not already.
- **wrangler tail process** — was running on shell `b64u0n2es`. Confirm stopped.

---

## The directive for next session

Draft Directive #5 — Template Adapter (Game Day Card)

### Goal
Adapt `Game_Day_Card.html` into the cards-worker pipeline so it renders via `POST /render` with `template: 'game-day-v2'` (or whatever naming convention Jay prefers; keep current `template: 'game-day'` pointing at the existing template so nothing breaks).

### Work
1. **Read the source HTML in full.** All 544 lines of `Game_Day_Card.html`. Understand the layer structure, the font usage, the placeholder content (`Patriotes`, `Samedi · 24 Mai`, `19:30`, `Stade Canonnier · Québec`, etc.).
2. **Strip the preview wrapper.** Remove `.stage` + `transform: scale(calc(100vmin / 1080))` wrapper. Puppeteer renders at native 1080×1080.
3. **Replace hardcoded text with placeholders.** Use existing template variable convention (likely `{{opponent_name}}`, `{{date_text}}`, `{{time_text}}`, `{{venue_text}}`, `{{cutout_url}}`, etc.). Match the render contract's `content` object field names. See `render.ts` lines 43-87 for `validateRenderRequest()` — the field shape is defined there.
4. **Replace font loading.** Remove `<link href="https://fonts.googleapis.com/...">`. The render.ts inline base64 injection at lines 295-311 only handles Barlow Condensed 400 + 700. **JetBrains Mono is used in this template** (`--font-mono`). Either:
   - Add JetBrains Mono to the inline injection, OR
   - Confirm if `ui-monospace` system fallback is acceptable for the mono labels (probably is — Mac/Linux render `ui-monospace` cleanly; Puppeteer's Chromium does too)
   Pick one, document it.
5. **Add multi-preset cutout CSS.** Current template has one cutout position (`.cutout.demo` — `right: 40px; bottom: 60px; height: 720px`). Need four preset classes matching the render contract: `bottom-right`, `bottom-center`, `right-tall`, `right-action`. Pull coordinates from Action Blueprint's existing preset definitions in `render.ts` (or wherever they live). Apply class based on request's `preset` field.
6. **Add language switching.** Hardcoded French strings ("Game Day" panel-header, "Date" label, "vs" label) need bilingual support. Two options:
   - Two template files: `game-day-v2-fr.html`, `game-day-v2-en.html` (simpler, doubles file count)
   - Single template with `lang`-aware substitution by worker (more complex worker logic, single file)
   Recommend the two-file approach — easier to design-check each language.
7. **Upload templates to R2** with `--remote` flag. Cache-bust with `?v=1`.
8. **Add template registration in render.ts.** New template key (`game-day-v2` or similar) needs to be recognized by the worker's template router so it knows which HTML file to fetch.
9. **Deploy worker.** Same gate flow: `tsc --noEmit`, `wrangler deploy --dry-run`, commit, deploy.
10. **Verify with Jay's real player cutout.** Render one card with:
    - `template: 'game-day-v2'`
    - `variant: 'with-cutout'`
    - `team_id: 'u15'`
    - `content`: realistic-looking French data + `cutouts: [{ image_url: <Jay's player cutout R2 URL>, preset: 'bottom-right' }]`
11. **Visual comparison.** Jay opens both the static HTML preview and the rendered PNG side-by-side. Pass criteria: rendered PNG matches HTML preview within ~5% visual deviation (anti-aliasing differences are normal).

### Pass/fail criteria
- **Pass:** rendered PNG looks like HTML preview. Player cutout is layered correctly (in front of wordmark, behind info panel per template z-index). Fonts load, no clipping, no missing texture overlays. → Proceed to adapt other 3 templates + design 5th.
- **Fail:** any visual deviation that suggests pipeline bug rather than template-specific tweak. → Diagnose the adapter pattern before adapting more templates.

### Rollback
- Capture pre-deploy worker version ID
- Existing `game-day` template (Action Blueprint) stays in place
- Rollback is simply not switching to the new template — the existing one still works

### Do NOT do tonight
- Don't try to adapt all 4 templates in one go. Do one. Verify. Then scale.
- Don't redesign the templates. The HTML is the design. Adapt, don't rebuild.
- Don't touch render.ts core logic. The engine is shipped. Only changes should be:
  - Template router additions
  - Possibly font injection list expansion (if JetBrains Mono is needed)
  - Possibly cutout preset CSS additions

---

## What I (Jay) want from the next session

1. **Adapt Game Day Card.** Verify with my real player cutout. See if pipeline matches preview.
2. **If pass:** adapt the other 3, design the 5th in Claude Design, then start scoping D03 (compose stage).
3. **If fail:** diagnose the adapter pattern bug. Fix it. Then adapt the rest.

---

## Working relationship notes for next session

- **Claude Code does all operational work.** Wrangler, git, R2 uploads, file edits. I (Jay) only paste values from masked UIs, approve irreversible/billing, handle physical hardware.
- **I run PowerShell on Windows.** Any commands for me to run locally: `curl.exe`, backtick continuation, `$env:VAR`.
- **Directives delivered as `.md` files** (create_file + present_files), not inline.
- **Token efficiency matters.** No re-running checks "to be sure" if the data already exists. No defensive padding. Trim ratio target: ~50% less than first draft.
- **Trust verification output, not memory.** Today's session started with memory drift on D02 state. Verify state with API/wrangler before discussing.
- **I am THE admin and sole decision-maker.** JP is consulted occasionally; he is not a gate on design or scoping decisions.

---

## Files to read at the start of next session

1. **This handoff document.**
2. `Game_Day_Card.html` — full read, all 544 lines
3. `Blueprint_Card.html` — skim, understand z-index pattern
4. `Result_Card.html` — skim, understand watermark + score band pattern
5. `Hype_Card.html` — skim, understand graffiti texture pattern
6. `render.ts` (cards-worker) — specifically `validateRenderRequest()` (lines 43-87), inline font injection (lines 295-311), template fetch + screenshot path
7. `base.css` — current state (after `@font-face` removal)
8. Existing `templates/cards/game-day/with-cutout.html` and `graphic-only.html` — current Action Blueprint templates for reference (NOT to be modified — the new ones are net-new)

---

**End of handoff.** Next session starts with reading these files, then drafting Directive #5 for the Game Day Card adapter.
