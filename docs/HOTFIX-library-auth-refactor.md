# Hotfix: Library Worker Auth Refactor

**Date:** 2026-05-12
**Severity:** Blocker — admin-photo-library.html and admin-roster.html library picker non-functional
**Cause:** CF Access JWT verification can't work from browser to *.workers.dev — cross-domain cookies don't flow
**Fix:** Refactor to bearer-token pattern matching admin-photos.html reference impl

---

## Jay's tasks

**Nothing.** Claude Code does everything below.

Jay only needs to:
1. Hand this file to Claude Code
2. Wait for completion report
3. Reload the browser and confirm photos load

---

## Claude Code's tasks

### Step 1: Pre-flight verification

Confirm current state by fetching raw GitHub files:

```bash
curl -s https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin-photo-library.html | grep -n "credentials: 'include'"
curl -s https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin-photo-library.html | grep -n "libFetch"
```

Expect 7 occurrences of `credentials: 'include'` in admin-photo-library.html per Claude in Chrome's diagnostic.

Read admin-photos.html lines 870-1500 to confirm the reference bearer-token pattern (PHOTO_TOKEN constant, get-identity + auth-worker bootstrap, Authorization: Bearer header on all worker calls).

### Step 2: Generate and set LIBRARY_TOKEN secret

```bash
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN"   # save somewhere temporarily
cd workers/library
echo "$TOKEN" | wrangler secret put LIBRARY_TOKEN
```

Note the token value — needed for Step 3 frontend code.

### Step 3: Refactor admin-photo-library.html

**Add LIBRARY_TOKEN constant** near the existing config constants (top of script block):

```javascript
const LIBRARY_TOKEN = '<paste-token-from-step-2>';
const LIBRARY_URL = 'https://canonniers-library-worker.chisholm2000.workers.dev';
```

**Refactor `libFetch` function** (currently around line 535):

```javascript
async function libFetch(path, opts = {}) {
  const headers = {
    'Authorization': `Bearer ${LIBRARY_TOKEN}`,
    ...(opts.headers || {}),
  };
  const res = await fetch(LIBRARY_URL + path, {
    ...opts,
    headers,
  });
  return res;
}
```

**Remove `credentials: 'include'`** from all 7 occurrences in this file (lines 497, 537, 629, 661, 755, 795, 817 per diagnostic — verify line numbers in actual current source).

**Keep** the `/cdn-cgi/access/get-identity` + auth-worker fetch on page load — those calls are to canonniersdequebec.ca (same origin) and canonniers-auth-worker (which has its own working auth model) and should remain unchanged.

### Step 4: Refactor admin-roster.html library picker

Find every fetch to `canonniers-library-worker.chisholm2000.workers.dev` in admin-roster.html. Apply the same changes:

- Add `LIBRARY_TOKEN` constant (same value as Step 3)
- Add `Authorization: Bearer ${LIBRARY_TOKEN}` header to each fetch
- Remove `credentials: 'include'` if present

### Step 5: Refactor workers/library/src/index.js

**Remove** the `verifyAccessJwt()` function and `getCallerIdentity()` function entirely.

**Replace** with a bearer token validator:

```javascript
async function getCallerIdentity(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);

  // Constant-time compare to prevent timing attacks
  if (token.length !== env.LIBRARY_TOKEN.length) return null;
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ env.LIBRARY_TOKEN.charCodeAt(i);
  }
  if (mismatch !== 0) return null;

  // Trust the admin page's role enforcement (matches admin-photos.html pattern).
  // Admin page is gated by CF Access on canonniersdequebec.ca/admin* — only
  // authorized users can reach a page that knows the bearer token.
  // Worker accepts shared identity: admin role, all teams.
  return {
    email: 'bearer-token-user@canonniers.ca',
    role: 'admin',
    teams: ['u15', 'u17d1', 'u17d2'],
  };
}
```

**Remove** all references to `CF_ACCESS_AUD` and `CF_ACCESS_TEAM_DOMAIN` since JWT verification no longer happens.

**Remove** the service binding to AUTH_WORKER from this worker's wrangler.toml (no longer needed for auth — auth-worker remains used by the admin pages themselves on the canonniersdequebec.ca origin).

**Optional secret cleanup** (defer, don't break things):

```bash
# DO NOT run these yet — confirm everything works first
# wrangler secret delete CF_ACCESS_AUD
# wrangler secret delete CF_ACCESS_TEAM_DOMAIN
```

**Important note on `caller` object semantics:** since the worker now treats every bearer-token-authed request as admin, the role/team filtering logic in the worker still works (admin sees everything) but it no longer enforces per-coach team scoping at the worker layer. Per-coach scoping is now enforced by the admin page UI, which is gated by CF Access on `/admin*`. Document this in `workers/library/src/index.js` as a comment at the top of the file and in CLAUDE.md.

### Step 6: Deploy worker

```bash
cd workers/library
wrangler deploy
```

### Step 7: Remove CF Access protection from library worker domain

The library worker no longer needs CF Access at the edge — bearer token validation in the worker is the gate now. Use the Cloudflare API to remove `canonniers-library-worker.chisholm2000.workers.dev` from the AuthCanonniers Access app's protected domains. This also eliminates the CORS preflight problem entirely.

If the wrangler OAuth token lacks Zero Trust scope (as in prior attempt), use the Cloudflare API token from `~/.wrangler/config/default.toml` or generate a scoped API token via `wrangler whoami` workflow. If neither works, document the limitation and Jay will do this single dashboard step.

### Step 8: Verification

Run these in order:

```powershell
# 1. Worker responds to OPTIONS without CF Access blocking (now that worker is removed from Access app)
curl.exe -i --ssl-no-revoke -X OPTIONS "https://canonniers-library-worker.chisholm2000.workers.dev/api/library" -H "Origin: https://canonniersdequebec.ca" -H "Access-Control-Request-Method: GET"
# Expect: 204 with Access-Control-Allow-Origin from the worker's own CORS handler

# 2. Worker rejects requests without bearer token
curl.exe -i --ssl-no-revoke "https://canonniers-library-worker.chisholm2000.workers.dev/api/library?filter=all"
# Expect: 401 Unauthorized

# 3. Worker accepts requests with correct bearer token
curl.exe -i --ssl-no-revoke "https://canonniers-library-worker.chisholm2000.workers.dev/api/library?filter=all" -H "Authorization: Bearer <token-from-step-2>"
# Expect: 200 with JSON body containing 306 photos

# 4. Worker rejects requests with wrong bearer token
curl.exe -i --ssl-no-revoke "https://canonniers-library-worker.chisholm2000.workers.dev/api/library?filter=all" -H "Authorization: Bearer wrongtoken"
# Expect: 401
```

### Step 9: Commit and push

```bash
git add admin-photo-library.html admin-roster.html workers/library/src/index.js workers/library/wrangler.toml
git commit -m "fix(library): refactor auth from CF Access JWT to bearer token

Cross-domain cookies don't flow from canonniersdequebec.ca to *.workers.dev,
so CF Access JWT verification at the worker layer couldn't see user auth.

Now matches admin-photos.html reference pattern:
- Bearer token validation in worker (constant-time compare)
- Admin page gated by CF Access on /admin* enforces user-level access
- Worker removed from AuthCanonniers Access app (no more CORS preflight issue)

Per Jay's memory entry #16, admin-photos.html is the reference impl — this
brings the library into alignment with that pattern."
git push origin main
```

### Step 10: Report back to Jay

Tell Jay:
- ✅ Refactor complete
- ✅ LIBRARY_TOKEN secret set on worker (token value: do NOT paste in chat, just confirm it's set)
- ✅ Worker removed from AuthCanonniers Access app (or note if Jay needs to do this manually)
- ✅ All 4 PowerShell verification tests passed
- ⏳ Ready for Jay's browser test

Ask Jay to:
1. Hard reload admin-photo-library.html (Ctrl+Shift+R)
2. Confirm the photo grid loads with 306 thumbnails
3. Open admin-roster.html, edit a player, click "Choose from library", confirm picker modal loads photos

---

## Rollback if anything goes wrong

```bash
git revert HEAD
git push origin main

# Re-add canonniers-library-worker domain to AuthCanonniers Access app if it was removed
# Worker secret LIBRARY_TOKEN can be left in place — harmless if not used
```

The 306 photos in R2 and the photo_library D1 table are untouched by this hotfix. Only auth code paths changed.

---

## Memory entry to add after success

Append to Claude's memory file:

> Library worker uses bearer-token auth pattern (matches admin-photos.html). LIBRARY_TOKEN secret on worker, Authorization: Bearer header from admin pages. CF Access JWT verification was attempted but fails cross-domain (canonniersdequebec.ca cookies don't flow to *.workers.dev). Same pattern likely applies to any future worker on workers.dev called from admin pages — use bearer-token, not CF Access JWT.
