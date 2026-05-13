# Directive #2 — Coaches Worker Endpoints (canonniers-roster-worker)

**Goal:** Add three endpoints to `canonniers-roster-worker` for reading and updating coach data from the `coaches` table seeded in directive #1.

**Risk level:** Low. Additive worker change only. Existing routes (`/api/players`, `/api/coach-photos`) untouched. No public-facing HTML changes — public site still uses hardcoded const until directive #3.

**Verification approach:** Deploy and move on. Validator + endpoint correctness will be exercised by the admin UI in directive #3. If anything is broken, the form's Save button will fail and we'll fix it in context.

**Rollback:** `wrangler rollback <previous-version-id>` or `git revert` + redeploy.

---

## Pre-flight verification

1. **Read the current `src/index.js`** of `canonniers-roster-worker` end-to-end. Confirm:
   - The PUT players handler still uses the partial-update / allow-list pattern.
   - `validatePlayer()` exists as a separate function above the request router.
   - `corsHeaders` is defined and applied to all responses.
   - `/api/coach-photos` POST handler still exists (will be reused by directive #3).
   - **Report what the bearer token is compared against** — hardcoded literal `'canonniersdequebec2026'`, or an env var like `env.ADMIN_TOKEN`. The patch below uses the hardcoded literal; if the worker uses an env var, swap it in.

2. **Confirm the D1 schema matches directive #1's seed:**
   ```powershell
   wrangler d1 execute canonniers-db --remote --command "PRAGMA table_info(coaches);"
   ```
   Expected columns: `slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg, created_at, updated_at`.

   If schema doesn't match, STOP — directive #1 didn't land cleanly and we can't build on it.

---

## Patch — add to `src/index.js`

### A. Add `safeParseJsonArray` helper

Place near the other helpers (above the request router):

```javascript
function safeParseJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
```

### B. Add `validateCoach()` near the other validators

Place above the request router, alongside `validatePlayer()`:

```javascript
// Validate a coach payload for PUT. Returns error string or null.
// Only validates fields that are present (partial-update semantics).
function validateCoach(data) {
  if (typeof data !== 'object' || data === null) return 'Invalid payload';

  if ('name' in data) {
    if (typeof data.name !== 'string' || data.name.trim().length === 0) return 'name must be non-empty string';
    if (data.name.length > 100) return 'name too long (max 100)';
  }
  if ('number' in data && data.number !== null && data.number !== '') {
    if (typeof data.number !== 'string' || !/^\d{1,3}$/.test(data.number)) return 'number must be 1-3 digit string';
  }
  if ('role_fr' in data) {
    if (typeof data.role_fr !== 'string' || data.role_fr.length > 60) return 'role_fr invalid (max 60 chars)';
  }
  if ('role_en' in data) {
    if (typeof data.role_en !== 'string' || data.role_en.length > 60) return 'role_en invalid (max 60 chars)';
  }
  if ('team' in data) {
    if (!['u15', 'u17d1', 'u17d2'].includes(data.team)) return 'team must be u15, u17d1, or u17d2';
  }
  if ('coaching_since' in data && data.coaching_since !== null && data.coaching_since !== '') {
    if (!/^(19|20)\d{2}$/.test(String(data.coaching_since))) return 'coaching_since must be a 4-digit year (1900-2099)';
  }
  if ('with_org_since' in data && data.with_org_since !== null && data.with_org_since !== '') {
    if (!/^(19|20)\d{2}$/.test(String(data.with_org_since))) return 'with_org_since must be a 4-digit year (1900-2099)';
  }
  if ('bio_fr' in data) {
    if (typeof data.bio_fr !== 'string') return 'bio_fr must be string';
    if (data.bio_fr.length > 5000) return 'bio_fr too long (max 5000 chars)';
  }
  if ('bio_en' in data) {
    if (typeof data.bio_en !== 'string') return 'bio_en must be string';
    if (data.bio_en.length > 5000) return 'bio_en too long (max 5000 chars)';
  }
  if ('playing_bg' in data) {
    if (!Array.isArray(data.playing_bg)) return 'playing_bg must be array';
    if (data.playing_bg.length > 20) return 'playing_bg too many entries (max 20)';
    for (const entry of data.playing_bg) {
      if (typeof entry !== 'object' || entry === null) return 'playing_bg entries must be objects';
      const allowedKeys = ['level_fr', 'level_en', 'where', 'years'];
      for (const k of Object.keys(entry)) {
        if (!allowedKeys.includes(k)) return `playing_bg entry has unknown key: ${k}`;
      }
      for (const k of allowedKeys) {
        if (k in entry && entry[k] !== null) {
          if (typeof entry[k] !== 'string') return `playing_bg.${k} must be string`;
          if (entry[k].length > 100) return `playing_bg.${k} too long (max 100 chars)`;
        }
      }
    }
  }

  return null;
}
```

### C. Add three new routes to the request router

Insert alongside existing `/api/coach-photos` and `/api/players` routes:

```javascript
// ── GET /api/coaches — list all coaches (public read, no auth)
if (path === '/api/coaches' && request.method === 'GET') {
  const result = await env.DB.prepare(
    'SELECT slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg FROM coaches ORDER BY team, name'
  ).all();
  const coaches = (result.results || []).map(c => ({
    ...c,
    playing_bg: safeParseJsonArray(c.playing_bg),
  }));
  return new Response(JSON.stringify(coaches), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ── GET /api/coaches/:slug — single coach (public read, no auth)
if (path.startsWith('/api/coaches/') && request.method === 'GET') {
  const slug = decodeURIComponent(path.split('/').pop() || '');
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return new Response(JSON.stringify({ error: 'Invalid slug' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  const row = await env.DB.prepare(
    'SELECT slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg FROM coaches WHERE slug = ?'
  ).bind(slug).first();
  if (!row) {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
  row.playing_bg = safeParseJsonArray(row.playing_bg);
  return new Response(JSON.stringify(row), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}

// ── PUT /api/coaches/:slug — partial update (auth required)
if (path.startsWith('/api/coaches/') && request.method === 'PUT') {
  // Match the bearer pattern used elsewhere in this worker.
  // If the worker uses env.ADMIN_TOKEN instead of a literal, swap accordingly.
  const authHeader = request.headers.get('Authorization') || '';
  const expected = `Bearer canonniersdequebec2026`;
  if (authHeader !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const slug = decodeURIComponent(path.split('/').pop() || '');
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return new Response(JSON.stringify({ error: 'Invalid slug' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const existing = await env.DB.prepare('SELECT slug FROM coaches WHERE slug = ?').bind(slug).first();
  if (!existing) {
    return new Response(JSON.stringify({ error: 'Coach not found' }), {
      status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  let data;
  try { data = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  }); }

  const err = validateCoach(data);
  if (err) return new Response(JSON.stringify({ error: err }), {
    status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });

  // Partial update — same pattern as players PUT.
  // Empty string -> NULL for nullable columns; missing key -> column untouched.
  // bio_fr/bio_en have NOT NULL DEFAULT '' — empty string stays as ''.
  const allowed = ['name', 'number', 'role_fr', 'role_en', 'team',
                   'coaching_since', 'with_org_since', 'bio_fr', 'bio_en', 'playing_bg'];
  const nullable = new Set(['number', 'coaching_since', 'with_org_since']);

  const setClauses = [];
  const values = [];

  for (const field of allowed) {
    if (!(field in data)) continue;
    let v = data[field];
    if (field === 'playing_bg') {
      v = JSON.stringify(v); // already validated as array
    } else if (typeof v === 'string') {
      v = v.trim();
      if (v === '' && nullable.has(field)) v = null;
    }
    setClauses.push(`${field} = ?`);
    values.push(v);
  }

  if (setClauses.length === 0) {
    return new Response(JSON.stringify({ error: 'No updatable fields provided' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  setClauses.push(`updated_at = datetime('now')`);
  values.push(slug);

  await env.DB.prepare(
    `UPDATE coaches SET ${setClauses.join(', ')} WHERE slug = ?`
  ).bind(...values).run();

  const updated = await env.DB.prepare(
    'SELECT slug, name, number, role_fr, role_en, team, coaching_since, with_org_since, bio_fr, bio_en, playing_bg, updated_at FROM coaches WHERE slug = ?'
  ).bind(slug).first();
  updated.playing_bg = safeParseJsonArray(updated.playing_bg);

  return new Response(JSON.stringify(updated), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
```

---

## Deploy

```powershell
wrangler deploy
```

Note the version ID from output for rollback reference.

---

## Post-deploy verification

**None.** Endpoints will be exercised by the admin form in directive #3. If the form fails to save, debug in context with the actual error message in hand.

The only sanity check worth doing is opening the GET URL in a browser to confirm the route exists at all:

```
https://canonniers-roster-worker.chisholm2000.workers.dev/api/coaches
```

Expect: a JSON array of 12 coaches. If that returns 404 or HTML, the deploy didn't land — investigate before proceeding to #3.

---

## Commit

```powershell
git add src/index.js
git commit -m "coaches worker: GET list, GET single, PUT partial (directive #2)

- /api/coaches GET: public list, playing_bg parsed as array
- /api/coaches/:slug GET: public single read, 404 on missing
- /api/coaches/:slug PUT: bearer-auth partial update with validation
- validateCoach() enforces length caps, year regex, team enum, playing_bg shape
- Reuses corsHeaders + bearer pattern from players routes
- Public site still on hardcoded const — refactor lands in directive #3"
git push
```

---

## Open questions for Claude Code

1. What is the bearer token compared against — hardcoded literal or env var? Mirror that pattern in the new PUT handler.
2. Does the worker style use a single big `if/else if` router or split handlers? Match existing style.
3. Does the browser sanity check (GET `/api/coaches`) return 12 coaches? If not, the deploy didn't land — stop and report.

---

## How to break this (Attack Vectors)

- **Slug injection** — mitigated by regex + parameterized D1 queries.
- **Oversized payload** — mitigated by per-field length caps.
- **XSS via bio field** — server stores raw text. Directive #3's public render must use `textContent` / escape — flagged again in #3.
- **Bearer in client JS** — known debt, deferred until CF Access JWT migration.
- **No rate limiting** — accepted risk for now.

---

## Rollback

```powershell
wrangler deployments list
wrangler rollback <previous-version-id>
git revert <commit-sha>
```

---

**Stop after this directive. Do NOT proceed to #3 until Jay confirms deploy succeeded and the `/api/coaches` URL returns 12 coaches in a browser.**
