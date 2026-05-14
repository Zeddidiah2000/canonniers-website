# Directive: D02 Fix — Diagnose Browser 500 on POST /render

**Owner:** Claude Code
**Status:** Diagnostic-only. No patches in this directive.
**Blocks:** D03

---

## Context

D02 deployed. CORS preflight verified via curl. Browser-originated `POST /render` from `admin-social.html` returns 500 on all six checks. CORS is not the cause — preflight passes, worker is reached, then 500s.

Claude Code's earlier curl tests passed, but **auth method used in those tests is unknown**. Resolve that first.

High-prior hypothesis: cards-worker's in-worker JWT verifier is new code, possibly not aligned with how browsers send `CF_Authorization`. Confirm with logs before patching.

---

## Stage A — Diagnose

### A1. State check

```bash
git fetch origin && git status && git log --oneline -5
wrangler deployments list --name canonniers-cards-worker | head -10
```

Confirm `main` is clean and deployed version matches HEAD. If not, stop and report.

### A2. Original curl

Find the curl command(s) used in the original Checks 3–7. Paste verbatim:
- Full command
- Response status + body of one passing call

Redact JWT/secret payloads (first 12 + last 8 chars only).

### A3. Real logs from one browser repro

Terminal 1:
```bash
wrangler tail canonniers-cards-worker --format=pretty
```

Browser DevTools console at `https://canonniersdequebec.ca/admin-social.html`:

```javascript
const jwt = document.cookie.split(';').find(c => c.trim().startsWith('CF_Authorization='))?.split('=')[1];
const r = await fetch('https://canonniers-cards-worker.chisholm2000.workers.dev/render', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': jwt },
  body: JSON.stringify({
    template: 'game-day', variant: 'graphic-only', team_id: 'u15', lang: 'fr',
    payload: { opponent_name: 'Diag', game_date: '2026-06-15', game_time: '19:00', venue: 'Test', home_away: 'home' }
  })
});
console.log(r.status, await r.text());
```

Paste raw output from both. Do not interpret.

### A4. Inspect verifier (parallel to A3)

Open the cards-worker JWT verification code. Report:
- Where it reads the JWT from (header / cookie / both)
- How `CF_ACCESS_AUD` + `CF_ACCESS_TEAM_DOMAIN` are used
- What happens on verification failure (throw / 401 / fall through)
- Whether `/render` calls `env.AUTH_WORKER` service binding as part of the request path

### A5. Stop

Report A2/A3/A4 verbatim. Await direction before any code change.

---

## Post-deploy verification (for whatever Stage B becomes)

Gates that stay:
- `tsc --noEmit` + `wrangler deploy --dry-run` clean before deploy
- Capture pre-deploy version ID for rollback
- Re-run Checks 3, 4, 5, 5b, 6, 7 from browser. All six return 200.

Rollback: `wrangler rollback --name canonniers-cards-worker --version-id <PREV>`

---

**End. Await Stage A output.**
