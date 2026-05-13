# Directive 01 v2: Cards Worker Foundation

**Phase:** 1 of 5 (Card Generator Overhaul)
**Depends on:** ADR-001 v2 approved
**Estimated work:** ~2-3 hours for Claude Code
**Risk level:** Low — purely additive; nothing existing changes

**Changes from v1:**
- Auth approach corrected to match the proven admin-photos pattern (CF Access JWT verification + auth-worker call without service token)
- Part D (auth-worker token mutation) removed entirely — was solving a non-existent problem
- Open Question #2 resolved and removed
- Estimated time reduced from 3-4 hours to 2-3 hours

---

## Goal

Establish the infrastructure foundation for the new card generator:
1. New D1 table (`generated_cards`) with full v2 schema including all forward-looking columns
2. New R2 bucket (`canonniers-cards`) with public read
3. New Cloudflare Worker (`canonniers-cards-worker`) with skeleton endpoints, CF Access JWT auth, and role resolution via existing auth-worker

**Explicitly NOT in this directive:**
- Browser Rendering integration (Directive 02)
- Templates (Directive 02)
- Compose stage UI (Directive 03)
- Any changes to `admin-social.html` or `galerie.html` (Directives 03 and 05)
- Any changes to `canonniers-auth-worker` — it stays exactly as it is today

After this directive, the Worker exists and responds to authenticated requests, but no card can actually be rendered yet. That's intentional — this directive is a clean foundation, independently testable, fully rollbackable.

---

## Pre-Flight Verification

Run these checks before applying any changes. Halt and report if any fail.

### 1. Confirm current repo state

Fetch raw GitHub URLs to confirm baseline (do not rely on local UPDATE directory):

```bash
curl -sI https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/wrangler.toml
curl -sI https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/update_schema_v4_photos.sql
curl -sI https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin-photos.html
```

All three should return `200 OK`. If any 404s, halt and report — repo state isn't what we think.

### 2. Confirm D1 schema baseline

```bash
wrangler d1 execute canonniers-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"
```

Expected tables: `players`, `coaches`, `photos` (and any others added since these notes were last updated). **`generated_cards` MUST NOT exist.** If it does, halt — manual investigation needed before proceeding.

### 3. Confirm Cloudflare Workers Paid plan is active

This directive requires the Workers Paid plan (Browser Rendering free tier requires paid plan, even though we're not using Browser Rendering yet). Check:

```bash
wrangler whoami
```

Confirm account has Workers Paid. If on Free plan, halt — escalate to Jay before proceeding.

### 4. Confirm auth-worker is operational and reference its current behavior

The cards-worker depends on the existing auth-worker for role/team resolution. Verify it responds and document its current shape:

```bash
# Auth-worker accepts a plain ?email=X query, no auth header (matches admin-photos pattern)
curl -s "https://canonniers-auth-worker.chisholm2000.workers.dev?email=jay@canonniers.ca"
```

Expected: JSON body with `{role, teams}` shape. If 5xx or auth error, halt — auth-worker must be healthy first.

**Critical:** Note whether the auth-worker currently accepts unauthenticated calls or requires any header. This directive assumes it accepts plain `?email=X` calls, matching the admin-photos integration. If that assumption is wrong, halt and report — we need to know the current contract before adding a second consumer.

### 5. Confirm admin-photos integration pattern

Reference admin-photos.html lines 770-870 for the proven auth pattern. The cards-worker page-side code in Directive 03 will mirror this exactly. For this directive, we just need to confirm the auth-worker is reachable by Workers (not just browsers) — it should be, since Workers and browsers both make plain HTTPS calls.

### 6. Backup current D1 database

Before any schema migration, snapshot the database:

```bash
mkdir -p ../canonniers-backups
wrangler d1 export canonniers-db --remote --output ../canonniers-backups/canonniers-db-pre-cards-$(date +%Y%m%d-%H%M%S).sql
```

Confirm the backup file is non-empty and contains expected tables (grep for `CREATE TABLE players`).

---

## Proposed Patch

### Part A: D1 Schema Migration

**New file: `update_schema_v5_cards.sql`** at repo root.

```sql
-- Migration v5: Add generated_cards table for the new card generator system
-- Per ADR-001 v2 (2026-05-09)
-- Idempotent: safe to re-run; uses IF NOT EXISTS

CREATE TABLE IF NOT EXISTS generated_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  season TEXT NOT NULL,
  template TEXT NOT NULL,
  lang TEXT NOT NULL,
  size_variant TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_game ON generated_cards(game_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cards_team_season ON generated_cards(team_id, season, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_cards_published ON generated_cards(game_id, published)
  WHERE deleted_at IS NULL AND archived = 0;

CREATE INDEX IF NOT EXISTS idx_cards_season ON generated_cards(season, created_at DESC)
  WHERE deleted_at IS NULL;
```

**Apply with:**

```bash
wrangler d1 execute canonniers-db --remote --file=update_schema_v5_cards.sql
```

### Part B: R2 Bucket Creation

Create the R2 bucket via wrangler:

```bash
wrangler r2 bucket create canonniers-cards
```

**Configure public access** via Cloudflare dashboard (cannot be done via wrangler):
1. Cloudflare dashboard → R2 → `canonniers-cards` → Settings
2. Public access → "Allow Access" via custom domain
3. Custom domain: `cards.canonniersdequebec.ca`
4. CORS policy: Allow `GET` from `https://canonniersdequebec.ca` and `https://www.canonniersdequebec.ca`
5. **Do NOT enable bucket listing** — keep `s3:ListBucket` disabled

DNS record (Cloudflare DNS for `canonniersdequebec.ca` zone):
- Add CNAME `cards` → `<bucket-id>.r2.cloudflarestorage.com` (Cloudflare auto-creates this when you add the custom domain in step 3)
- Proxy: ON (orange cloud)

**Verify:** After DNS propagates (~1 min), `curl -sI https://cards.canonniersdequebec.ca/` should return `404` (empty bucket, no listing) — not a connection error.

### Part C: Cards Worker

**New directory: `workers/canonniers-cards-worker/`** at repo root.

**File: `workers/canonniers-cards-worker/wrangler.toml`**

```toml
name = "canonniers-cards-worker"
main = "src/index.js"
compatibility_date = "2026-05-01"

[[d1_databases]]
binding = "DB"
database_name = "canonniers-db"
database_id = "<COPY FROM EXISTING wrangler.toml>"

[[r2_buckets]]
binding = "CARDS_BUCKET"
bucket_name = "canonniers-cards"

[vars]
AUTH_WORKER_URL = "https://canonniers-auth-worker.chisholm2000.workers.dev"
ALLOWED_ORIGIN = "https://canonniersdequebec.ca"
ENVIRONMENT = "production"

# Secrets (set via `wrangler secret put`):
# - CF_ACCESS_AUD          (CF Access audience tag for AuthCanonniers app)
# - CF_ACCESS_TEAM_DOMAIN  (e.g. "canonniers.cloudflareaccess.com")
#
# NOTE: No service token to auth-worker — matches existing admin-photos pattern.
# Auth-worker accepts plain ?email=X queries from any caller.
```

**File: `workers/canonniers-cards-worker/src/index.js`**

```javascript
/**
 * canonniers-cards-worker
 * 
 * Foundation Worker for the card generator system.
 * Per ADR-001 v2 (2026-05-09) and Directive 01 v2.
 * 
 * Auth pattern matches admin-photos.html reference implementation:
 *   1. Verify CF Access JWT (cf-access-jwt-assertion header)
 *   2. Extract email from verified JWT
 *   3. Call auth-worker?email=X to resolve {role, teams}
 * 
 * Endpoints:
 *   GET  /health           - liveness check (no auth)
 *   GET  /preview          - placeholder, returns 501 in this directive
 *   POST /render           - placeholder, returns 501 in this directive
 *   GET  /list?game_id=X   - returns cards for a game
 *   POST /delete           - soft delete (admin only)
 *   GET  /photos           - placeholder, returns 501 in this directive
 * 
 * Rate limiting: enforced at Cloudflare zone level (Rate Limiting Rules)
 */

import { verifyAccessJwt } from './auth.js';
import { resolveRole } from './role.js';
import { jsonResponse, errorResponse, corsHeaders } from './http.js';
import { handleList } from './handlers/list.js';
import { handleDelete } from './handlers/delete.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // Health check (no auth)
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ status: 'ok', version: 'directive-01-v2' }, env);
    }

    // All other endpoints require CF Access JWT
    let identity;
    try {
      identity = await verifyAccessJwt(request, env);
    } catch (err) {
      return errorResponse(401, 'Unauthorized', env);
    }

    // Resolve role + teams via auth-worker (no service token; plain query, matches admin-photos)
    let authContext;
    try {
      authContext = await resolveRole(identity.email, env);
    } catch (err) {
      return errorResponse(403, 'Role resolution failed', env);
    }

    // Route
    try {
      if (url.pathname === '/preview' && request.method === 'GET') {
        return errorResponse(501, 'Not implemented in directive 01', env);
      }
      if (url.pathname === '/render' && request.method === 'POST') {
        return errorResponse(501, 'Not implemented in directive 01', env);
      }
      if (url.pathname === '/photos' && request.method === 'GET') {
        return errorResponse(501, 'Not implemented in directive 01', env);
      }
      if (url.pathname === '/list' && request.method === 'GET') {
        return handleList(request, env, authContext);
      }
      if (url.pathname === '/delete' && request.method === 'POST') {
        return handleDelete(request, env, authContext);
      }
      return errorResponse(404, 'Not found', env);
    } catch (err) {
      console.error('Handler error:', err);
      return errorResponse(500, 'Internal server error', env);
    }
  }
};
```

**File: `workers/canonniers-cards-worker/src/auth.js`**

```javascript
/**
 * Verify Cloudflare Access JWT.
 * Matches the CF Access JWKS verification pattern used by admin-photos's
 * upstream gating (admin-photos relies on /cdn-cgi/access/get-identity in
 * the browser; here we verify the JWT server-side because workers.dev
 * subdomain isn't behind Access — only canonniersdequebec.ca/admin* is).
 * 
 * The page (admin-social.html) will attach the cf-access-jwt-assertion
 * header on its calls to this Worker, sourced from document.cookie
 * (CF_Authorization) or from /cdn-cgi/access/get-identity headers.
 */

const JWKS_CACHE = new Map();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function verifyAccessJwt(request, env) {
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    throw new Error('Missing CF Access JWT');
  }

  const [headerB64, payloadB64, signatureB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new Error('Malformed JWT');
  }

  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));

  // Validate audience
  const expectedAud = env.CF_ACCESS_AUD;
  if (!expectedAud) throw new Error('CF_ACCESS_AUD not configured');
  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(expectedAud)
    : payload.aud === expectedAud;
  if (!audMatches) throw new Error('Invalid audience');

  // Validate expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('JWT expired');
  if (payload.nbf && payload.nbf > now) throw new Error('JWT not yet valid');

  // Validate signature against JWKS
  const jwks = await fetchJwks(env);
  const key = jwks.keys.find(k => k.kid === header.kid);
  if (!key) throw new Error('Signing key not found');

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = Uint8Array.from(
    atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0)
  );

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    data
  );

  if (!valid) throw new Error('Invalid signature');

  return { email: payload.email, sub: payload.sub };
}

async function fetchJwks(env) {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  if (!teamDomain) throw new Error('CF_ACCESS_TEAM_DOMAIN not configured');
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;

  const cached = JWKS_CACHE.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.jwks;
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error('JWKS fetch failed');
  const jwks = await res.json();

  JWKS_CACHE.set(url, { jwks, expiresAt: Date.now() + JWKS_TTL_MS });
  return jwks;
}
```

**File: `workers/canonniers-cards-worker/src/role.js`**

```javascript
/**
 * Resolve role and teams via call to canonniers-auth-worker.
 * 
 * Matches admin-photos pattern exactly: plain ?email=X query, no auth header.
 * Auth-worker is intentionally open in current architecture — Cloudflare Access
 * gates the admin pages upstream, and any caller (browser, Worker) can resolve
 * an arbitrary email to a role/teams response. This is acceptable because:
 *   1. The auth-worker only returns role/teams data, no PII or secrets
 *   2. The cards-worker has already verified the JWT and extracted a real email
 *   3. Adding service-token gating to auth-worker would break admin-photos and
 *      is a separate, system-wide hardening concern (see backlog).
 */

export async function resolveRole(email, env) {
  if (!email) throw new Error('Email required');

  const url = new URL(env.AUTH_WORKER_URL);
  url.searchParams.set('email', email);

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(`Auth worker returned ${res.status}`);
  }

  const body = await res.json();
  // Expected shape: { role: 'admin'|'coach'|..., teams: ['15U'] | ['*'] | [] }
  if (!body.role || !Array.isArray(body.teams)) {
    throw new Error('Invalid auth-worker response');
  }

  return {
    email,
    role: body.role,
    teams: body.teams,
    isAdmin: body.role === 'admin',
    canAccessTeam: (teamId) => body.role === 'admin' || body.teams.includes(teamId)
  };
}
```

**File: `workers/canonniers-cards-worker/src/http.js`**

```javascript
/**
 * Shared HTTP helpers.
 */

export function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, cf-access-jwt-assertion',
    'Access-Control-Max-Age': '600'
  };
}

export function jsonResponse(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env)
    }
  });
}

export function errorResponse(status, message, env) {
  return jsonResponse({ error: message }, env, status);
}
```

**File: `workers/canonniers-cards-worker/src/handlers/list.js`**

```javascript
/**
 * GET /list?game_id=X[&published=1]
 * 
 * Returns cards for a specific game.
 * Public (published=1) callers get only published, non-archived cards.
 * Authenticated admin/coach callers get all cards (including unpublished) for their accessible teams.
 */

import { jsonResponse, errorResponse } from '../http.js';

export async function handleList(request, env, authContext) {
  const url = new URL(request.url);
  const gameId = url.searchParams.get('game_id');
  const publishedOnly = url.searchParams.get('published') === '1';

  if (!gameId) {
    return errorResponse(400, 'game_id required', env);
  }

  // Validate game_id is alphanumeric to prevent injection in indexed lookup
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(gameId)) {
    return errorResponse(400, 'Invalid game_id format', env);
  }

  let query;
  let bindings;

  if (publishedOnly) {
    // Public-facing query: only published, non-archived
    query = `
      SELECT id, game_id, team_id, template, lang, size_variant, r2_key,
             published_at, created_at, metadata
      FROM generated_cards
      WHERE game_id = ?
        AND published = 1
        AND archived = 0
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `;
    bindings = [gameId];
  } else {
    // Admin/coach view: all non-deleted, scoped to accessible teams
    if (!authContext.isAdmin) {
      // Coach: filter to their team only
      const team = authContext.teams[0];
      if (!team) return errorResponse(403, 'No team scope', env);
      query = `
        SELECT id, game_id, team_id, template, lang, size_variant, r2_key,
               published, published_at, archived, created_by, created_at, metadata
        FROM generated_cards
        WHERE game_id = ?
          AND team_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      bindings = [gameId, team];
    } else {
      // Admin: all teams
      query = `
        SELECT id, game_id, team_id, template, lang, size_variant, r2_key,
               published, published_at, archived, created_by, created_at, metadata
        FROM generated_cards
        WHERE game_id = ?
          AND deleted_at IS NULL
        ORDER BY created_at DESC
      `;
      bindings = [gameId];
    }
  }

  const result = await env.DB.prepare(query).bind(...bindings).all();

  // Transform r2_key to full URL for client convenience
  const cards = result.results.map(row => ({
    ...row,
    url: `https://cards.canonniersdequebec.ca/${row.r2_key}`
  }));

  return jsonResponse({ game_id: gameId, count: cards.length, cards }, env);
}
```

**File: `workers/canonniers-cards-worker/src/handlers/delete.js`**

```javascript
/**
 * POST /delete
 * Body: { id: number }
 * 
 * Soft-deletes a card. Admin only.
 * Sets deleted_at timestamp; row remains in DB for audit.
 * Does NOT remove the R2 object (deferred to a future cleanup job).
 */

import { jsonResponse, errorResponse } from '../http.js';

export async function handleDelete(request, env, authContext) {
  if (!authContext.isAdmin) {
    return errorResponse(403, 'Admin only', env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'Invalid JSON', env);
  }

  const id = parseInt(body.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return errorResponse(400, 'Invalid id', env);
  }

  const result = await env.DB.prepare(`
    UPDATE generated_cards
    SET deleted_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).bind(Math.floor(Date.now() / 1000), id).run();

  if (result.meta.changes === 0) {
    return errorResponse(404, 'Card not found or already deleted', env);
  }

  return jsonResponse({ deleted: true, id }, env);
}
```

### Part D: Set Worker Secrets

After deploying the Worker (next step), set the two required secrets:

```bash
cd workers/canonniers-cards-worker

# CF Access audience tag (from Cloudflare dashboard → Zero Trust → Access → Applications → AuthCanonniers → Overview tab → "Application Audience (AUD) Tag")
wrangler secret put CF_ACCESS_AUD
# Paste: <audience tag value, copied from dashboard>

# CF Access team domain (the canonniers.cloudflareaccess.com style URL)
wrangler secret put CF_ACCESS_TEAM_DOMAIN
# Paste: canonniers.cloudflareaccess.com  (or whatever the team domain is — visible in Zero Trust dashboard URL bar)
```

**That's it for secrets.** No service token to manage. No changes to auth-worker. No risk to admin-photos.

### Part E: Deploy Worker

```bash
cd workers/canonniers-cards-worker
wrangler deploy
```

### Part F: Cloudflare Rate Limiting Rule

Configure via Cloudflare dashboard (Rate Limiting Rules are zone-level, not Worker code):

1. Cloudflare dashboard → `canonniersdequebec.ca` zone → Security → WAF → Rate limiting rules
2. Create rule:
   - **Name:** `cards-worker-render-limit`
   - **Match:** Hostname equals `canonniers-cards-worker.chisholm2000.workers.dev` AND URI Path equals `/render`
   - **Counting characteristic:** `cf.access.user.email` (rate per Access identity)
   - **Period:** 1 day (86400 seconds)
   - **Requests per period:** 5
   - **Action:** Block, with custom JSON response: `{"error": "Daily render limit reached"}`, status 429
3. Deploy rule

**Note:** This rule has no effect in this directive (no `/render` endpoint exists yet — returns 501). It's pre-configured so it's ready when Directive 02 ships.

### Part G: Cost Guardrails

Set up via Cloudflare dashboard:
1. Workers & Pages → Compute (Workers) → Plan → Set monthly spend limit: **$5/month**
2. Notifications → Create notification → "Workers Subrequest Limit" → at 80% of plan limit → email to Jay
3. (Browser Rendering alerts come in Directive 02 when we actually start using it)

---

## Post-Deploy Verification

Run all of these. Each must pass before marking directive complete.

### 1. Health endpoint

```bash
curl -s https://canonniers-cards-worker.chisholm2000.workers.dev/health
# Expected: {"status":"ok","version":"directive-01-v2"}
```

### 2. Auth required on protected endpoints

```bash
curl -s -o /dev/null -w "%{http_code}" https://canonniers-cards-worker.chisholm2000.workers.dev/list?game_id=test
# Expected: 401 (no JWT)
```

### 3. CORS preflight

```bash
curl -s -o /dev/null -w "%{http_code}" -X OPTIONS \
  -H "Origin: https://canonniersdequebec.ca" \
  -H "Access-Control-Request-Method: GET" \
  https://canonniers-cards-worker.chisholm2000.workers.dev/list
# Expected: 204
```

### 4. D1 schema verification

```bash
wrangler d1 execute canonniers-db --remote --command "
  SELECT sql FROM sqlite_master WHERE name='generated_cards';
"
# Expected: full CREATE TABLE statement matching update_schema_v5_cards.sql
```

```bash
wrangler d1 execute canonniers-db --remote --command "
  SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='generated_cards';
"
# Expected 4 indexes: idx_cards_game, idx_cards_team_season, idx_cards_published, idx_cards_season
```

### 5. R2 bucket reachable

```bash
curl -sI https://cards.canonniersdequebec.ca/
# Expected: 404 (empty bucket, no listing). NOT a connection error.
```

### 6. Authenticated /list returns empty result

The Worker is at `canonniers-cards-worker.chisholm2000.workers.dev` (NOT behind CF Access). To test authenticated endpoints, you need to provide a valid CF Access JWT. Two ways:

**Option A (browser, easiest for Jay):** Open `https://canonniersdequebec.ca/admin-photos.html` in a browser; you'll be challenged by CF Access OTP if not already logged in. Then in the browser DevTools console:

```javascript
// Grab the current Access JWT from cookie
const jwt = document.cookie.split(';').find(c => c.trim().startsWith('CF_Authorization='))?.split('=')[1];
// Test the cards-worker /list endpoint
fetch('https://canonniers-cards-worker.chisholm2000.workers.dev/list?game_id=test123', {
  headers: { 'cf-access-jwt-assertion': jwt }
}).then(r => r.json()).then(console.log);
// Expected: {"game_id":"test123","count":0,"cards":[]}
```

**Option B (curl, requires manual JWT extraction):** Get the `CF_Authorization` cookie value from a browser session as above, then:

```bash
JWT="<paste cookie value>"
curl -s -H "cf-access-jwt-assertion: $JWT" \
  "https://canonniers-cards-worker.chisholm2000.workers.dev/list?game_id=test123"
# Expected: {"game_id":"test123","count":0,"cards":[]}
```

### 7. admin-photos still works

Open `admin-photos.html` in browser. Confirm:
- Page loads
- CF Access challenge appears if not logged in (and accepts the OTP)
- Identity check resolves (`/cdn-cgi/access/get-identity` returns email)
- Auth-worker call succeeds (returns role/teams)
- Photo list loads from existing photos system

If broken, the auth-worker has been changed somehow — but this directive doesn't touch auth-worker, so this should be impossible. If broken, halt and investigate before proceeding.

### 8. Existing systems untouched

- Visit `canonniersdequebec.ca` homepage — loads normally
- Visit `admin-social.html` — loads normally, all existing functions work
- Visit `galerie.html` — loads normally
- Run `wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) FROM players;"` — count matches pre-migration count
- Run `wrangler d1 execute canonniers-db --remote --command "SELECT COUNT(*) FROM photos;"` — count matches pre-migration count

---

## Open Questions for Claude Code

Resolve these before applying. Halt and report; don't guess.

1. **Does `update_schema_v3_*.sql` exist?** This directive assumes v3 was skipped (going from v2 → v4 → v5). If v3 actually exists in the repo, renumber this migration to whatever the next number is.

2. **What's the existing R2 bucket configuration pattern?** The project uses Cloudflare Images (not R2) for photos, so this may be the first R2 bucket. If so, follow the dashboard steps in Part B. If a previous R2 bucket exists with a different public-access pattern, match it.

3. **CF Access AUD value:** This is in the Cloudflare Zero Trust dashboard, not in code. Claude Code cannot retrieve it autonomously — Jay must paste it when running `wrangler secret put`. Confirm Jay knows where to find it (Zero Trust → Access → Applications → AuthCanonniers → Overview tab).

4. **wrangler.toml database_id:** The placeholder `<COPY FROM EXISTING wrangler.toml>` must be filled in with the actual D1 database ID from the project root's `wrangler.toml`. Do not commit a wrong value.

---

## Rollback Plan

Each part is independently rollbackable. Execute in reverse order if any post-deploy verification fails.

### Rollback Worker
```bash
cd workers/canonniers-cards-worker
wrangler delete
# Confirms deletion of canonniers-cards-worker
```

### Rollback rate limiting rule
Cloudflare dashboard → WAF → Rate limiting rules → delete `cards-worker-render-limit`

### Rollback R2 bucket
```bash
# First empty the bucket (should already be empty at this stage)
wrangler r2 bucket delete canonniers-cards
```
Then in Cloudflare dashboard, remove the `cards.canonniersdequebec.ca` DNS CNAME and the public-access custom domain configuration.

### Rollback D1 schema
```bash
wrangler d1 execute canonniers-db --remote --command "
  DROP INDEX IF EXISTS idx_cards_game;
  DROP INDEX IF EXISTS idx_cards_team_season;
  DROP INDEX IF EXISTS idx_cards_published;
  DROP INDEX IF EXISTS idx_cards_season;
  DROP TABLE IF EXISTS generated_cards;
"
```

### Catastrophic rollback
If anything is unrecoverable, restore D1 from the backup taken in Pre-Flight #6:
```bash
# THIS WIPES THE LIVE DATABASE — only use as last resort, verify with Jay first
wrangler d1 execute canonniers-db --remote --file=../canonniers-backups/canonniers-db-pre-cards-<timestamp>.sql
```

**Note:** Auth-worker is not touched by this directive, so no auth-worker rollback exists.

---

## What Ships After This Directive

- ✅ `generated_cards` D1 table exists with full v2 schema and 4 indexes
- ✅ `canonniers-cards` R2 bucket exists with public read at `cards.canonniersdequebec.ca`
- ✅ `canonniers-cards-worker` deployed at `canonniers-cards-worker.chisholm2000.workers.dev`
- ✅ Worker enforces CF Access JWT verification on all non-health endpoints
- ✅ Worker resolves role/teams via the existing `canonniers-auth-worker` (no changes to auth-worker)
- ✅ `/health` returns `{"status":"ok"}`
- ✅ `/list?game_id=X` returns empty card list for any game (no cards exist yet)
- ✅ `/delete` enforces admin-only, returns 404 for any id (no cards exist yet)
- ✅ `/preview`, `/render`, `/photos` return 501 (deferred to later directives)
- ✅ Rate limiting rule for `/render` pre-configured (no effect until Directive 02)
- ✅ Cost guardrails set on Workers Paid plan
- ✅ All existing systems (admin-photos, admin-social, galerie, public site, auth-worker) untouched and verified working

**No card can actually be rendered yet. That's Directive 02.**

---

## Estimated Time

- Pre-flight: 10 minutes
- Part A (D1): 5 minutes
- Part B (R2 + DNS): 15 minutes (DNS propagation wait)
- Part C (Worker code): 30 minutes
- Part D (secrets): 10 minutes
- Part E (deploy): 5 minutes
- Part F (rate limiting rule): 10 minutes
- Part G (cost guardrails): 10 minutes
- Post-deploy verification: 20 minutes

**Total: ~2 hours of focused work, ~2-3 hours including troubleshooting.**

---

## Approval

Awaiting Jay's review of this directive. Once approved, deliver to Claude Code's UPDATE directory.
