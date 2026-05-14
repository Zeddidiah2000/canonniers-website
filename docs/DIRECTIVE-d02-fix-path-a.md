# Directive: D02 Fix — Path A, Patch Puppeteer Font-Wait

**Owner:** Claude Code
**Status:** Patch + verify. Re-deploy expected.
**Blocks:** D03

---

## Context

`base.css` and `--canvas-w` apply correctly inside Puppeteer (probe confirmed). The visible bug is fonts: `document.fonts?.ready` resolves before the browser has actually loaded woff2 bytes, so the screenshot fires while Chromium is still in `font-display: block`'s grace period, and the PNG bakes in the sans-serif fallback.

Fix is narrow. No template redesign.

---

## Patch

In `src/render.ts`, replace the font-wait line:

```javascript
await page.evaluate('document.fonts?.ready');
```

with a force-load that triggers the woff2 fetch and waits for completion:

```javascript
await page.evaluate(async () => {
  await Promise.all([
    document.fonts.load('400 32px "Barlow Condensed"'),
    document.fonts.load('700 280px "Barlow Condensed"')
  ]);
  await document.fonts.ready;
});
```

Two reasons this is the right shape:
- Passes a function, not a string — eliminates the optional-chain no-op risk
- `document.fonts.load(...)` actively triggers the fetch for those specific weight/size combos; `ready` then waits for *those* loads, not for nothing

If multiple weights/sizes are used across the templates, add them all to the `Promise.all`. Read the templates and confirm which `font-weight` values they actually use before finalizing the list.

## Housekeeping (same commit)

- Remove the `CSS_PROBE` `console.log` line added during diagnostics
- Stop `wrangler tail` background process if still running

## Gate 1 — Local checks before deploy

```bash
tsc --noEmit
wrangler deploy --dry-run
```

Both clean.

## Deploy

```bash
wrangler deploy
```

Capture pre-deploy version ID (`a4f8f7b6-...`) for rollback.

## Post-deploy verification

One browser fetch via Claude in Chrome at `https://canonniersdequebec.ca/admin-social.html`. Use a fresh `opponent_name` (e.g. `'FontFix1'`) to bypass cache:

```javascript
const jwt = document.cookie.split(';').find(c => c.trim().startsWith('CF_Authorization='))?.split('=')[1];
const r = await fetch('https://canonniers-cards-worker.chisholm2000.workers.dev/render', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt },
  body: JSON.stringify({
    template: 'game-day',
    variant: 'graphic-only',
    team_id: 'u15',
    content: {
      opponent_name: 'FontFix1',
      game_date: '2026-06-15',
      game_time: '19:00',
      venue_name: 'Test',
      is_home: true,
      language: 'fr'
    }
  })
});
console.log('STATUS:', r.status);
console.log('BODY:', await r.text());
```

Expect 200. Open the returned R2 URL.

**Pass criteria:** wordmark renders as a tall, narrow, condensed font (Barlow Condensed). "CANONNIERS" letterforms fit cleanly within the canvas without clipping the C or S. The panel sits behind/over the wordmark per CSS z-index (panel `z:3` in front of wordmark `z:2`).

**Fail criteria:** "ANONNIER"-style clipping persists OR letterforms are wide/rounded (system fallback) OR panel/wordmark stacking is wrong.

Report status + body + visual assessment (or pass the PNG to Jay for visual review).

## Rollback

If verification fails:

```bash
wrangler rollback --name canonniers-cards-worker --version-id a4f8f7b6-4599-4d7f-8e33-6bf0b4ebcc0f
```

Report the failure mode. We re-scope from there.

## Commit message

```
fix(cards): force-load fonts before screenshot to prevent fallback bake-in

document.fonts.ready resolved early when no rendered text had kicked off
woff2 fetch by the time it was awaited. Replace with explicit document.fonts.load()
calls for the actual weight/size combos used in templates.

Also removes CSS_PROBE diagnostic logging from render.ts.
```

## Open questions

1. If `tsc --noEmit` or `--dry-run` fail, report and stop. Do not deploy through warnings.
2. If the templates use weights/sizes beyond `400 32px` and `700 280px`, list them and confirm the `Promise.all` list before deploying.

---

**End. One commit, one deploy, one verification fetch.**
