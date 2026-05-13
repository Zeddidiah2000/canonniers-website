# Directive: Swap Canonniers logo asset in Social Admin tool

**Date:** 2026-05-08
**File touched:** `admin-social.html`
**Scope:** 1 line change
**Risk:** Low (string swap, isolated to game-day card generator)
**Rollback:** Single revert commit

---

## Background

JP wants the Social admin tool's Game Day Card generator to use `CANONNIERS-LOGO.png` (the official organization logo, already deployed at the site root) instead of the legacy `AAACanonLogo.png`. Opponent logos remain unchanged — only the Canonniers asset is swapped.

The old asset (`AAACanonLogo.png`) is referenced in exactly one place: the `Promise.all` block in the game-day card render flow.

---

## Pre-flight verification

Run before applying the patch:

1. Confirm the new asset is reachable and same-origin (required for canvas, since `crossOrigin='anonymous'` is set):
   ```
   curl -sI https://canonniersdequebec.ca/CANONNIERS-LOGO.png | head -20
   ```
   Expect: `HTTP/2 200`, `content-type: image/png` (or image/jpeg — note actual type), and `access-control-allow-origin` either absent (same-origin works) or `*`.

2. Confirm only one occurrence of the old URL exists in the repo:
   ```
   grep -rn "AAACanonLogo" .
   ```
   Expect: 1 match, in `admin-social.html` line 1312. If matches appear in other files (`index.html`, `coach.html`, etc.), STOP and report — those are separate decisions and not in scope for this directive.

3. Confirm working tree is clean before patch:
   ```
   git status
   ```

---

## Patch

**File:** `admin-social.html`

**Find (exact match, line 1312):**
```js
    loadImg('https://canonniersdequebec.ca/AAACanonLogo.png'),
```

**Replace with:**
```js
    loadImg('https://canonniersdequebec.ca/CANONNIERS-LOGO.png'),
```

That is the entire patch. No other lines change.

---

## Commit

```
git add admin-social.html
git commit -m "admin-social: swap Canonniers logo asset to official CANONNIERS-LOGO.png

JP request: standardize on the official organization logo for all
generated game-day cards. Opponent logos unchanged."
git push origin main
```

---

## Post-deploy verification

After Cloudflare Pages auto-deploys (~1–2 min):

1. **Hard-reload** `https://canonniersdequebec.ca/admin-social.html` (the file already cache-busts the logo with `?t=Date.now()`, but reload the HTML itself).

2. Open the Game Day Card generator, pick any upcoming match, click **Generate**.

3. Visually verify on the rendered card:
   - **Centre watermark** (large, low-opacity background logo) — should be the new `CANONNIERS-LOGO.png`.
   - **Left team logo** in the matchup row — same new logo.
   - **Right team logo** — opponent logo, unchanged.

4. Open DevTools Network tab, filter to `LOGO`, confirm the request is to `CANONNIERS-LOGO.png` and returns **200**, not 404.

5. Click **Download PNG**. Confirm the downloaded file uses the new logo (rules out canvas tainting / silent SecurityError).

6. Smoke-test fallback: pick a match where the opponent has no logo in Spordle. Confirm the card still renders (Canonniers logo present, opponent slot blank or graceful fallback as before).

---

## Open questions for Claude Code

1. After running the `grep` in pre-flight step 2 — are there other references to `AAACanonLogo.png` anywhere in the repo? If yes, list them and stop. We'll decide separately whether each one should also be swapped or left alone.

2. Confirm the new file's actual content-type from the curl response. If it's `image/jpeg` despite the `.png` extension, flag it — browsers will render it fine but it's worth noting in commit history for future debugging.

---

## Rollback plan

If anything renders wrong (broken card, canvas SecurityError, missing logo, layout regression):

```
git revert HEAD
git push origin main
```

Cloudflare Pages will redeploy the previous version within 1–2 minutes. The change is a pure string swap with no schema, dependency, or routing implications, so revert is fully sufficient — no DB rollback, no cache purge required (the `?t=` cache-buster already handles asset cache).

---

## Out of scope (deliberately)

- Replacing `AAACanonLogo.png` references anywhere else (homepage, coach pages, etc.) — separate decision, not requested by JP for this change.
- Removing or renaming the legacy `AAACanonLogo.png` asset on Cloudflare Pages — leave it in place; deletion is a separate cleanup task once we confirm nothing else references it.
- Opponent logo handling — unchanged.
