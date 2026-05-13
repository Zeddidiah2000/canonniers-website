# Directive: Photo-Vault Architecture & Security Protocol (v4.1 — Implementation-Ready)

## 1. Project Context

Add a Photo Gallery module to the existing Canonniers de Québec admin suite. The module activates the "Photo Gallery" tile already present in `admin.html` (currently in "coming soon" state) and adds a new public gallery page for fans.

**Scope:** Phase 1 only. Fan Zone (public contributions), Story Generator, and post-game result cards are explicitly deferred.

**Roles with access:** `admin`, `coach`, `manager`. Locked for `treasurer`.

---

## 2. Pre-Flight Verification (Required Before Any Changes)

Claude Code must complete every step before applying any patch. Stop and ask Jay if any check fails.

1. **Fetch current state from GitHub raw URLs (single source of truth):**
   - `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin.html` — locate the existing Photo Gallery entry in the `TILES` array
   - `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/robots.txt` — confirm current Disallow list
   - `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/wrangler.toml` — confirm no existing `photo-worker` binding or naming collision
   - `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin-social.html` — reference for established admin-page conventions (noindex, badge, back-link)
2. **Confirm Cloudflare Images is enabled on the account.** If not, stop and ask Jay to enable it.
3. **Confirm three Cloudflare Images variants are created** (or create them in this order):
   - `thumb` — 300×300, fit=cover, quality=75
   - `gallery` — 800w, fit=scale-down, quality=80
   - `hero` — 1600w, fit=scale-down, quality=85
4. **Confirm `PHOTO_UPLOAD_TOKEN` secret is set** via `wrangler secret put PHOTO_UPLOAD_TOKEN` on the `photo-worker`. Must be at least 32 random bytes (not a typed password). This secret is **separate** from the existing `canonniersdequebec2026` bearer token used by the roster worker.
5. **Confirm Workers Rate Limiting binding configuration** is supported in current `wrangler.toml`.
6. **Verify the `canonniers-db` D1 instance exists** and the migration file `update_schema_v4_photos.sql` does not collide with existing tables.
7. **Verify Cloudflare Images API token** has been provisioned with read/write/delete scopes for the photo-worker to call.

If any item is unclear, ask Jay before proceeding. Do not invent values.

---

## 3. Architecture: Cloudflare Images Direct Creator Upload

Rationale: eliminates EXIF-stripping code, decompression bomb risk, and Worker upload bandwidth. Cloudflare Images strips EXIF (GPS/Device data) automatically on ingestion.

### 3.1 Upload Flow

1. Admin selects files and a game in the Match Picker UI on `admin-photos.html`.
2. Browser performs **client-side magic byte check** on each file (UX layer — see §5.2). Invalid files are rejected before any network call.
3. Browser → `photo-worker` `POST /api/upload-url`: requests one-time signed Direct Creator Upload URL from Cloudflare Images. Worker authenticates the request with `PHOTO_UPLOAD_TOKEN` Bearer header. Worker also tags each Cloudflare Images request with custom metadata `{ "uploader": "photo-worker", "team": "<u15|u17d1|u17d2>", "event_date": "<YYYY-MM-DD>" }` for rollback/cleanup identification.
4. Browser → Cloudflare Images directly: `POST` binary to signed URL.
5. Cloudflare Images returns image ID. Browser → `photo-worker` `POST /api/photos`: sends `cf_image_id` plus user-entered metadata (team, event date, event name, captions).
6. `photo-worker` calls Cloudflare Images API `GET /images/v1/{id}` to fetch authoritative `width`, `height`, `mime_type`, `file_size_bytes`. **Never trust client-supplied values for these fields.**
7. `photo-worker` inserts row into D1 `photos` table.

### 3.2 Delivery Path

- Public reads via `https://imagedelivery.net/<ACCOUNT_HASH>/<cf_image_id>/<variant>`.
- No custom subdomain in Phase 1. `imagedelivery.net` is already cookieless and isolated from the main site's CSP — polyglot/hot-link mitigations are Cloudflare's responsibility.
- Public gallery query **must** filter `WHERE is_published = 1`.

---

## 4. D1 Schema

**Target instance:** `canonniers-db` (existing, additive migration).
**Migration file:** `update_schema_v4_photos.sql`. Must be idempotent (`CREATE TABLE IF NOT EXISTS`).

```sql
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cf_image_id TEXT UNIQUE NOT NULL,
  team_category TEXT NOT NULL CHECK (team_category IN ('u15','u17d1','u17d2')),
  event_name_fr TEXT NOT NULL,
  event_date TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  file_size_bytes INTEGER,
  mime_type TEXT,
  caption_fr TEXT,
  caption_en TEXT,
  uploaded_by TEXT DEFAULT 'Admin',
  is_published INTEGER NOT NULL DEFAULT 1,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_photos_team_date ON photos(team_category, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_photos_published_date ON photos(is_published, event_date DESC);
```

**Notes:**
- `width`, `height`, `mime_type`, `file_size_bytes` are nullable to avoid INSERT failures during the brief window between upload completion and the Cloudflare Images metadata fetch. Worker should populate them in the same insert when available; backfill cron is acceptable for late arrivals.
- `is_published` is INTEGER (0/1), not BOOLEAN — D1 stores BOOLEAN as INTEGER anyway and explicit typing avoids portability surprises.
- `event_name_fr` is FR-only by deliberate design (consistent with québécois register; opponent names from Spordle are French).

---

## 5. Security & Validation

### 5.1 Authentication (Two Layers)

**Page-level (`admin-photos.html`):** Use the existing JS-visible password pattern (`canonniersdequebec2026`) consistent with `admin.html`, `admin-social.html`, `admin-roster.html`. This page joins the same Cloudflare Access migration cohort already on the backlog — do not invent a separate auth scheme for this single page.

**Worker-level (`photo-worker` write endpoints):** `Authorization: Bearer <PHOTO_UPLOAD_TOKEN>`. Separate secret from the roster worker's token so compromise of one does not grant access to the other. Token must never appear in URLs or logs.

**Future:** When Cloudflare Access is wired up for the admin cohort, also configure Service Auth on the `photo-worker` so the API itself is reachable only by authenticated origin. Note in backlog, do not implement now.

### 5.2 Input Validation

**Client-side magic byte check (UX, not security):**
- JPEG: `FF D8 FF`
- PNG: `89 50 4E 47 0D 0A 1A 0A`
- WebP: `52 49 46 46` at offset 0 AND `57 45 42 50` at offset 8

Reject invalid files before PUT to Cloudflare Images. Display a clear bilingual error.

**Actual security boundary:** Cloudflare Images itself rejects non-image binaries server-side. The client check is for fast feedback only.

### 5.3 Limits

- **Per file:** 15 MB max
- **Per batch:** 50 files max, 200 MB total max
- **Allowed MIME types:** `image/jpeg`, `image/png`, `image/webp` only

### 5.4 Rate Limiting

Configure Workers Rate Limiting binding in `wrangler.toml`:

```toml
[[unsafe.bindings]]
name = "UPLOAD_LIMITER"
type = "ratelimit"
namespace_id = "<assigned>"
simple = { limit = 50, period = 60 }
```

50 requests per IP per 60 seconds on `/api/upload-url` and `/api/photos` endpoints. On limit hit: return `429` with `Retry-After: 60` header. Read endpoints are not rate-limited (served by Cloudflare Images directly).

---

## 6. Endpoints (`photo-worker`)

All write endpoints require `Authorization: Bearer <PHOTO_UPLOAD_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/upload-url` | Request one-time Cloudflare Images Direct Creator Upload URL. Returns `{ uploadURL, id }`. |
| `POST` | `/api/photos` | Insert D1 row after Cloudflare Images upload completes. Worker fetches authoritative metadata from Cloudflare Images API. |
| `GET` | `/api/photos?team=u15&from=2026-04-01&to=2026-04-30` | Public read endpoint. Filters: `team`, `from`, `to`. **Always** appends `WHERE is_published = 1`. No auth required. |
| `DELETE` | `/api/photos/:id` | See §7. |

CORS: allow only `https://canonniersdequebec.ca` origin for write endpoints. Read endpoint may be wider if the public gallery embeds elsewhere (not in Phase 1).

---

## 7. Delete Behavior

Two distinct flows. No "optional" hard delete.

### 7.1 Soft Delete (Standard)

`DELETE /api/photos/:id` with query param `?mode=unpublish`:

1. Set `is_published = 0` in D1.
2. **Also** call Cloudflare Images API to set the image to `requireSignedURLs: true`. This breaks the public `imagedelivery.net` URL immediately — soft-deleted photos cannot be retrieved by anyone with the prior URL.
3. Image binary remains in Cloudflare Images for 30 days.

### 7.2 Hard Delete (Required for Parent Removal Requests)

`DELETE /api/photos/:id` with query param `?mode=purge`:

1. Call Cloudflare Images API `DELETE /images/v1/{id}` to remove the binary.
2. Delete the D1 row.
3. Both must succeed. If Cloudflare Images delete fails, do not delete D1 row — return error so caller can retry. If D1 delete fails after CF success, log the orphan `cf_image_id` for manual cleanup.

### 7.3 Cleanup Cron (Phase 1.1, Not Phase 1)

Document as a follow-up task: scheduled Worker that hard-deletes any photo where `is_published = 0 AND uploaded_at < (now - 30 days)`. Not implemented in this directive — note in backlog.

---

## 8. Admin UI (`admin-photos.html`)

### 8.1 Page Conventions (Match Existing Admin Pages)

- `<meta name="robots" content="noindex, nofollow">`
- Bilingual page badge in header: "Galerie photos" / "Photo Gallery" — consistent with the tile titles in `admin.html`.
- Back-link to `/admin.html` (top-left, matches `admin-social.html` and `admin-roster.html`).
- Same Barlow Condensed font, navy/sky-blue palette, FR/EN toggle as other admin pages.
- Add `Disallow: /admin-photos.html` to `robots.txt`.

### 8.2 Tile Activation in `admin.html`

Locate the existing entry in the `TILES` array with `id: 'photos'` and modify the following fields exactly:

| Field | Current value | New value |
|---|---|---|
| `href` | `null` | `'/admin-photos.html'` |
| `allowed` | `['admin', 'manager']` | `['admin', 'coach', 'manager']` |
| `status` | `'coming-soon'` | `'active'` |
| `phase` | `'Phase 3'` | `null` |

Leave all other fields (`id`, `icon`, `titleFr`, `titleEn`, `descFr`, `descEn`) unchanged. The existing copy is good as-is.

**Role rationale:** Both coaches and team managers may upload game-day photos from the field. `admin` retains access by default. `treasurer` is locked out (no business in photo management).

### 8.3 Match Picker

1. On page load, fetch schedule from `https://spordle-proxy.chisholm2000.workers.dev` for all three teams.
2. Cache response in `localStorage` with 15-minute TTL. Key: `canonniers_schedule_cache`. Value: `{ data: <response>, expires: <epoch ms> }`. Check expiry on each load.
3. Render a list of recent + upcoming games (configurable: default last 14 days + next 7 days).
4. On selection, auto-fill `team_category`, `event_date`, `event_name_fr` (formatted as `vs <opponent>` from Spordle data; use the same opponent name format the public calendar already uses).

### 8.4 Batch Upload UI

- Native `<input type="file" multiple accept="image/jpeg,image/png,image/webp">`.
- Per-file progress bars during PUT to Cloudflare Images.
- Per-file status: pending → validating → uploading → confirming → done (or error).
- Display rejected files with reason (size, type, magic byte mismatch, network error).
- Bilingual `caption_fr` / `caption_en` fields per file (optional). Default both empty.
- `uploaded_by` defaults to "Admin". Future role integration deferred.
- Submit button disabled until at least one file is valid and a game is selected.

### 8.5 Error Handling

- 401/403 → redirect to admin landing
- 429 → display "Trop de téléchargements / Too many uploads, réessayer dans 1 minute / retry in 1 minute"
- Network errors → retry button per file, max 3 retries, with a global circuit breaker that stops further uploads after 5 consecutive failures across the batch (prevents burning mobile data on a flaky connection at the field)
- Cloudflare Images upload failure → log full response for debugging, display generic error to user

---

## 9. Public Gallery (`galerie.html`)

### 9.1 Layout

- Three-tab structure (15U AAA, 17U D1, 17U D2) consistent with calendrier/diffusion/alignement.
- Within each tab: photos grouped by `event_date` descending, then by event name.
- Each event group shows up to N thumbs (configurable, default 12); "View all" link reveals the rest.
- Shared header/footer/nav with site, Barlow Condensed, navy/sky/white.
- Content width breakpoints follow the site convention: `1100px → 1380px → 1680px`.

### 9.2 Image Loading

- Use Intersection Observer for lazy loading (do **not** rely solely on `loading="lazy"` — Safari support is inconsistent at scale).
- `srcset` per image:
  ```
  https://imagedelivery.net/<HASH>/<id>/thumb 300w,
  https://imagedelivery.net/<HASH>/<id>/gallery 800w,
  https://imagedelivery.net/<HASH>/<id>/hero 1600w
  ```
- `sizes` attribute matched to grid breakpoints.
- `width` and `height` attributes set from D1 columns to prevent CLS. If DB values are NULL, omit attributes (degraded — no CLS prevention until backfilled).

### 9.3 Lightbox

- Click thumb → open lightbox at `hero` variant.
- Keyboard navigation (arrow keys, Esc).
- No download button in Phase 1 (right-click is not blocked — accept that).
- Caption shown in active language.

### 9.4 Empty States

- Bilingual message when a team has zero published photos.
- Match the tone of the calendrier empty state.

---

## 10. Bilingual Standards

- Every UI string in `<span class="fr-text">…</span><span class="en-text">…</span>` pairs.
- Language toggle uses existing `setLang()` function and `localStorage` key `lang`.
- Captions stored separately in `caption_fr` / `caption_en`. Display the active language; if the active-language caption is empty, fall back to the other; if both empty, render no caption.
- `event_name_fr` is FR-only and renders identically in both languages (e.g., "vs Voyageurs de Saguenay" appears in both EN and FR views — opponent names are proper nouns).

---

## 11. Files to Create/Modify

**Create:**
- `admin-photos.html`
- `galerie.html`
- `update_schema_v4_photos.sql` (in repo root, follows existing convention)
- `photo-worker/src/index.js` (or whatever the existing Worker layout pattern dictates — check `canonniers-roster-worker` structure)
- `photo-worker/wrangler.toml`

**Modify:**
- `admin.html` — activate Photo Gallery tile in `TILES` array
- `robots.txt` — add `Disallow: /admin-photos.html`
- (Optional) `index.html` — add nav link to `/galerie.html` if Jay wants public discoverability in Phase 1; otherwise gallery is unlisted

**Do not modify:**
- `canonniers-roster-worker` — separate concern, separate worker
- `wrangler.toml` for any other worker

---

## 12. Commit Sequence

Apply as discrete commits, each independently testable and rollbackable.

1. **Commit 1:** D1 migration. Apply `update_schema_v4_photos.sql` to `canonniers-db`. Verify table exists and indexes are present. No code changes. No deploy impact.
2. **Commit 2:** `photo-worker` deployment. Worker code, `wrangler.toml`, secret, rate limit binding. Does not affect any existing page. Verify all four endpoints respond correctly with `curl` (write endpoints reject without bearer; read endpoint returns empty array).
3. **Commit 3:** `admin-photos.html` page. Unlinked from `admin.html` for now. Test upload flow end-to-end via direct URL. Verify uploaded photos appear in Cloudflare Images dashboard with correct metadata tags.
4. **Commit 4:** `galerie.html` page. Unlinked from main nav for now. Test render against real uploaded photos.
5. **Commit 5:** Activate Photo Gallery tile in `admin.html`. Add `robots.txt` entry. (Optional) Add main nav link to `galerie.html`.

Each commit message follows the existing convention used in recent project notes. After each commit, fetch raw GitHub URL of changed files to confirm push succeeded before proceeding to next commit.

---

## 13. Verification Steps After Each Deploy

After **Commit 2** (worker):
- `curl -X POST https://photo-worker.chisholm2000.workers.dev/api/upload-url` → expect 401
- `curl -X POST -H "Authorization: Bearer $PHOTO_UPLOAD_TOKEN" https://photo-worker.../api/upload-url` → expect 200 with valid `uploadURL`
- `curl https://photo-worker.../api/photos?team=u15` → expect `{ photos: [] }`
- Cloudflare Worker logs show non-zero `cpuTimeMs` (deployment is live, not stale)

After **Commit 3** (admin page):
- Upload one test photo of each format (JPEG, PNG, WebP)
- Upload one oversized file → expect rejection
- Upload one non-image file with `.jpg` extension → expect client-side magic byte rejection
- Confirm D1 row created with all metadata populated (width, height, mime_type non-NULL)
- Confirm Cloudflare Images dashboard shows custom metadata tags

After **Commit 4** (gallery):
- Confirm CLS score ≈ 0 in Lighthouse with photos loaded
- Confirm `srcset` resolves correct variant per viewport
- Confirm `is_published = 0` photos do not appear
- Test lightbox keyboard navigation

After **Commit 5** (activation):
- Confirm tile is unlocked for `?role=admin`, `?role=coach`, and `?role=manager`
- Confirm tile is locked for `?role=treasurer`
- Confirm `/admin-photos.html` is in `robots.txt`

---

## 14. Rollback Plan

Each commit is independently reversible. Rollback in reverse order.

**Commit 5 reversal:**
- Revert `admin.html` to previous state (Photo Gallery tile back to `coming-soon`)
- Remove `robots.txt` entry for `/admin-photos.html`
- Remove main nav link if added

**Commit 4 reversal:**
- Delete `galerie.html`

**Commit 3 reversal:**
- Delete `admin-photos.html`

**Commit 2 reversal:**
- `wrangler delete photo-worker`
- `wrangler secret delete PHOTO_UPLOAD_TOKEN`
- Remove rate limit binding configuration
- **List and delete Cloudflare Images uploads tagged `uploader: photo-worker`** via Cloudflare Images API. The custom metadata tag from §3.1 makes these identifiable. Without this step, orphaned binaries remain billable.

**Commit 1 reversal:**
- `DROP TABLE photos` on `canonniers-db`
- `DROP INDEX idx_photos_team_date`
- `DROP INDEX idx_photos_published_date`

---

## 15. Open Questions for Claude Code

If any of the following are unclear after pre-flight, ask Jay before proceeding:

1. Whether `galerie.html` should be linked from main site nav in Phase 1 or remain unlisted.
2. Whether the Match Picker should include all three teams in one dropdown or filter by team first.
3. Default time window for Match Picker (recommendation: last 14 days + next 7 days).
4. The Cloudflare Images delivery `<ACCOUNT_HASH>` — must be retrieved from Jay's Cloudflare dashboard.

---

## 16. Out of Scope (Phase 2+)

Documented for architectural awareness; **do not implement**:

- Fan Zone public contribution queue with QR code
- Story Generator (logo/score overlays for IG/FB)
- Post-game result card generator
- Cleanup cron for soft-deleted photos older than 30 days
- Cloudflare Access on `admin-photos.html` (handled in admin-cohort migration)
- Cloudflare Access Service Auth on `photo-worker`
- Custom subdomain for Cloudflare Images delivery
- Public download buttons / right-click protection
- Bilingual `event_name_en` field
- Photo reordering within an event
- Bulk metadata edit (caption, publish status across multiple photos)

---

*End of directive. v4.1 final — drafted 2026-04-29. Roles locked: admin + coach + manager.*
