# DIRECTIVE: Auth Fix — Switch to Cloudflare Access Identity Endpoint

## Problem
The current `initAuth()` in `admin.html` calls the auth Worker directly via fetch. Cloudflare Access intercepts that call and redirects to the login page instead of injecting the JWT. Result: CORS error, "Access not authorized" shown to authenticated users.

## Root Cause
Cloudflare Access does not inject `Cf-Access-Jwt-Assertion` into client-side fetch calls made from the browser. It only injects headers into server-side requests. The Worker JWT approach cannot work from client JS.

## Solution
Two-step identity flow:
1. Fetch identity (email) from Cloudflare Access's built-in identity endpoint — same-origin accessible to authenticated sessions, no JWT parsing needed
2. Pass email to the role Worker as a query param to get the role

---

## PRE-FLIGHT — Read before touching anything

1. Read current `admin.html` from GitHub:
   `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin.html`
   Confirm `initAuth()` is fetching `canonniers-auth-worker.chisholm2000.workers.dev` directly. If not, stop and ask Jay.

2. Read current `workers/canonniers-auth-worker/index.js` from GitHub:
   `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/workers/canonniers-auth-worker/index.js`
   Confirm it is reading `Cf-Access-Jwt-Assertion` header. If not, stop and ask Jay.

---

## CHANGE 1 — Update `workers/canonniers-auth-worker/index.js`

Replace the entire JWT parsing block with email query param reading. The ROLE_MAP lookup and CORS headers remain unchanged.

New `index.js`:

```js
export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://canonniersdequebec.ca',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const email = (new URL(request.url).searchParams.get('email') || '').toLowerCase().trim();

    if (!email) {
      return new Response(JSON.stringify({ error: 'No email provided' }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    let roleMap = {};
    try {
      roleMap = JSON.parse(env.ROLE_MAP);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'ROLE_MAP misconfigured' }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    const role = roleMap[email] || 'unknown';

    return new Response(JSON.stringify({ email, role }), {
      status: 200,
      headers: corsHeaders,
    });
  }
};
```

After writing the file, deploy the Worker:
```bash
cd workers/canonniers-auth-worker
wrangler deploy
```

Verify:
```bash
curl "https://canonniers-auth-worker.chisholm2000.workers.dev?email=jay@canonniers.ca"
```
Expected: `{"email":"jay@canonniers.ca","role":"admin"}` with status 200.

---

## CHANGE 2 — Update `admin.html` `initAuth()` function

Replace the existing `initAuth()` function only. All other JS remains unchanged.

Find this exact function signature:
```js
async function initAuth() {
```

Replace the entire function body with:

```js
async function initAuth() {
  const savedLang = localStorage.getItem('lang') || 'fr';
  setLang(savedLang);

  try {
    // Step 1: get identity from Cloudflare Access
    const idRes = await fetch('https://quebecsports.cloudflareaccess.com/cdn-cgi/access/get-identity', {
      credentials: 'include'
    });
    if (!idRes.ok) { showIdentityError(); return; }
    const identity = await idRes.json();
    const email = (identity.email || '').toLowerCase().trim();
    if (!email) { showIdentityError(); return; }

    // Step 2: get role from Worker
    const roleRes = await fetch(`https://canonniers-auth-worker.chisholm2000.workers.dev?email=${encodeURIComponent(email)}`);
    if (!roleRes.ok) { showIdentityError(); return; }
    const roleData = await roleRes.json();

    if (!roleData.role || roleData.role === 'unknown') { showIdentityError(); return; }

    currentUserEmail = email;
    currentUserRole  = roleData.role;
    showIdentityInfo(email, roleData.role);

  } catch (e) {
    showIdentityError();
  }
}
```

---

## COMMIT SEQUENCE

Two separate commits:

**Commit 1:** `fix: switch auth worker to email query param, remove JWT header dependency`
- `workers/canonniers-auth-worker/index.js`

**Commit 2:** `fix: update initAuth to use CF Access identity endpoint + role worker`
- `admin.html`

Push both to `main`.

---

## POST-DEPLOY VERIFICATION

1. In incognito, go to `canonniersdequebec.ca/admin.html`
2. Complete Cloudflare Access login with `jay@canonniers.ca`
3. Identity screen should show:
   - Logo
   - `jay@canonniers.ca`
   - Admin role badge
   - "Entrer →" button
4. Click Enter → tile grid renders with all tiles accessible
5. No errors in DevTools console

---

## MANUAL STEP — Jay does this in Cloudflare Zero Trust dashboard

After commits are pushed and deployed, Jay must remove the Worker hostname from the Access application:

- Zero Trust → Access controls → Applications → admin application → Edit → Destinations
- Delete the `canonniers-auth-worker.chisholm2000.workers.dev` entry
- Save

This entry is causing the redirect loop and must be removed.

---

## ROLLBACK PLAN

If identity endpoint returns non-ok (user not authenticated via Access):
- `showIdentityError()` fires — user sees "Access not authorized" with back-to-site link
- This is correct behavior for unauthenticated users

If role Worker returns `unknown`:
- `showIdentityError()` fires — email not in ROLE_MAP
- Fix: add email to ROLE_MAP secret via `wrangler secret put ROLE_MAP`

---

## OPEN QUESTIONS — Ask Jay if uncertain

1. Is the Cloudflare Access team domain `quebecsports` correct? Verify the identity endpoint URL is `https://quebecsports.cloudflareaccess.com/cdn-cgi/access/get-identity`
2. Should `unknown` role show a specific "contact admin" message rather than generic "access not authorized"?
