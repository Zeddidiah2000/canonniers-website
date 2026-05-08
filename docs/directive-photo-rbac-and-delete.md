# Directive — Photo Gallery: Delete + Team RBAC + Ghost Row Cleanup

**Author:** Jay
**Date:** 2026-05-08
**Status:** Ready for Claude Code execution
**Estimated commits:** 5 (each independently testable + rollbackable)

---

## Context

Three problems to solve in one coordinated change:

1. **No delete capability.** Admin tool can upload photos but not remove them. When a photo needs to come down (wrong team, bad caption, parental request), there's no in-tool path.
2. **No team-level access control.** Any user with admin-photos access can upload to any team. The Worker accepts whatever `team_category` the client sends. Email format (`coach17d1@canonniers.ca`) implies team ownership but nothing enforces it.
3. **Ghost rows in D1.** Jay manually deleted CF Images assets via the Cloudflare dashboard for the `Test pour Zoom` event (19 photos). D1 still has the rows. Public gallery (`/galerie.html`) renders 19 gray placeholders because `<img>` tags 404 silently — `onload` never fires, opacity stays 0, tile keeps its gray background. Screenshot evidence in conversation history.

## Decisions made (don't re-litigate)

- **Delete model:** hard delete. CF Images asset deleted first, D1 row deleted second. No soft-delete column. No "hidden" state.
- **Auth source:** Cloudflare Access JWT → email → `auth-worker` returns `{ role, teams: string[] }`. Hybrid parser: `jay@canonniers.ca` hardcoded as admin-all-teams; everything else regex-matched.
- **Single-team users:** team selector **hidden entirely**, locked to their team. Admin sees all three.
- **Manage view scope:** all photos for the user's team(s). Admin sees everything. No session-only mode.
- **Server-side enforcement:** every write (POST upload-url, POST photos, DELETE photos) re-validates the caller's team against the resource. Client filtering is convenience, not security.

## Out of scope (don't touch)

- Replacing the JS-visible bearer token with Cloudflare Access JWT verification at the photo-worker level. That's a separate piece of debt on the roadmap.
- The `auth-worker` is presumed to already be Access-protected at its route. If it isn't, that's a P0 to fix before any of this ships.
- `info@`, `contact@`, `watchdog@` mailboxes — these get `role: 'unknown'` and are kicked out by existing logic in `admin.html`.

## Threat model

| Vector | Mitigation |
|---|---|
| Coach for U15 calls `DELETE /api/photos/42` where photo 42 is U17D1 | Worker fetches the row first, compares `photo.team_category` against caller's `teams[]`, returns 403 on mismatch |
| Coach POSTs upload with forged `team_category: 'u17d1'` | Worker ignores client-supplied team for non-admin roles; team is derived from caller identity |
| Public visitor calls `DELETE /api/photos/42` | Worker rejects requests without valid Authorization header (existing pattern) |
| `auth-worker` hit directly without Access JWT | `auth-worker` route must be Access-protected. **Verify this before shipping commit 2.** If not protected, this directive grants nothing — anyone can claim any role. |
| Admin A deletes photo while admin B is viewing same row | DELETE is idempotent; second request 404s harmlessly |
| CF Images delete succeeds, D1 delete fails (network blip mid-transaction) | Order: D1 delete first, CF delete second. If CF fails after D1 succeeds, log loudly but row is already gone — gallery is correct, CF asset is orphaned (cost: zero). Reconciler script (commit 5) handles cleanup periodically. |
| User deletes from CF dashboard directly (the bug we just hit) | Defensive `onerror` handler in `galerie.html` hides broken tiles. Plus reconciler script for existing 19 ghosts. Plus: user education — don't do that. |
| Admin accidentally clicks delete on wrong photo | Confirmation dialog with photo thumbnail + caption + event date. No "Delete All" button anywhere. |

## Order of operations for delete (important — read carefully)

```
DELETE /api/photos/:id

1. Verify Authorization header
2. Fetch photo row from D1 by id
   → if not found: 404 (idempotent — fine)
3. Verify caller's role/teams against photo.team_category
   → if mismatch: 403
4. DELETE row from D1                     ← happens first
   → if D1 fails: 500, abort, no CF call made
5. DELETE asset from CF Images API        ← happens second
   → if CF fails: log warning, return 200 anyway
     (D1 is the source of truth for the gallery; orphaned CF asset is cosmetic)
6. Return 200 { deleted: true }
```

**Why D1 first:** the gallery reads from D1. If D1 still has the row but CF asset is gone, you get the bug we're fixing. If D1 row is gone but CF asset remains, the gallery never tries to render it — user sees nothing wrong, asset is orphaned in CF (storage cost: trivial), reconciler cleans it up later.

---

# Pre-flight (Claude Code: do this before commit 1)

Confirm current state of the repo against GitHub raw:

```bash
curl -s https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin-photos.html | head -20
curl -s https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/galerie.html | head -20
curl -s https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin.html | grep -n "AUTH_WORKER_URL"
```

Expected:
- `admin-photos.html` has bearer token `ab7f1850ea95c64721a2f3a640d2f2d2af1c4330bc2b90d7` and references `https://photo-worker.chisholm2000.workers.dev`
- `galerie.html` has `img.onload` but no `img.onerror` (line ~435)
- `admin.html` references `https://canonniers-auth-worker.chisholm2000.workers.dev`

Confirm `auth-worker` source location. The worker repo is separate from the website repo. Identify which directory/repo holds it. **All commits 1, 4 below modify the auth-worker — confirm path before touching.**

Confirm `photo-worker` source location. Same — separate repo. **Commits 2, 3 modify it.**

If either worker source location is unclear, **stop and ask Jay before proceeding.**

Snapshot D1 before any of this:

```bash
wrangler d1 export canonniers-db --output=backups/$(date +%Y%m%d-%H%M)-pre-photo-rbac.sql --remote
```

Verify backup file exists and is non-empty before continuing.

---

# Commit 1 — `auth-worker`: return `{ role, teams: string[] }`

**Goal:** teach `auth-worker` about teams. No callers consume `teams` yet — this commit is purely additive and safe to deploy alone.

## Patch (auth-worker source)

Add team derivation. Pseudocode — exact syntax depends on existing worker structure:

```js
const ALL_TEAMS = ['u15', 'u17d1', 'u17d2'];

const TEAM_SUFFIX_MAP = {
  '15u':  'u15',
  '17d1': 'u17d1',
  '17d2': 'u17d2',
};

const ROLE_PATTERN = /^(coach|manager|social|photo|treasurer)(15u|17d1|17d2)@canonniers\.ca$/;

function resolveIdentity(emailRaw) {
  const email = String(emailRaw || '').toLowerCase().trim();

  // Hardcoded admin
  if (email === 'jay@canonniers.ca') {
    return { role: 'admin', teams: ALL_TEAMS };
  }

  // Pattern-matched roles
  const m = email.match(ROLE_PATTERN);
  if (m) {
    const role = m[1];
    const team = TEAM_SUFFIX_MAP[m[2]];
    if (team) return { role, teams: [team] };
  }

  return { role: 'unknown', teams: [] };
}
```

Replace the existing email→role lookup with this function. Response payload:

```json
{ "role": "coach", "teams": ["u17d1"] }
```

Existing consumers (`admin.html`) read `data.role` only — they keep working. The new `teams` field is ignored until commits 2 and 3 land.

## Verification

Hit the endpoint manually with `curl`:

```bash
# Admin
curl 'https://canonniers-auth-worker.chisholm2000.workers.dev?email=jay@canonniers.ca'
# Expected: {"role":"admin","teams":["u15","u17d1","u17d2"]}

# Coach
curl 'https://canonniers-auth-worker.chisholm2000.workers.dev?email=coach17d1@canonniers.ca'
# Expected: {"role":"coach","teams":["u17d1"]}

# Social
curl 'https://canonniers-auth-worker.chisholm2000.workers.dev?email=social15u@canonniers.ca'
# Expected: {"role":"social","teams":["u15"]}

# Unknown
curl 'https://canonniers-auth-worker.chisholm2000.workers.dev?email=info@canonniers.ca'
# Expected: {"role":"unknown","teams":[]}

# Edge: typo / not in pattern
curl 'https://canonniers-auth-worker.chisholm2000.workers.dev?email=couch15u@canonniers.ca'
# Expected: {"role":"unknown","teams":[]}
```

Then load `https://canonniersdequebec.ca/admin.html` as Jay and confirm tiles still render correctly. Existing flow must not regress.

## Rollback

`git revert <commit-sha>` on the auth-worker repo. No D1 or upstream consumer depends on the new field yet.

---

# Commit 2 — `photo-worker`: enforce team RBAC on writes

**Goal:** Worker becomes the source of truth for "who can write to which team." Even if the admin-photos page is bypassed, the Worker rejects unauthorized writes.

**Prerequisite:** commit 1 deployed and verified.

## Patch (photo-worker source)

Add identity resolution at the top of every write handler. Replace the bearer-only check with bearer + Access JWT (or email lookup against auth-worker — match whatever pattern is already used elsewhere in the codebase).

```js
// Helper — derive identity from request
async function getCallerIdentity(request, env) {
  // Step 1: bearer auth (existing behavior)
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${env.PHOTO_TOKEN}`) {
    return { ok: false, status: 401, reason: 'missing or invalid bearer' };
  }

  // Step 2: derive email from CF Access JWT
  const jwt = request.headers.get('CF-Access-Jwt-Assertion');
  if (!jwt) {
    return { ok: false, status: 401, reason: 'missing access jwt' };
  }

  // Decode JWT payload (verify signature against CF Access JWKS — use existing helper if present)
  const email = await verifyAndExtractEmail(jwt, env);
  if (!email) {
    return { ok: false, status: 401, reason: 'invalid jwt' };
  }

  // Step 3: look up role/teams via auth-worker
  const r = await fetch(`${env.AUTH_WORKER_URL}?email=${encodeURIComponent(email)}`);
  if (!r.ok) return { ok: false, status: 502, reason: 'auth lookup failed' };
  const { role, teams } = await r.json();

  if (role === 'unknown' || !teams?.length) {
    return { ok: false, status: 403, reason: 'no role assigned' };
  }

  return { ok: true, email, role, teams };
}

// Helper — check team access
function callerCanWriteTeam(identity, team) {
  if (identity.role === 'admin') return true;
  return identity.teams.includes(team);
}
```

**Critical:** if the Worker doesn't currently see the Access JWT header, the Pages route or Worker route binding may strip it. **Verify this in pre-flight before commit 2.** If JWT isn't reaching the Worker, this commit is blocked until the route is reconfigured.

### Apply to existing handlers

**`POST /api/upload-url`:**

```js
const identity = await getCallerIdentity(request, env);
if (!identity.ok) return new Response(identity.reason, { status: identity.status });

const { team } = await request.json();

if (!callerCanWriteTeam(identity, team)) {
  return new Response('forbidden: team mismatch', { status: 403 });
}

// ... existing logic
```

**`POST /api/photos`:**

```js
const identity = await getCallerIdentity(request, env);
if (!identity.ok) return new Response(identity.reason, { status: identity.status });

const body = await request.json();

if (!callerCanWriteTeam(identity, body.team_category)) {
  return new Response('forbidden: team mismatch', { status: 403 });
}

// For non-admin roles, force team_category from identity (zero-trust on client)
if (identity.role !== 'admin') {
  body.team_category = identity.teams[0];
}

// ... existing logic
```

**Reads stay unauthenticated.** `GET /api/photos?team=u15` is public — that's how the gallery works.

## Verification

Manual `curl` tests with simulated Access headers (use a real session if possible):

```bash
# Coach U17D1 trying to upload to U15 → should be 403
curl -X POST https://photo-worker.chisholm2000.workers.dev/api/upload-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Jwt-Assertion: $COACH17D1_JWT" \
  -H "Content-Type: application/json" \
  -d '{"team":"u15","event_date":"2026-05-08"}'
# Expected: 403

# Coach U17D1 uploading to U17D1 → should succeed
curl -X POST https://photo-worker.chisholm2000.workers.dev/api/upload-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Jwt-Assertion: $COACH17D1_JWT" \
  -H "Content-Type: application/json" \
  -d '{"team":"u17d1","event_date":"2026-05-08"}'
# Expected: 200 with uploadURL

# Admin uploading to any team → should succeed
curl -X POST https://photo-worker.chisholm2000.workers.dev/api/upload-url \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Jwt-Assertion: $JAY_JWT" \
  -H "Content-Type: application/json" \
  -d '{"team":"u15","event_date":"2026-05-08"}'
# Expected: 200
```

Also: load `admin-photos.html` as Jay, upload one test photo to U15. Must still work end-to-end. **Don't merge if any existing flow regresses.**

## Rollback

`git revert` on photo-worker. Bearer-only auth restored. No data changes.

---

# Commit 3 — `photo-worker`: `DELETE /api/photos/:id`

**Goal:** add the delete endpoint with full RBAC and the correct order of operations.

**Prerequisite:** commit 2 deployed and verified.

## Patch

```js
// Router — add new case
if (request.method === 'DELETE' && url.pathname.startsWith('/api/photos/')) {
  return handleDeletePhoto(request, env, url);
}

async function handleDeletePhoto(request, env, url) {
  // 1. Auth
  const identity = await getCallerIdentity(request, env);
  if (!identity.ok) return new Response(identity.reason, { status: identity.status });

  // 2. Parse ID
  const id = parseInt(url.pathname.split('/').pop(), 10);
  if (!Number.isInteger(id) || id < 1) {
    return new Response('invalid id', { status: 400 });
  }

  // 3. Fetch photo row
  const photo = await env.DB
    .prepare('SELECT id, cf_image_id, team_category FROM photos WHERE id = ?')
    .bind(id)
    .first();

  if (!photo) {
    return new Response(JSON.stringify({ deleted: false, reason: 'not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 4. Team check
  if (!callerCanWriteTeam(identity, photo.team_category)) {
    return new Response('forbidden: team mismatch', { status: 403 });
  }

  // 5. Delete from D1 first
  try {
    await env.DB.prepare('DELETE FROM photos WHERE id = ?').bind(id).run();
  } catch (e) {
    console.error(`[delete-photo] D1 delete failed for id=${id}:`, e);
    return new Response('database error', { status: 500 });
  }

  // 6. Delete from CF Images second (best-effort)
  let cfStatus = 'deleted';
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1/${photo.cf_image_id}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
      }
    );
    if (!r.ok) {
      cfStatus = `cf_failed_${r.status}`;
      console.warn(`[delete-photo] CF Images delete failed for ${photo.cf_image_id}: HTTP ${r.status}`);
    }
  } catch (e) {
    cfStatus = 'cf_network_error';
    console.warn(`[delete-photo] CF Images delete error for ${photo.cf_image_id}:`, e);
  }

  return new Response(JSON.stringify({
    deleted: true,
    id,
    cf_status: cfStatus,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

## Worker secrets required

Confirm these exist in the photo-worker (likely already do for image upload):

```
PHOTO_TOKEN          # bearer for admin tool
CF_ACCOUNT_ID        # for CF Images API
CF_IMAGES_TOKEN      # CF Images API token with Images:Edit permission
AUTH_WORKER_URL      # full URL to auth-worker
```

If `CF_IMAGES_TOKEN` doesn't exist or doesn't have delete permission, **stop**. Create a new token in CF dashboard (User API Tokens → Create → custom permissions: `Account / Cloudflare Images / Edit`), bind via `wrangler secret put CF_IMAGES_TOKEN`, then continue.

## Verification

```bash
# Set up: upload one test photo as admin, note its id from D1
wrangler d1 execute canonniers-db --remote --command="SELECT id, cf_image_id, team_category FROM photos ORDER BY id DESC LIMIT 1"

# Test 1: coach U17D1 tries to delete a U15 photo → 403
curl -X DELETE https://photo-worker.chisholm2000.workers.dev/api/photos/$U15_PHOTO_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Jwt-Assertion: $COACH17D1_JWT"
# Expected: 403

# Test 2: admin deletes the test photo → 200
curl -X DELETE https://photo-worker.chisholm2000.workers.dev/api/photos/$TEST_PHOTO_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Jwt-Assertion: $JAY_JWT"
# Expected: {"deleted":true,"id":N,"cf_status":"deleted"}

# Test 3: confirm D1 row is gone
wrangler d1 execute canonniers-db --remote --command="SELECT * FROM photos WHERE id = $TEST_PHOTO_ID"
# Expected: empty result

# Test 4: confirm CF asset is gone (image URL should 404)
curl -I "https://imagedelivery.net/XuWXX2Hn8HGMN14wNLQAMA/$TEST_CF_IMAGE_ID/thumb"
# Expected: HTTP 404

# Test 5: idempotent — deleting same id again
curl -X DELETE https://photo-worker.chisholm2000.workers.dev/api/photos/$TEST_PHOTO_ID \
  -H "Authorization: Bearer $TOKEN" \
  -H "CF-Access-Jwt-Assertion: $JAY_JWT"
# Expected: 404 with {"deleted":false,"reason":"not found"}
```

## Rollback

`git revert`. No D1 schema changes. Any photos deleted during testing are gone for good — restore from D1 backup if needed.

---

# Commit 4 — `admin-photos.html`: team gating + manage view

**Goal:** UI catches up with the Worker. Single-team users see only their team. Everyone with access gets a manage/delete view for their team's photos.

**Prerequisite:** commits 1, 2, 3 deployed and verified.

## Patch

### 4a. Identity bootstrap

Add at the top of the existing script block, before `initPage()`:

```js
let CALLER_ROLE  = null;
let CALLER_TEAMS = [];

async function loadIdentity() {
  try {
    const idRes = await fetch('/cdn-cgi/access/get-identity', { credentials: 'include' });
    if (!idRes.ok) throw new Error('access identity failed');
    const { email } = await idRes.json();

    const roleRes = await fetch(`${AUTH_WORKER_URL}?email=${encodeURIComponent(email)}`);
    if (!roleRes.ok) throw new Error('role lookup failed');
    const { role, teams } = await roleRes.json();

    if (role === 'unknown' || !teams?.length) {
      window.location.href = '/admin.html';
      return false;
    }

    CALLER_ROLE  = role;
    CALLER_TEAMS = teams;
    return true;
  } catch (e) {
    console.error('[admin-photos] identity load failed', e);
    window.location.href = '/admin.html';
    return false;
  }
}

const AUTH_WORKER_URL = 'https://canonniers-auth-worker.chisholm2000.workers.dev';
```

### 4b. Hide team buttons for single-team users

Modify `initPage()`:

```js
async function initPage() {
  const ok = await loadIdentity();
  if (!ok) return;

  // Hide team buttons the caller can't use
  document.querySelectorAll('#team-seg .seg-btn').forEach(btn => {
    const team = btn.dataset.team;
    if (CALLER_ROLE !== 'admin' && !CALLER_TEAMS.includes(team)) {
      btn.style.display = 'none';
    }
  });

  // If caller has exactly one team, auto-select it
  if (CALLER_ROLE !== 'admin' && CALLER_TEAMS.length === 1) {
    selectTeam(CALLER_TEAMS[0], true);
    // Optional: hide the entire team-selection card since there's no choice
    const step1Card = document.querySelector('#team-seg').closest('.card');
    if (step1Card) step1Card.style.display = 'none';
  } else {
    // Restore last team selection (admin path)
    const savedTeam = localStorage.getItem('canonniers_photo_last_team');
    if (savedTeam && TEAM_CONFIG[savedTeam]) selectTeam(savedTeam, true);
  }

  // ... rest of existing initPage logic (date max, drag-drop)
  const maxDate = new Date();
  maxDate.setDate(maxDate.getDate() + 30);
  document.getElementById('manual-date').max = toDateStr(maxDate);

  const drop = document.getElementById('upload-drop');
  drop.addEventListener('dragover',  (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', ()  => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    if (!isUploading) addFiles(Array.from(e.dataTransfer.files));
  });
}
```

Replace the existing call site:

```js
setLang(localStorage.getItem('lang') || 'fr');
initPage();  // now async — fire and forget is fine
```

### 4c. Send Access JWT on every Worker call

The browser sends the `CF-Access-Jwt-Assertion` cookie automatically on same-origin requests. For the photo-worker subdomain (`photo-worker.chisholm2000.workers.dev`), cookies don't cross. **Two options:**

**Option A (preferred):** route photo-worker through a Pages Function path on `canonniersdequebec.ca` so cookies flow. Existing `WORKER_URL` would become `/api/photo-worker` and a Pages Function proxies to the actual worker.

**Option B (simpler, same-session only):** fetch the JWT explicitly and inject as header.

```js
async function getAccessJwt() {
  const r = await fetch('/cdn-cgi/access/get-identity', { credentials: 'include' });
  // The JWT is in the request cookie, not the response body.
  // Need to call /cdn-cgi/access/get-jwt or similar.
  // VERIFY actual endpoint name with Cloudflare docs before deploying.
}
```

**Claude Code: pick Option A.** Adding a Pages Function `/functions/api/photo-worker/[[path]].js` that proxies to the real worker keeps cookies flowing and avoids client-side JWT handling. This adds ~20 lines and removes a class of bugs.

Pages Function (rough shape):

```js
// /functions/api/photo-worker/[[path]].js
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetPath = url.pathname.replace('/api/photo-worker', '');
  const targetUrl = `https://photo-worker.chisholm2000.workers.dev${targetPath}${url.search}`;

  return fetch(targetUrl, {
    method: context.request.method,
    headers: context.request.headers,  // Access JWT flows through
    body: ['GET', 'HEAD'].includes(context.request.method) ? undefined : context.request.body,
  });
}
```

Then update `admin-photos.html`:

```js
const WORKER_URL = '/api/photo-worker';  // was: 'https://photo-worker.chisholm2000.workers.dev'
```

And update `galerie.html` the same way (public reads still work — no JWT needed for GET).

### 4d. Manage / delete view

Add a new card after the upload card:

```html
<!-- ── MANAGE EXISTING PHOTOS ── -->
<div class="card" id="manage-card" style="display:none;">
  <div class="card-title">
    <span class="fr-text">Gérer les photos existantes</span>
    <span class="en-text">Manage Existing Photos</span>
  </div>
  <div id="manage-status" class="alert" style="display:none;"></div>
  <div id="manage-list"></div>
</div>
```

Show this card after team selection. Render logic:

```js
async function loadManageList() {
  const card = document.getElementById('manage-card');
  const list = document.getElementById('manage-list');
  card.style.display = 'block';

  const teamsToLoad = CALLER_ROLE === 'admin'
    ? ['u15', 'u17d1', 'u17d2']
    : CALLER_TEAMS;

  list.innerHTML = '<div class="loading-row"><div class="spinner"></div><span>Chargement…</span></div>';

  try {
    const allPhotos = [];
    for (const team of teamsToLoad) {
      const r = await fetch(`${WORKER_URL}/api/photos?team=${team}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { photos } = await r.json();
      allPhotos.push(...(photos || []));
    }

    // Sort by event_date desc
    allPhotos.sort((a, b) => (b.event_date || '').localeCompare(a.event_date || ''));

    if (!allPhotos.length) {
      list.innerHTML = '<p style="color:var(--text-dim);">Aucune photo.</p>';
      return;
    }

    list.innerHTML = '';
    for (const p of allPhotos) {
      list.appendChild(buildManageRow(p));
    }
  } catch (e) {
    list.innerHTML = `<p style="color:#f87171;">Erreur: ${escHtml(e.message)}</p>`;
  }
}

function buildManageRow(photo) {
  const row = document.createElement('div');
  row.className = 'manage-row';
  row.dataset.id = photo.id;

  const thumbUrl = `https://imagedelivery.net/XuWXX2Hn8HGMN14wNLQAMA/${photo.cf_image_id}/thumb`;

  row.innerHTML = `
    <img class="manage-thumb" src="${thumbUrl}" alt=""
         onerror="this.style.background='#7a1f1f'; this.alt='⚠ Asset manquant';">
    <div class="manage-meta">
      <div class="manage-meta-name">${escHtml(photo.event_name_fr || '(sans nom)')}</div>
      <div class="manage-meta-date">${escHtml(photo.event_date)} · ${escHtml(photo.team_category)}</div>
      <div class="manage-meta-caption">${escHtml(photo.caption_fr || '')}</div>
    </div>
    <button class="btn-delete" data-id="${photo.id}">
      <span class="fr-text">Supprimer</span>
      <span class="en-text">Delete</span>
    </button>
  `;

  row.querySelector('.btn-delete').addEventListener('click', () => confirmDelete(photo));
  return row;
}

function confirmDelete(photo) {
  const isEn = document.body.classList.contains('lang-en');
  const msg = isEn
    ? `Delete this photo?\n\n${photo.event_name_fr}\n${photo.event_date}\n\nThis cannot be undone.`
    : `Supprimer cette photo ?\n\n${photo.event_name_fr}\n${photo.event_date}\n\nCette action est irréversible.`;

  if (!confirm(msg)) return;
  deletePhoto(photo.id);
}

async function deletePhoto(id) {
  const row = document.querySelector(`.manage-row[data-id="${id}"]`);
  if (row) row.style.opacity = '0.4';

  try {
    const r = await fetch(`${WORKER_URL}/api/photos/${id}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${PHOTO_TOKEN}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (row) row.remove();
    showToast(`<span class="fr-text">Photo supprimée</span><span class="en-text">Photo deleted</span>`);
  } catch (e) {
    if (row) row.style.opacity = '';
    alert(`Erreur: ${e.message}`);
  }
}
```

CSS for the manage rows (add to existing style block):

```css
.manage-row {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  gap: 14px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  background: rgba(255,255,255,0.02);
}
.manage-thumb {
  width: 80px; height: 80px; object-fit: cover;
  border-radius: 4px; background: rgba(106,176,212,0.05);
}
.manage-meta-name    { font-weight: 700; color: var(--white); }
.manage-meta-date    { font-size: 12px; color: var(--text-mid); margin-top: 2px; }
.manage-meta-caption { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.btn-delete {
  background: rgba(185,28,28,0.15);
  border: 1px solid rgba(185,28,28,0.4);
  color: #f87171;
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 12px; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; padding: 6px 12px;
  border-radius: 4px; cursor: pointer; transition: all 0.18s;
}
.btn-delete:hover { background: rgba(185,28,28,0.3); border-color: rgba(185,28,28,0.7); }
```

Call `loadManageList()` after `selectTeam()` succeeds (or as a separate "Manage" tab if you want a clean separation — Claude Code: surface this question to Jay if unclear).

## Verification

1. Log in as `coach17d1@canonniers.ca` (test account in Access).
   - Step 1 card hidden, team auto-locked to U17D1.
   - Manage list shows only U17D1 photos.
   - Delete button removes the row + confirms via toast.
   - Refresh page → photo is still gone. Public gallery doesn't show it either.
2. Log in as `jay@canonniers.ca`.
   - Step 1 card visible with all three buttons.
   - Manage list shows all photos across all teams.
3. Try to call DELETE for a U15 photo from a U17D1 session via DevTools console → 403.

## Rollback

`git revert` this commit. Worker DELETE endpoint stays (commit 3) but no UI exposes it. No data lost.

---

# Commit 5 — `galerie.html` defensive `onerror` + ghost row reconciler

**Goal:** belt-and-suspenders for the gallery, plus a one-shot script to clean up the existing 19 ghost rows.

## 5a. Patch `galerie.html`

Find this block (current line ~435):

```js
img.onload = () => img.classList.add('loaded');
```

Replace with:

```js
img.onload = () => img.classList.add('loaded');
img.onerror = () => {
  // CF asset missing — hide the entire tile and update group count
  const tile = img.closest('.thumb-item');
  const group = img.closest('.event-group');
  if (tile) tile.remove();
  if (group) {
    const remaining = group.querySelectorAll('.thumb-item:not(.extra-thumb), .thumb-item.extra-thumb.revealed').length;
    if (remaining === 0) {
      group.remove();
    } else {
      const countEl = group.querySelector('.event-group-count');
      if (countEl) {
        countEl.textContent = `${remaining} photo${remaining > 1 ? 's' : ''}`;
      }
    }
  }
};
```

This is a **client-side cosmetic fix only.** It hides broken tiles so visitors don't see gray placeholders. It does NOT clean up D1. The reconciler below does that.

## 5b. Reconciler script (one-time, run by Jay)

Create `scripts/reconcile-ghost-photos.js` (or wherever the project keeps ops scripts):

```js
// Run with: node scripts/reconcile-ghost-photos.js --dry-run
// Then:     node scripts/reconcile-ghost-photos.js --execute
//
// Walks every photo row in D1, HEADs the CF Images URL, and lists/deletes
// rows whose CF asset is missing.

const CF_HASH      = 'XuWXX2Hn8HGMN14wNLQAMA';
const WORKER_URL   = process.env.WORKER_URL    || 'https://canonniersdequebec.ca/api/photo-worker';
const ADMIN_TOKEN  = process.env.ADMIN_BEARER  || '';
const ADMIN_JWT    = process.env.ADMIN_JWT     || '';  // Jay's CF Access JWT, copy from browser

async function main() {
  const mode = process.argv.includes('--execute') ? 'execute' : 'dry-run';
  console.log(`Mode: ${mode}`);

  if (mode === 'execute' && (!ADMIN_TOKEN || !ADMIN_JWT)) {
    console.error('Set ADMIN_BEARER and ADMIN_JWT env vars before --execute');
    process.exit(1);
  }

  const teams = ['u15', 'u17d1', 'u17d2'];
  const ghosts = [];

  for (const team of teams) {
    const r = await fetch(`${WORKER_URL}/api/photos?team=${team}`);
    const { photos } = await r.json();
    console.log(`Team ${team}: ${photos.length} rows`);

    for (const p of photos) {
      const url = `https://imagedelivery.net/${CF_HASH}/${p.cf_image_id}/thumb`;
      const head = await fetch(url, { method: 'HEAD' });
      if (!head.ok) {
        ghosts.push(p);
        console.log(`  GHOST id=${p.id} cf_image_id=${p.cf_image_id} event=${p.event_name_fr} date=${p.event_date}`);
      }
    }
  }

  console.log(`\nFound ${ghosts.length} ghost rows.`);

  if (mode === 'dry-run') {
    console.log('Dry run complete. Re-run with --execute to delete.');
    return;
  }

  for (const p of ghosts) {
    const r = await fetch(`${WORKER_URL}/api/photos/${p.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'CF-Access-Jwt-Assertion': ADMIN_JWT,
      },
    });
    console.log(`DELETE id=${p.id}: HTTP ${r.status}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

### Verification

```bash
# Dry run first — must show the 19 ghosts from "Test pour Zoom"
node scripts/reconcile-ghost-photos.js

# Execute
node scripts/reconcile-ghost-photos.js --execute

# Confirm gallery is clean
# Visit https://canonniersdequebec.ca/galerie.html — Test pour Zoom event should be gone
# Confirm D1
wrangler d1 execute canonniers-db --remote --command="SELECT COUNT(*) FROM photos WHERE event_name_fr = 'Test pour Zoom'"
# Expected: 0
```

## Rollback

`git revert` the `galerie.html` change. Reconciler script is one-shot — already-deleted rows can't be restored without the D1 backup from pre-flight.

---

# Open questions for Claude Code

1. **Worker route for Access JWT.** Does the existing `photo-worker.chisholm2000.workers.dev` route already see `CF-Access-Jwt-Assertion`? If routed via Pages Function, yes. If hit directly, no. Confirm via a logged request before commit 2.
2. **`auth-worker` Access protection.** Is `canonniers-auth-worker.chisholm2000.workers.dev` itself behind Access? If anyone on the internet can hit it and get role data, the whole RBAC story is hollow. Verify before commit 1 ships.
3. **Manage view placement.** This directive embeds the manage view in `admin-photos.html`. Alternative: dedicated `/admin-photo-manage.html` page. Embedded is fewer files; dedicated is cleaner separation. **Default: embedded. Surface to Jay if you'd recommend otherwise.**
4. **CF Images delete token scope.** Confirm `CF_IMAGES_TOKEN` exists with `Account / Cloudflare Images / Edit` permission. If not, create it before commit 3.
5. **Existing photos and `team_category` integrity.** Any rows where `team_category` is NULL or invalid? Run `SELECT DISTINCT team_category FROM photos` in pre-flight. If there are rows that won't match `u15|u17d1|u17d2`, surface those — RBAC will lock them out of management entirely.

---

# Master rollback plan

If anything goes catastrophically wrong:

1. Restore D1 from `backups/<timestamp>-pre-photo-rbac.sql`:
   ```bash
   wrangler d1 execute canonniers-db --remote --file=backups/<timestamp>-pre-photo-rbac.sql
   ```
2. Revert each commit in reverse order (5 → 4 → 3 → 2 → 1).
3. Re-deploy Pages (auto on revert push).
4. Re-deploy auth-worker and photo-worker (manual — `wrangler deploy` in each repo).

Verify post-rollback:
- `admin.html` loads, shows tiles
- `admin-photos.html` upload still works for Jay
- `galerie.html` renders photos for all three teams
