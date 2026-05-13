# Directive: Private Photo Library + Lazy Classification

**Author:** Jay + Claude (planning session 2026-05-12)
**Target executor:** Claude Code (local repo, push to `main`)
**Repo:** `Zeddidiah2000/canonniers-website`
**Estimated total work:** ~7 hours across 5 commits

---

## ADR-001: Architecture Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Storage:** Private R2 bucket `player-photos-library`, no public domain binding. Worker-proxied reads with CF Access JWT verification. | Photos are media-day portraits of minors. URL obscurity (random UUIDs in public bucket) does not survive accidental URL forwarding or coach turnover. Revocable access via JWT is the only real control. |
| 2 | **Deletion scope:** Admin-only, hard delete. Coaches cannot delete or hide library photos under any role. | One-time bulk upload, low edit churn, no need for coach self-service cleanup. Admin handles dud removal. |
| 3 | **Cutout pipeline:** None. Library photos are studio-shot, production-ready. Assignment to player = direct R2 key copy to `players.photo_url`. No `remove.bg` calls in library flow. Existing `admin-social.html` `/removebg` flow untouched. | Photos already shot on near-white seamless backdrop. Background removal adds cost ($0.20/credit) and processing time for zero visual gain. |
| 4 | **Push-to-gallery:** Copy operation. Library row keeps master R2 key. Gallery gets its own R2 key under existing `player-photos` bucket (or wherever `/api/photos` writes today — verify in pre-flight). | Library = master. Public surfaces = derivatives. Deleting from gallery must not affect library. |
| 5 | **Watermark policy:** Single version per photo, watermark preserved. Used everywhere (browse, assign, gallery). | Not a pro site. Photographer credit acceptable. No clean-version pipeline needed. |
| 6 | **Classification:** Lazy. `photo_library.team` is nullable. Populated when coach assigns photo to player. Multi-team via JSON column `linked_teams` (E1c). | Avoids 306-photo manual sort. Metadata accretes as coaches do work they were already doing. |
| 7 | **Mark-without-assign:** Not supported in v1 (E3a). Only path to stamp `linked_teams` is via player assignment. | Keeps model simple. Additive feature later if needed. |
| 8 | **Picker scope in roster editor:** Modal shows `linked_teams CONTAINS player's team` UNION `linked_teams IS NULL` (E4a). | Coach sees their team's photos + the unsorted pool. Other teams' classified photos hidden. |
| 9 | **Auth pattern:** New `canonniers-library-worker` mirrors `canonniers-cards-worker` — CF Access JWT verification + service binding (not fetch) to `canonniers-auth-worker`. | Reference impl is `admin-photos.html` / `canonniers-cards-worker`. Roster worker bearer-token migration is separate work; do not block on it. |
| 10 | **Thumbnails:** Pre-generated on upload. Stored alongside originals (`library/{uuid}.jpg` + `library/{uuid}_thumb.jpg`). ~800px longest edge, 75% JPEG quality. | 306 × 3MB originals = 900MB per page load if browsing grid pulls full-res. Pre-gen on upload, served by Worker proxy with `Cache-Control: private, max-age=300`. |

### Attack vectors considered

- **Forwarded URL leak:** Mitigated by Option B (Worker proxy validates JWT every request; no R2 public URL exists).
- **Coach turnover:** Removed email = removed from `canonniers-auth-worker` allowlist = instant access revocation across all 306 photos.
- **Parent removal request:** `DELETE FROM photo_library WHERE id = X` + Worker `DELETE` R2 object. No public URLs to chase down.
- **XSS via filename or caption:** All free-text fields sanitized server-side (allow `[A-Za-z0-9._\- ]`, max 200 chars). HTML-escaped on render.
- **Upload abuse:** Per-caller rate limit (50 files/hour). MIME sniff on actual bytes, not header. Reject non-JPEG/PNG/WebP. Max 15MB per file, 200MB per batch.
- **Cross-team data leak via API:** Server enforces `CALLER_TEAMS` filter on every list/get endpoint. Client-side filter is UX only.
- **R2 key enumeration:** Keys are UUIDv4. Even if private bucket bound publicly later by mistake, keys are unguessable.

### What this directive does NOT cover

- Migration of `canonniers-roster-worker` to CF Access JWT (separate item on the security backlog).
- Photographer's clean-version delivery (not happening — watermark stays).
- Library photo cropping / rotation tools (out of scope; if photographer delivered wrong orientation, admin re-uploads).
- Manager / treasurer role scopes (out of scope per existing roadmap).
- Public gallery UI changes (push-to-gallery uses existing `/api/photos` flow).

---

## Pre-flight verification (run before commit 1)

```bash
# 1. Confirm we're on a clean main with no in-flight work
cd ~/Code/canonniers-website
git status                                    # must be clean
git pull origin main
git log --oneline -5                          # confirm latest known commit

# 2. Confirm canonniers-library-worker does not already exist
wrangler whoami
# Check Cloudflare dashboard or:
curl -s -o /dev/null -w "%{http_code}\n" https://canonniers-library-worker.chisholm2000.workers.dev
# Expect: 404 or no DNS resolution. If 200 or 401, STOP — name collision.

# 3. Confirm new R2 bucket name is free
wrangler r2 bucket list | grep player-photos-library
# Expect: no output

# 4. D1 backup BEFORE schema migration
mkdir -p ../canonniers-backups
wrangler d1 export canonniers-db --remote --output ../canonniers-backups/canonniers-db-$(date +%Y%m%d-%H%M%S)-pre-library.sql
ls -lh ../canonniers-backups/ | tail -1       # confirm file > 0 bytes

# 5. Fetch current source-of-truth files from GitHub (do NOT trust local /mnt/project)
for f in admin.html admin-roster.html admin-photos.html schema.sql wrangler.toml; do
  curl -s -o "/tmp/gh-${f}" "https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/${f}"
  echo "${f}: $(wc -l < /tmp/gh-${f}) lines"
done

# 6. Confirm canonniers-auth-worker is responding and contains expected emails
curl -s "https://canonniers-auth-worker.chisholm2000.workers.dev?email=jay@canonniers.ca" | jq .
# Expect: { "role": "admin", "teams": ["u15","u17d1","u17d2"] }

# 7. Confirm CF Access app "AuthCanonniers" still scoped to canonniersdequebec.ca/admin*
# Check via dashboard or:
wrangler access list 2>/dev/null || echo "manual check required"

# 8. Inspect actual schema of the public gallery `photos` table.
# The library worker's push-to-gallery endpoint INSERTs into this table.
# Column names in the directive may not match production — adapt if needed.
wrangler d1 execute canonniers-db --remote --command="PRAGMA table_info(photos);"
# Compare output to the INSERT in commit 2's push-to-gallery handler.
# If column names differ (e.g. event_name vs event_name_fr, etc.), adjust the
# INSERT statement in workers/library/src/index.js BEFORE deploying commit 2.

# 9. Capture format of existing players.photo_url values.
# The library worker's assign-player endpoint must write URLs in the same format.
wrangler d1 execute canonniers-db --remote --command="SELECT id, name, photo_url FROM players WHERE photo_url IS NOT NULL LIMIT 3;"
# Note whether URLs are:
#   - Relative: /players/12.jpg
#   - Absolute: https://canonniers-roster-worker.chisholm2000.workers.dev/players/12.jpg
# Adjust publicUrl construction in workers/library/src/index.js to match.
```

**STOP conditions:**
- Pre-flight step 2 finds existing worker → halt, escalate to Jay
- Pre-flight step 4 produces 0-byte backup → halt, do not proceed with schema changes
- Pre-flight step 6 returns non-200 or unexpected payload → halt; auth chain broken

---

## Commit sequence

Each commit is independently testable. Push after each. Verify before proceeding to next.

---

### Commit 1: Infrastructure — R2 bucket + D1 migration v6

**Files changed:**
- `update_schema_v6_library.sql` (new)
- `wrangler.toml` (no change — new worker has its own wrangler.toml in `workers/library/`)

**Actions:**

```bash
# 1a. Create private R2 bucket (NO public domain binding)
wrangler r2 bucket create player-photos-library
# Verify it has NO public access:
wrangler r2 bucket info player-photos-library
# If "Public access" shows anything other than disabled, immediately:
#   wrangler r2 bucket dev-url disable player-photos-library
```

**`update_schema_v6_library.sql`:**

```sql
-- Schema v6: Photo library with lazy classification
-- Rollback: DROP TABLE photo_library;

CREATE TABLE IF NOT EXISTS photo_library (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  r2_key          TEXT    NOT NULL UNIQUE,
  thumb_r2_key    TEXT    NOT NULL,
  filename        TEXT    NOT NULL,
  size_bytes      INTEGER NOT NULL,
  width           INTEGER,
  height          INTEGER,
  mime_type       TEXT    NOT NULL,

  uploaded_by     TEXT    NOT NULL,                          -- email from JWT
  uploaded_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Lazy classification (E1c: multi-team)
  linked_teams    TEXT,                                       -- JSON array, e.g. '["u17d1"]' or '["u15","u17d1"]'
  linked_player_ids TEXT,                                     -- JSON array of player ids ever assigned
  first_linked_at TEXT,
  last_linked_at  TEXT,

  -- Gallery push tracking
  pushed_to_gallery_at TEXT,
  pushed_to_gallery_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_lib_uploaded_at ON photo_library(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_lib_filename    ON photo_library(filename);
CREATE INDEX IF NOT EXISTS idx_lib_linked_teams ON photo_library(linked_teams);
```

**Apply:**

```bash
wrangler d1 execute canonniers-db --remote --file=update_schema_v6_library.sql

# Verify
wrangler d1 execute canonniers-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' AND name='photo_library';"
wrangler d1 execute canonniers-db --remote --command="PRAGMA table_info(photo_library);"
```

**Verify:**
- Table exists, 14 columns, 3 indexes
- R2 bucket exists, public access disabled, no custom domain bound

**Commit message:**
```
feat(library): add photo_library table + private R2 bucket

- New D1 table photo_library (schema v6)
- Lazy classification via linked_teams JSON column (E1c)
- Private R2 bucket player-photos-library, no public access
- See DIRECTIVE-photo-library.md ADR-001

Rollback: DROP TABLE photo_library; wrangler r2 bucket delete player-photos-library
```

**Rollback:**
```bash
wrangler d1 execute canonniers-db --remote --command="DROP TABLE photo_library;"
wrangler r2 bucket delete player-photos-library
```

---

### Commit 2: `canonniers-library-worker`

**New files:**
- `workers/library/wrangler.toml`
- `workers/library/src/index.js`
- `workers/library/package.json`

**`workers/library/wrangler.toml`:**

```toml
name = "canonniers-library-worker"
main = "src/index.js"
compatibility_date = "2026-05-12"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "canonniers-db"
database_id = "f416f91e-a004-4bdb-a6bf-d4ba3264e61d"

[[r2_buckets]]
binding = "LIBRARY"
bucket_name = "player-photos-library"

[[r2_buckets]]
binding = "GALLERY"
bucket_name = "player-photos"          # for push-to-gallery copy operations

[[services]]
binding = "AUTH_WORKER"
service = "canonniers-auth-worker"

# Secrets set via: wrangler secret put CF_ACCESS_AUD / CF_ACCESS_TEAM_DOMAIN
# CF_ACCESS_AUD: pasted from CF Zero Trust → Access → Applications → AuthCanonniers
# CF_ACCESS_TEAM_DOMAIN: quebecsports.cloudflareaccess.com
```

**`workers/library/src/index.js`** — full implementation:

```javascript
// canonniers-library-worker
// CF Access JWT-verified photo library API.
// Mirrors auth pattern from canonniers-cards-worker.

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_BATCH_FILES = 50;
const ALLOWED_TEAMS = new Set(['u15', 'u17d1', 'u17d2']);

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || 'https://canonniersdequebec.ca',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cf-Access-Jwt-Assertion',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function verifyAccessJwt(request, env) {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  const certsUrl = `https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const resp = await fetch(certsUrl);
  if (!resp.ok) return null;
  const { keys } = await resp.json();
  const [headerB64, payloadB64, sigB64] = token.split('.');
  const header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')));
  const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.aud !== env.CF_ACCESS_AUD && !payload.aud?.includes?.(env.CF_ACCESS_AUD)) return null;
  if (payload.exp * 1000 < Date.now()) return null;
  const key = keys.find(k => k.kid === header.kid);
  if (!key) return null;
  const cryptoKey = await crypto.subtle.importKey(
    'jwk', key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const sig = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, data);
  if (!ok) return null;
  return payload;
}

async function getCallerIdentity(request, env) {
  const jwt = await verifyAccessJwt(request, env);
  if (!jwt) return null;
  const email = jwt.email || jwt.identity_nonce;
  if (!email) return null;
  // Service binding — NOT fetch
  const resp = await env.AUTH_WORKER.fetch(`https://auth/?email=${encodeURIComponent(email)}`);
  if (!resp.ok) return null;
  const identity = await resp.json();
  if (!identity.role) return null;
  return { email, role: identity.role, teams: identity.teams || [] };
}

function sanitizeText(s, maxLen = 200) {
  if (!s) return null;
  // O3: Allow Latin-1 supplement for French accented characters (é, è, à, ç, ...)
  const cleaned = String(s).replace(/[^A-Za-z\u00C0-\u00FF0-9._\- ]/g, '').slice(0, maxLen).trim();
  return cleaned || null;
}

function uuid() {
  return crypto.randomUUID();
}

async function sniffMime(bytes) {
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
  // WebP: RIFF....WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

function pickerFilter(callerTeams, role) {
  // E4a: linked_teams JSON contains caller team OR linked_teams IS NULL
  // SQLite has no JSON_CONTAINS; we LIKE against the JSON string.
  if (role === 'admin') return { sql: '1=1', params: [] };
  const teamConditions = callerTeams.map(() => `linked_teams LIKE ?`).join(' OR ');
  const params = callerTeams.map(t => `%"${t}"%`);
  return {
    sql: `(linked_teams IS NULL OR ${teamConditions})`,
    params,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const caller = await getCallerIdentity(request, env);
    if (!caller) return json({ error: 'Unauthorized' }, 401, origin);

    try {
      // ── GET /api/library ────────────────────────────────────────
      if (url.pathname === '/api/library' && request.method === 'GET') {
        const filter = url.searchParams.get('filter') || 'all';
        // filter values: 'all', 'unsorted', 'u15', 'u17d1', 'u17d2'
        let where = '1=1';
        const params = [];

        if (filter === 'unsorted') {
          where = 'linked_teams IS NULL';
        } else if (ALLOWED_TEAMS.has(filter)) {
          if (caller.role !== 'admin' && !caller.teams.includes(filter)) {
            return json({ error: 'Forbidden' }, 403, origin);
          }
          where = 'linked_teams LIKE ?';
          params.push(`%"${filter}"%`);
        } else if (filter === 'all') {
          // Coaches: their teams + unsorted. Admin: everything.
          if (caller.role !== 'admin') {
            const pf = pickerFilter(caller.teams, caller.role);
            where = pf.sql;
            params.push(...pf.params);
          }
        }

        const rows = await env.DB.prepare(
          `SELECT id, r2_key, thumb_r2_key, filename, size_bytes, width, height, mime_type,
                  uploaded_by, uploaded_at, linked_teams, linked_player_ids,
                  first_linked_at, last_linked_at, pushed_to_gallery_at
           FROM photo_library
           WHERE ${where}
           ORDER BY filename ASC`
        ).bind(...params).all();

        return json({ photos: rows.results || [] }, 200, origin);
      }

      // ── GET /api/library/file/:id ───────────────────────────────
      // Serves the original. Use ?thumb=1 for thumbnail.
      if (url.pathname.startsWith('/api/library/file/') && request.method === 'GET') {
        const id = parseInt(url.pathname.split('/').pop(), 10);
        if (!id) return json({ error: 'Invalid id' }, 400, origin);

        const row = await env.DB.prepare(
          `SELECT r2_key, thumb_r2_key, mime_type, linked_teams FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404, origin);

        // Server-side scope check
        if (caller.role !== 'admin' && row.linked_teams) {
          const linkedTeams = JSON.parse(row.linked_teams);
          const overlap = linkedTeams.some(t => caller.teams.includes(t));
          if (!overlap) return json({ error: 'Forbidden' }, 403, origin);
        }
        // Unsorted photos (linked_teams IS NULL): visible to all authenticated callers

        const key = url.searchParams.get('thumb') === '1' ? row.thumb_r2_key : row.r2_key;
        const obj = await env.LIBRARY.get(key);
        if (!obj) return json({ error: 'R2 object missing' }, 404, origin);

        return new Response(obj.body, {
          headers: {
            'Content-Type': row.mime_type,
            'Cache-Control': 'private, max-age=300',
            'ETag': obj.httpEtag,
            ...corsHeaders(origin),
          },
        });
      }

      // ── POST /api/library/upload ────────────────────────────────
      if (url.pathname === '/api/library/upload' && request.method === 'POST') {
        const form = await request.formData();
        const files = form.getAll('files');
        if (files.length === 0) return json({ error: 'No files' }, 400, origin);
        if (files.length > MAX_BATCH_FILES) {
          return json({ error: `Batch limit ${MAX_BATCH_FILES}` }, 400, origin);
        }

        const results = [];
        for (const file of files) {
          if (!(file instanceof File)) {
            results.push({ ok: false, error: 'Not a file' });
            continue;
          }
          if (file.size > MAX_FILE_BYTES) {
            results.push({ ok: false, filename: file.name, error: 'Too large' });
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const sniffed = await sniffMime(bytes);
          if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
            results.push({ ok: false, filename: file.name, error: 'Invalid MIME' });
            continue;
          }

          // NOTE: Thumbnail generation in Workers is non-trivial without external
          // service (Cloudflare Images is paid). For v1 we accept the client-side
          // thumbnail bytes alongside originals — see admin-photo-library.html upload code.
          const thumbBlob = form.get(`thumb_${file.name}`);
          if (!thumbBlob || !(thumbBlob instanceof File)) {
            results.push({ ok: false, filename: file.name, error: 'Missing thumbnail' });
            continue;
          }
          const thumbBytes = new Uint8Array(await thumbBlob.arrayBuffer());

          const id = uuid();
          const ext = sniffed === 'image/jpeg' ? 'jpg' : sniffed === 'image/png' ? 'png' : 'webp';
          const r2Key = `library/${id}.${ext}`;
          const thumbR2Key = `library/${id}_thumb.jpg`;

          await env.LIBRARY.put(r2Key, bytes, { httpMetadata: { contentType: sniffed } });
          await env.LIBRARY.put(thumbR2Key, thumbBytes, { httpMetadata: { contentType: 'image/jpeg' } });

          const cleanFilename = sanitizeText(file.name, 200);
          const insert = await env.DB.prepare(
            `INSERT INTO photo_library (r2_key, thumb_r2_key, filename, size_bytes, mime_type, uploaded_by)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(r2Key, thumbR2Key, cleanFilename, file.size, sniffed, caller.email).run();

          results.push({ ok: true, id: insert.meta.last_row_id, filename: cleanFilename });
        }
        return json({ results }, 200, origin);
      }

      // ── POST /api/library/:id/assign-player ─────────────────────
      if (url.pathname.match(/^\/api\/library\/\d+\/assign-player$/) && request.method === 'POST') {
        const id = parseInt(url.pathname.split('/')[3], 10);
        const body = await request.json();
        const playerId = parseInt(body.player_id, 10);
        if (!playerId) return json({ error: 'player_id required' }, 400, origin);

        const player = await env.DB.prepare(
          `SELECT id, team_category FROM players WHERE id = ?`
        ).bind(playerId).first();
        if (!player) return json({ error: 'Player not found' }, 404, origin);

        if (caller.role !== 'admin' && !caller.teams.includes(player.team_category)) {
          return json({ error: 'Forbidden: not your team' }, 403, origin);
        }

        const photo = await env.DB.prepare(
          `SELECT id, r2_key, mime_type, linked_teams, linked_player_ids FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!photo) return json({ error: 'Photo not found' }, 404, origin);

        // O1b: Copy bytes from private library bucket to public bucket.
        // Stable key per player — overwrite on reassignment.
        const srcObj = await env.LIBRARY.get(photo.r2_key);
        if (!srcObj) return json({ error: 'Library R2 object missing' }, 500, origin);

        const ext = photo.mime_type === 'image/png' ? 'png'
                  : photo.mime_type === 'image/webp' ? 'webp' : 'jpg';
        const publicKey = `players/${playerId}.${ext}`;
        await env.GALLERY.put(publicKey, srcObj.body, {
          httpMetadata: { contentType: photo.mime_type },
        });

        // Public URL — same pattern as today's /api/upload returns.
        // Verify the actual format during pre-flight by inspecting one existing
        // players.photo_url value. Expected: /players/{id}.jpg served by roster worker
        // OR https://canonniers-roster-worker.../players/{id}.jpg.
        const publicUrl = `/${publicKey}`;

        // E1c: multi-team. Append player's team if not already present.
        const teams = photo.linked_teams ? JSON.parse(photo.linked_teams) : [];
        if (!teams.includes(player.team_category)) teams.push(player.team_category);
        const playerIds = photo.linked_player_ids ? JSON.parse(photo.linked_player_ids) : [];
        if (!playerIds.includes(playerId)) playerIds.push(playerId);

        const now = new Date().toISOString();

        await env.DB.batch([
          env.DB.prepare(
            `UPDATE photo_library
             SET linked_teams = ?, linked_player_ids = ?,
                 first_linked_at = COALESCE(first_linked_at, ?), last_linked_at = ?
             WHERE id = ?`
          ).bind(JSON.stringify(teams), JSON.stringify(playerIds), now, now, photo.id),
          env.DB.prepare(
            `UPDATE players SET photo_url = ? WHERE id = ?`
          ).bind(publicUrl, playerId),
        ]);

        return json({ ok: true, photo_url: publicUrl }, 200, origin);
      }

      // ── POST /api/library/:id/push-to-gallery ───────────────────
      if (url.pathname.match(/^\/api\/library\/\d+\/push-to-gallery$/) && request.method === 'POST') {
        const id = parseInt(url.pathname.split('/')[3], 10);
        const body = await request.json();
        const team = body.team;
        const eventDate = body.event_date;
        const eventName = sanitizeText(body.event_name_fr, 100);

        if (!ALLOWED_TEAMS.has(team)) return json({ error: 'Invalid team' }, 400, origin);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return json({ error: 'Invalid date' }, 400, origin);
        if (!eventName) return json({ error: 'Event name required' }, 400, origin);
        if (caller.role !== 'admin' && !caller.teams.includes(team)) {
          return json({ error: 'Forbidden' }, 403, origin);
        }

        const photo = await env.DB.prepare(
          `SELECT r2_key, thumb_r2_key, mime_type FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!photo) return json({ error: 'Not found' }, 404, origin);

        // Copy bytes from LIBRARY bucket to GALLERY bucket
        const srcObj = await env.LIBRARY.get(photo.r2_key);
        if (!srcObj) return json({ error: 'R2 source missing' }, 404, origin);

        const galleryKey = `gallery/${team}/${eventDate}/${uuid()}.jpg`;
        await env.GALLERY.put(galleryKey, srcObj.body, {
          httpMetadata: { contentType: photo.mime_type },
        });

        // Insert into existing gallery `photos` table.
        // NOTE: Verify the schema/table name during pre-flight (commit 2 review).
        // If schema differs, adjust this insert.
        await env.DB.prepare(
          `INSERT INTO photos (team, r2_key, event_date, event_name_fr, uploaded_by, uploaded_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
        ).bind(team, galleryKey, eventDate, eventName, caller.email).run();

        await env.DB.prepare(
          `UPDATE photo_library SET pushed_to_gallery_at = CURRENT_TIMESTAMP, pushed_to_gallery_by = ?
           WHERE id = ?`
        ).bind(caller.email, id).run();

        return json({ ok: true }, 200, origin);
      }

      // ── DELETE /api/library/:id ─────────────────────────────────
      if (url.pathname.match(/^\/api\/library\/\d+$/) && request.method === 'DELETE') {
        if (caller.role !== 'admin') return json({ error: 'Admin only' }, 403, origin);

        const id = parseInt(url.pathname.split('/').pop(), 10);
        const row = await env.DB.prepare(
          `SELECT r2_key, thumb_r2_key FROM photo_library WHERE id = ?`
        ).bind(id).first();
        if (!row) return json({ error: 'Not found' }, 404, origin);

        await env.LIBRARY.delete(row.r2_key);
        await env.LIBRARY.delete(row.thumb_r2_key);
        await env.DB.prepare(`DELETE FROM photo_library WHERE id = ?`).bind(id).run();

        return json({ ok: true }, 200, origin);
      }

      return json({ error: 'Not found' }, 404, origin);

    } catch (e) {
      console.error('[library-worker]', e);
      return json({ error: e.message }, 500, origin);
    }
  },
};
```

**Deploy:**

```bash
cd workers/library
npm init -y
npm install -D wrangler
wrangler secret put CF_ACCESS_AUD          # paste from CF Zero Trust dashboard
wrangler secret put CF_ACCESS_TEAM_DOMAIN  # quebecsports.cloudflareaccess.com
wrangler deploy
```

**Add CF Access route:** In Cloudflare Zero Trust → Access → Applications → AuthCanonniers → Application domains, add:
- `canonniers-library-worker.chisholm2000.workers.dev`

This puts the worker behind the same Access app as admin pages.

**Verify:**

```bash
# Unauthenticated — expect 401 or CF Access login redirect
curl -i https://canonniers-library-worker.chisholm2000.workers.dev/api/library

# From browser logged in as jay@canonniers.ca:
# Open https://canonniers-library-worker.chisholm2000.workers.dev/api/library
# Expect: { "photos": [] }
```

**Commit message:**
```
feat(library): canonniers-library-worker + CF Access integration

- Service binding to canonniers-auth-worker (not fetch)
- JWT verification via CF Access certs
- Endpoints: list, file proxy, upload, assign-player, push-to-gallery, delete
- Server-side enforcement of CALLER_TEAMS on every endpoint
- See DIRECTIVE-photo-library.md commit 2
```

**Rollback:**
```bash
cd workers/library && wrangler delete --name canonniers-library-worker
# Remove route from CF Access AuthCanonniers app
```

---

### Commit 2.5: Bulk bootstrap — upload 306 media-day photos via CLI

**Purpose:** One-time import of Jay's 306 media-day photos into the library before the admin UI exists. Bypasses the web upload flow entirely. Photos arrive unsorted (`linked_teams IS NULL`) so coaches can classify them via the picker once commits 3–4 land.

**Prerequisites Jay must do BEFORE running this commit:**

1. Create a new folder at the repo root: `bootstrap/media-day-2026/`
2. Drop all 306 photos into that folder (any subfolder structure is fine — script will scan recursively)
3. **Verify the photos are NOT committed to git** — add to `.gitignore`:

```
# Bootstrap dumps (large binary, never commit)
/bootstrap/media-day-2026/
/bootstrap/*/
!/bootstrap/*.js
!/bootstrap/*.md
```

4. Commit the `.gitignore` change separately first.

**New files:**
- `bootstrap/upload-library-photos.js` (Node.js script)
- `bootstrap/README.md` (Jay-facing instructions)

**`bootstrap/upload-library-photos.js`:**

```javascript
#!/usr/bin/env node
/**
 * Bulk-uploads photos from a local folder to canonniers-library-worker.
 * Generates thumbnails locally using `sharp` (must be installed).
 *
 * Usage:
 *   node bootstrap/upload-library-photos.js ./bootstrap/media-day-2026/
 *
 * Auth: This script uses a ONE-TIME admin bypass token, not CF Access.
 * It must be enabled via wrangler secret BOOTSTRAP_TOKEN, then deleted
 * after the bulk upload completes.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const WORKER_URL = 'https://canonniers-library-worker.chisholm2000.workers.dev';
const BOOTSTRAP_TOKEN = process.env.BOOTSTRAP_TOKEN;
if (!BOOTSTRAP_TOKEN) {
  console.error('FATAL: BOOTSTRAP_TOKEN env var not set');
  process.exit(1);
}

const sourceDir = process.argv[2];
if (!sourceDir) {
  console.error('Usage: node upload-library-photos.js <folder-path>');
  process.exit(1);
}

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function findPhotos(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      out.push(...findPhotos(p));
    } else if (ALLOWED_EXT.has(path.extname(name).toLowerCase())) {
      out.push(p);
    }
  }
  return out;
}

async function uploadOne(filepath, index, total) {
  const filename = path.basename(filepath);
  const buf = fs.readFileSync(filepath);

  // Generate 800px thumbnail
  const thumbBuf = await sharp(buf)
    .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 75 })
    .toBuffer();

  const fd = new FormData();
  fd.append('files', new Blob([buf]), filename);
  fd.append(`thumb_${filename}`, new Blob([thumbBuf]), `${filename}.thumb.jpg`);

  const r = await fetch(`${WORKER_URL}/api/library/upload`, {
    method: 'POST',
    headers: { 'X-Bootstrap-Token': BOOTSTRAP_TOKEN },
    body: fd,
  });
  if (!r.ok) {
    const err = await r.text();
    console.error(`[${index}/${total}] ${filename} FAILED: ${r.status} ${err}`);
    return false;
  }
  const data = await r.json();
  const ok = data.results?.[0]?.ok;
  console.log(`[${index}/${total}] ${filename} ${ok ? '✓' : '✗ ' + (data.results?.[0]?.error || 'unknown')}`);
  return ok;
}

(async () => {
  const photos = findPhotos(sourceDir);
  console.log(`Found ${photos.length} photos in ${sourceDir}`);
  if (photos.length === 0) process.exit(0);

  // Concurrency limit: 4 parallel uploads
  let okCount = 0, failCount = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < photos.length; i += CONCURRENCY) {
    const batch = photos.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((p, j) => uploadOne(p, i + j + 1, photos.length))
    );
    okCount += results.filter(Boolean).length;
    failCount += results.filter(r => !r).length;
  }
  console.log(`\nDone. ${okCount} uploaded, ${failCount} failed.`);
  process.exit(failCount > 0 ? 1 : 0);
})();
```

**Worker change required to support bootstrap token:**

Add to `workers/library/src/index.js` at the top of the `fetch` handler, before `getCallerIdentity`:

```javascript
// Bootstrap one-time bypass — for CLI bulk upload only.
// REMOVE THIS BLOCK after bootstrap completes by deleting BOOTSTRAP_TOKEN secret.
const bootstrapToken = request.headers.get('X-Bootstrap-Token');
if (bootstrapToken && env.BOOTSTRAP_TOKEN && bootstrapToken === env.BOOTSTRAP_TOKEN) {
  // Synthetic admin caller
  const caller = { email: 'bootstrap@canonniers.ca', role: 'admin', teams: ['u15','u17d1','u17d2'] };
  // Only allow /api/library/upload via bootstrap — block other endpoints
  if (url.pathname !== '/api/library/upload' || request.method !== 'POST') {
    return json({ error: 'Bootstrap token only valid for upload' }, 403, origin);
  }
  // Skip CF Access JWT verification, jump straight to upload handler
  // ... (existing upload handler code runs with this caller object)
}
```

The cleanest implementation is to refactor the upload handler into a function `handleUpload(request, env, caller, origin)` and call it from both branches (JWT-verified and bootstrap-token-verified).

**`bootstrap/README.md`:**

```markdown
# Bootstrap: Bulk Media-Day Photo Upload

One-time import of 306 media-day photos into the photo library.

## Steps

1. **Drop photos:** Place all photos in `bootstrap/media-day-2026/`. Subfolders OK.
2. **Confirm gitignore:** Run `git status` — photo files must NOT appear.
3. **Install sharp:** `npm install --no-save sharp` (only needed locally for this script).
4. **Set bootstrap token on worker:**
   ```bash
   # Generate a random token
   TOKEN=$(openssl rand -hex 32)
   echo "$TOKEN"   # save this somewhere temporarily
   cd workers/library
   echo "$TOKEN" | wrangler secret put BOOTSTRAP_TOKEN
   ```
5. **Run upload:**
   ```bash
   cd <repo-root>
   BOOTSTRAP_TOKEN=<paste-token-from-step-4> node bootstrap/upload-library-photos.js ./bootstrap/media-day-2026/
   ```
6. **Verify:**
   ```bash
   wrangler d1 execute canonniers-db --remote --command="SELECT COUNT(*) FROM photo_library;"
   # Expect: 306
   wrangler r2 object list player-photos-library --prefix=library/ | wc -l
   # Expect: ~612 (306 originals + 306 thumbs)
   ```
7. **Remove bootstrap bypass — CRITICAL SECURITY STEP:**
   ```bash
   cd workers/library
   wrangler secret delete BOOTSTRAP_TOKEN
   # Then revert the bootstrap-token bypass code block in src/index.js
   # and redeploy: wrangler deploy
   ```
8. **Delete this script (optional but recommended):**
   ```bash
   git rm bootstrap/upload-library-photos.js
   git commit -m "chore(library): remove bootstrap upload script after one-time use"
   ```
```

**Verify before declaring commit done:**

- `SELECT COUNT(*) FROM photo_library` returns 306
- `wrangler r2 object list player-photos-library` shows ~612 objects (306 originals + 306 thumbs)
- All 306 rows have `linked_teams IS NULL` (unsorted, as expected)
- Bootstrap token secret deleted from worker
- Bootstrap bypass code reverted in worker source and redeployed

**Commit message:**
```
feat(library): one-time bulk upload bootstrap

- bootstrap/upload-library-photos.js: CLI uploader with local thumb gen
- Worker accepts X-Bootstrap-Token header for one-time admin bypass
- 306 media-day photos imported as unsorted
- Token deleted + bypass code reverted post-upload (see bootstrap/README.md)
```

**Rollback:**
```bash
# If upload failed partway or wrong photos uploaded:
wrangler d1 execute canonniers-db --remote --command="DELETE FROM photo_library;"
# Purge R2:
wrangler r2 object list player-photos-library --prefix=library/ | \
  awk '{print $1}' | xargs -I {} wrangler r2 object delete player-photos-library/{}
```

### Attack vectors for this commit specifically

- **Bootstrap token leak.** Token must be random (32 bytes hex), kept out of git, deleted from worker secrets immediately after use. If leaked, attacker could upload arbitrary files to the library R2 bucket until token is rotated. Mitigation: bootstrap bypass is restricted to ONLY the `/api/library/upload` endpoint and ONLY POST method. Cannot delete, cannot assign-player, cannot push-to-gallery.
- **Script run with wrong folder.** Script uploads everything matching `.jpg|.jpeg|.png|.webp` recursively. Dry-run by checking the `Found N photos in...` line at script start before letting it proceed. If N != 306, abort with Ctrl+C.
- **Bypass code not reverted.** This is the biggest risk. If Claude Code forgets to remove the bootstrap-token branch after upload completes, an attacker who guesses or leaks the token retains upload access indefinitely. Mark this step as **MANDATORY** in the verification matrix.

---

### Commit 3: `admin-photo-library.html` + admin tile

**New file:** `admin-photo-library.html`
**Edited file:** `admin.html` (add tile)

**`admin-photo-library.html` structure:**

Use `admin-photos.html` as the styling reference — same Barlow Condensed, navy/sky palette, topbar, tab-nav pattern, identity-loading spinner pattern, CF Access get-identity flow.

Page has four tabs in the topbar:
1. **Téléverser / Upload** — drag-drop zone, 306-file batch, per-file progress, client-side thumbnail generation
2. **Bibliothèque / Library** — grid view with filter pills (`Tous / Non triées / 15U / 17U D1 / 17U D2`)
3. **Galerie publique / Push to Gallery** — multi-select from library, opens batch push modal (date + event name)
4. **Supprimer / Delete** (admin only — hidden for coach role) — admin destructive ops

**Client-side thumbnail generation** (inside Upload tab JS):

```javascript
async function makeThumb(file, maxEdge = 800) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(maxEdge / Math.max(bmp.width, bmp.height), 1);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
}

// In upload loop:
const formData = new FormData();
for (const file of selectedFiles) {
  formData.append('files', file);
  const thumb = await makeThumb(file);
  formData.append(`thumb_${file.name}`, thumb, `${file.name}.thumb.jpg`);
}
const res = await fetch(`${WORKER_URL}/api/library/upload`, {
  method: 'POST',
  credentials: 'include',  // sends CF Access cookie
  body: formData,
});
```

**Library tab grid:**

**Virtualization (O2):** Render all photo rows as placeholder `<div>` tiles with fixed dimensions (consistent height matters — use CSS `aspect-ratio: 3/4` or fixed `height: 220px`). Use `IntersectionObserver` with `rootMargin: '400px'` (~2 viewport heights of buffer). Only tiles intersecting the buffer get their `<img>` swapped in; tiles outside get reverted to placeholder. This keeps active `<img>` count to ~50 regardless of total photo count.

```javascript
// Virtualized grid renderer
let observer = null;

function renderGrid(photos) {
  const grid = document.querySelector('.library-grid');
  grid.innerHTML = photos.map(p => `
    <div class="lib-card lib-card-placeholder"
         data-photo-id="${p.id}"
         data-filename="${escapeHtml(p.filename)}"
         data-linked-teams='${p.linked_teams || ''}'
         data-gallery="${p.pushed_to_gallery_at ? '1' : '0'}"
         style="aspect-ratio: 3/4;">
    </div>
  `).join('');

  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const card = entry.target;
      if (entry.isIntersecting) {
        hydrateCard(card);
      } else {
        dehydrateCard(card);
      }
    });
  }, { rootMargin: '400px' });

  grid.querySelectorAll('.lib-card').forEach(c => observer.observe(c));
}

function hydrateCard(card) {
  if (card.dataset.hydrated === '1') return;
  const id = card.dataset.photoId;
  const filename = card.dataset.filename;
  const teamsJson = card.dataset.linkedTeams;
  const teams = teamsJson ? JSON.parse(teamsJson) : null;
  const inGallery = card.dataset.gallery === '1';

  const badgeHtml = teams
    ? teams.map(t => `<span class="badge badge-${t}">${t.toUpperCase()}</span>`).join('')
    : '<span class="badge badge-unsorted">Non triée</span>';
  const galleryBadge = inGallery ? '<span class="badge badge-gallery">Galerie</span>' : '';

  card.innerHTML = `
    <img loading="lazy" src="${WORKER_URL}/api/library/file/${id}?thumb=1" alt="${filename}">
    <div class="lib-card-meta">
      <span class="lib-filename">${filename}</span>
      <span class="lib-badges">${badgeHtml}${galleryBadge}</span>
    </div>
  `;
  card.classList.remove('lib-card-placeholder');
  card.dataset.hydrated = '1';
}

function dehydrateCard(card) {
  if (card.dataset.hydrated !== '1') return;
  card.innerHTML = '';
  card.classList.add('lib-card-placeholder');
  card.dataset.hydrated = '0';
}
```

CSS for placeholder state — keep visible footprint identical to hydrated card to prevent layout shift:
```css
.lib-card { aspect-ratio: 3/4; background: var(--surface-3); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.lib-card-placeholder { background: linear-gradient(135deg, var(--surface-3) 0%, var(--surface) 100%); }
.lib-card img { width: 100%; height: 100%; object-fit: cover; }
```

Apply the same virtualization pattern to the picker modal in commit 4.

Lightbox on click (reuse pattern from `galerie.html`). Lightbox actions:
- **Assign to player** (opens player picker, scoped to caller's teams)
- **Push to gallery** (admin/coach for that team)
- **Delete** (admin only)

**Filter pills wired to:**

```javascript
async function loadGrid(filter = 'all') {
  const r = await fetch(`${WORKER_URL}/api/library?filter=${filter}`, { credentials: 'include' });
  if (!r.ok) return showError();
  const { photos } = await r.json();
  allPhotos = photos;
  renderGrid(photos);
}
```

**Identity loading + role gate** (top of script, mirror `admin-photos.html`):

```javascript
async function loadIdentity() {
  try {
    const idR = await fetch('/cdn-cgi/access/get-identity', { credentials: 'include' });
    if (!idR.ok) return window.location.href = '/admin.html';
    const { email } = await idR.json();
    const aR = await fetch(`https://canonniers-auth-worker.chisholm2000.workers.dev?email=${encodeURIComponent(email)}`);
    const identity = await aR.json();
    if (!identity.role || !['admin','coach','photo'].includes(identity.role)) {
      return window.location.href = '/admin.html';
    }
    CALLER_ROLE = identity.role;
    CALLER_TEAMS = identity.teams || [];
    // Hide team filter pills the coach has no access to
    if (CALLER_ROLE !== 'admin') {
      document.querySelectorAll('[data-filter]').forEach(p => {
        const f = p.dataset.filter;
        if (ALLOWED_TEAMS.includes(f) && !CALLER_TEAMS.includes(f)) p.style.display = 'none';
      });
      document.getElementById('tab-delete').style.display = 'none';
    }
    document.getElementById('identity-loading').style.display = 'none';
    document.getElementById('admin-screen').style.display = 'block';
    loadGrid('unsorted');  // coaches default-land here
  } catch (e) {
    window.location.href = '/admin.html';
  }
}
loadIdentity();
```

**Add to `admin.html` tile array** (after the `photos` tile):

```javascript
{
  id: 'library',
  href: '/admin-photo-library.html',
  icon: 'folder',
  titleFr: 'Bibliothèque de photos',
  titleEn: 'Photo Library',
  descFr: 'Banque privée de photos pour assignation aux joueurs ou publication.',
  descEn: 'Private photo bank for player assignment or publication.',
  allowed: ['admin', 'coach', 'photo'],
  status: 'active',
  phase: null
},
```

**Verify:**

- Log in as `jay@canonniers.ca` (admin) → tile appears → all 4 tabs visible
- Log in as `coach-u15@canonniers.ca` (or test role) → tile appears → Delete tab hidden → only `Tous / Non triées / 15U AAA` filter pills visible
- Upload 5 test photos → confirm both originals and thumbs land in R2 (check via `wrangler r2 object list`)
- Grid loads with thumb URLs that 200 from the worker
- Open browser DevTools network tab during grid load — confirm `Cache-Control: private, max-age=300` on file responses

**Commit message:**
```
feat(library): admin-photo-library.html + admin tile

- 4 tabs: Upload, Library grid, Push to gallery, Delete (admin)
- Client-side thumbnail generation (800px JPEG q75)
- CF Access identity gate, role-scoped UI
- See DIRECTIVE-photo-library.md commit 3
```

---

### Commit 4: Roster editor modal — "Choose from library"

**Edited file:** `admin-roster.html`

**Changes:**

1. In the player edit form, next to the existing `<input type="file" id="p-photo">`, add:
   ```html
   <button type="button" class="btn-secondary" onclick="openLibraryPicker()">
     <span class="fr-text">Choisir depuis la bibliothèque</span>
     <span class="en-text">Choose from library</span>
   </button>
   ```

2. Add modal markup at the bottom of the body:
   ```html
   <div id="library-picker-modal" class="modal-overlay" style="display:none;">
     <div class="modal-inner modal-wide">
       <div class="modal-header">
         <h2><span class="fr-text">Choisir une photo</span><span class="en-text">Choose a photo</span></h2>
         <button onclick="closeLibraryPicker()" class="modal-close">&times;</button>
       </div>
       <div class="modal-body">
         <div id="library-picker-grid" class="library-picker-grid"></div>
       </div>
     </div>
   </div>
   ```

3. JS:
   ```javascript
   const LIBRARY_WORKER = 'https://canonniers-library-worker.chisholm2000.workers.dev';

   async function openLibraryPicker() {
     const team = document.getElementById('p-team').value;
     if (!team) { showToast('Sélectionnez une équipe d\'abord / Select a team first'); return; }

     const modal = document.getElementById('library-picker-modal');
     const grid  = document.getElementById('library-picker-grid');
     grid.innerHTML = '<div class="loading-row"><div class="spinner"></div></div>';
     modal.style.display = 'flex';

     // E4a: team's photos + unsorted
     const r1 = await fetch(`${LIBRARY_WORKER}/api/library?filter=${team}`, { credentials: 'include' });
     const r2 = await fetch(`${LIBRARY_WORKER}/api/library?filter=unsorted`, { credentials: 'include' });
     if (!r1.ok || !r2.ok) { grid.innerHTML = '<p>Erreur</p>'; return; }
     const teamPhotos = (await r1.json()).photos || [];
     const unsorted = (await r2.json()).photos || [];
     const all = [...teamPhotos, ...unsorted];

     grid.innerHTML = all.map(p => `
       <div class="picker-tile" data-id="${p.id}" onclick="pickLibraryPhoto(${p.id})">
         <img loading="lazy" src="${LIBRARY_WORKER}/api/library/file/${p.id}?thumb=1" alt="">
         <div class="picker-tile-name">${escapeHtml(p.filename)}</div>
       </div>
     `).join('');
   }

   async function pickLibraryPhoto(photoId) {
     const playerId = document.getElementById('player-id').value;
     if (!playerId) {
       showToast('Sauvegardez le joueur d\'abord / Save player first');
       return;
     }
     const r = await fetch(`${LIBRARY_WORKER}/api/library/${photoId}/assign-player`, {
       method: 'POST',
       credentials: 'include',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ player_id: parseInt(playerId, 10) }),
     });
     if (!r.ok) {
       const err = await r.json().catch(() => ({}));
       showToast(`Erreur: ${err.error || r.status}`);
       return;
     }
     closeLibraryPicker();
     showToast('Photo assignée / Photo assigned');
     loadPlayers();
   }

   function closeLibraryPicker() {
     document.getElementById('library-picker-modal').style.display = 'none';
   }
   ```

**Workflow constraint to note in commit message:** The picker only works for *existing* players (those with an `id`). New-player flow: save player first → reopen edit → choose from library. Document this on the UI with a hint near the button:
```html
<small class="hint">
  <span class="fr-text">Sauvegardez d'abord le joueur, puis rouvrez pour assigner une photo.</span>
  <span class="en-text">Save player first, then reopen to assign a photo.</span>
</small>
```

**Verify:**

- Edit existing u15 player → click "Choose from library" → modal shows u15 photos + unsorted photos, no u17 photos
- Pick a photo → confirm:
  - Library row gets `linked_teams = '["u15"]'` (or appended), `linked_player_ids` gets the player id
  - Public bucket gets a new object at `players/{playerId}.jpg`
  - `players.photo_url` updates to the public URL (e.g. `/players/{id}.jpg`)
- Reload `alignement.html` and `joueur.html?id=X` (open in incognito to confirm no CF Access cookie needed) → **photo renders for public visitors**

**Commit message:**
```
feat(roster): "Choose from library" picker modal

- E4a scope: caller's team + unsorted
- O1b: assign copies bytes from private library to public bucket
- players.photo_url stores public bucket URL (no JWT needed for public pages)
- Existing file-upload flow remains untouched as fallback
- See DIRECTIVE-photo-library.md commit 4
```

---

### Commit 5: robots.txt + noindex sweep + verification matrix

**Edited file:** `robots.txt`

Append:
```
Disallow: /admin-photo-library.html
```

Confirm `admin-photo-library.html` has:
```html
<meta name="robots" content="noindex, nofollow">
```

**New file:** `docs/library-verification-matrix.md` — test checklist for QA before declaring feature done.

**Verify by running the full QA matrix below.**

---

## Post-deploy verification matrix

Run end-to-end as multiple identities. Expected results bolded.

| # | Action | As | Expected |
|---|---|---|---|
| 1 | Visit `https://canonniersdequebec.ca/admin-photo-library.html` | Unauthenticated | **Redirect to CF Access login** |
| 2 | Visit same URL | jay@canonniers.ca (admin) | **All 4 tabs visible** |
| 3 | Visit same URL | coach-u15 test account | **3 tabs visible, Delete tab hidden** |
| 4 | Upload 5 photos in batch | coach-u15 | **All 5 land in `Non triées` tab** |
| 5 | Open Library tab as coach-u15, filter "Tous" | coach-u15 | **Shows only unsorted + future u15-stamped photos** |
| 6 | In `admin-roster.html`, edit u15 player, click "Choose from library" | coach-u15 | **Modal shows unsorted + u15 only** |
| 7 | Pick photo, save | coach-u15 | **`players.photo_url` updates, library photo now stamped `["u15"]`** |
| 8 | Reload library page | coach-u15 | **Photo now in u15 tab AND still in Tous; Non triées no longer shows it** |
| 9 | Same photo, now also assign to u17d1 player as admin | jay | **`linked_teams` becomes `["u15","u17d1"]`, photo appears in both team tabs** |
| 10 | Visit `https://canonniers-library-worker.../api/library/file/1` directly | Unauthenticated curl | **401 or Access login redirect** |
| 11 | Visit `https://canonniers-library-worker.../api/library/file/1` | Admin browser tab | **200, image bytes** |
| 12 | DELETE photo via curl as coach | coach token | **403** |
| 13 | DELETE photo via admin UI | jay | **200, R2 object gone (`wrangler r2 object list` no longer shows key)** |
| 14 | Push-to-gallery from library | coach-u15 for u15 photo | **Gallery row created, library row gets `pushed_to_gallery_at` timestamp** |
| 15 | Visit `/galerie.html?team=u15` | Public | **Pushed photo appears in public gallery** |
| 16 | Visit `/alignement.html` after photo assignment | **PUBLIC** (incognito, no Access cookie) | **200, photo renders from public bucket** |
| 17 | Pre-flight check: inspect one existing `players.photo_url` value to confirm public bucket URL format | jay via `wrangler d1 execute` | **Must document the format (e.g. `/players/N.jpg` vs full URL) and adjust worker's `publicUrl` construction to match** |
| 18 | Confirm bootstrap bypass is fully removed | jay | `wrangler secret list` shows no `BOOTSTRAP_TOKEN`; grep `workers/library/src/index.js` for "Bootstrap" returns no matches; redeployed worker rejects `X-Bootstrap-Token` header with normal 401 |
| 19 | All 306 media-day photos imported and visible | admin in Library tab | **306 tiles, all in `Non triées`, sorted by filename ascending** |

---

## Resolved decisions (replaces prior open questions)

### O1 → RESOLVED: Copy bytes to public bucket on assign (O1b)

On assignment to a player:
1. Copy bytes from `player-photos-library` (private) to existing `player-photos` (public) under stable key `players/{playerId}.jpg`
2. Overwrite on reassignment (player keeps one current photo, same as today)
3. Write public URL to `players.photo_url`
4. Library row keeps its master copy, gets `linked_teams` and `linked_player_ids` stamps

**Cascade behaviors:**
- **Admin deletes library photo that's currently assigned to a player:** Library row deleted, but `players/{playerId}.jpg` in public bucket persists. Player card continues to render. This is intentional — the public-facing photo is decoupled from library lifecycle. Admin must separately clear `players.photo_url` if they want the player to revert to no photo.
- **Coach reassigns player to a different library photo:** `players/{playerId}.jpg` is overwritten in the public bucket. Old library row's `linked_player_ids` retains the player id historically; new library row gains it. Both library rows now show as ever-linked to this player.

Storage impact: 306 photos × ~3MB master + ~36 players × ~3MB public copies = ~1GB total. Well under R2 free tier (10GB).

### O2 → RESOLVED: Grid virtualization (~50 visible tiles)

Use intersection-observer-based virtualization. Render placeholder divs for all rows; only swap in `<img>` tags for tiles within ~2 viewport-heights of visible. Tiles scrolled off get their `<img>` removed and replaced with placeholder. Adds ~100 lines of JS.

### O3 → RESOLVED: Widen sanitizer to Latin-1 supplement

Allowed character set: `[A-Za-zÀ-ÿ0-9._\- ]`. Covers French accented characters (é, è, ê, à, ç, etc.). Still blocks shell metacharacters, quotes, angle brackets, slashes, and other XSS/path-traversal risks.

---

## Rollback plan

Each commit is independently revertible. If the feature must be fully rolled back:

```bash
# In reverse commit order
git revert HEAD~4..HEAD                    # revert commits 5,4,3,2 (NOT commit 1 — that's the schema)
git push origin main

# Cleanup
wrangler delete --name canonniers-library-worker
wrangler r2 bucket delete player-photos-library
# (after confirming no production traffic depends on it)
wrangler d1 execute canonniers-db --remote --command="DROP TABLE photo_library;"

# Remove route from CF Access AuthCanonniers app
# Remove admin-photo-library.html tile from admin.html (already in git revert)
```

D1 backup from pre-flight step 4 is the canonical recovery point if anything goes sideways with the migration.

---

## Final note

All commits 1–5 are ready to execute in sequence. Each is independently revertible. Pre-flight step 5 (fetching current source-of-truth files from GitHub) is mandatory before commit 3 to confirm `admin.html` tile-array structure hasn't drifted from the version this directive was written against.

**One pre-flight item Claude Code MUST verify before commit 4:** Inspect one existing `players.photo_url` value via:
```bash
wrangler d1 execute canonniers-db --remote --command="SELECT id, name, photo_url FROM players WHERE photo_url IS NOT NULL LIMIT 1;"
```
The worker's `publicUrl` variable in `assign-player` must match the existing format exactly. If existing URLs are absolute (`https://canonniers-roster-worker.chisholm2000.workers.dev/players/...`) instead of relative (`/players/...`), update the construction in `index.js` accordingly. Mismatched formats will break the player photo rendering on public pages.
