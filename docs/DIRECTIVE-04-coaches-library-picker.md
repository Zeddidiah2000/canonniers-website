# Directive #4 — Library Picker (Path A) for Coach Photos

**Goal:** Add a "Choose from library" tab to `admin-coaches.html` matching the roster admin's Path A picker. New endpoint on `canonniers-library-worker`: `POST /api/library/:id/assign-coach`, which mirrors `assign-player` — copies the library file into the coach-photos system and leaves the library copy intact.

**Risk level:** Medium. Touches two workers (library worker for new endpoint, roster worker is unaffected) and one HTML file. The pre-flight is heavier than usual because we don't have direct visibility into the library worker's source — Claude Code must inspect before patching.

**Verification approach:** End-to-end browser test. Open admin, switch to Path A, pick a library photo, confirm public coach.html displays it. No curls.

**Rollback:** Two-step revert — `wrangler rollback` for library worker, `git revert` for admin-coaches.html.

---

## Pre-flight verification (REQUIRED before any patch)

This step is non-skippable. Claude Code must read both workers and **report findings to Jay before writing any patch**. The patch in step 2 assumes specific shapes; if reality differs, the patch needs adjustment.

### 1. Locate and read `canonniers-library-worker` source

Find the worker source on disk (likely `canonniers-library-worker/src/index.js` or similar). Read it end-to-end. Report:

- **What does `POST /api/library/:id/assign-player` actually do?** Specifically:
  - Does it read the library file from R2 and re-write it under a new key, or just update a database row?
  - Does it write to `canonniers-db` directly via a cross-worker D1 binding, or call the roster worker via fetch?
  - Does it strip EXIF or any other processing, or pass bytes through?
  - What's the response shape? `{ok: true}` or richer?
- **How is the library worker authenticated?** Memory says CF Access cookie-based for browser sessions. Confirm by finding where auth is checked.
- **What R2 bucket binding does it use?** Same bucket as roster (`env.BUCKET`)? Different one? If different, are library files accessible from the roster worker's bucket binding?
- **What D1 binding does it use?** Same `canonniers-db` as roster?

### 2. Confirm `coach_photos` table shape

```powershell
wrangler d1 execute canonniers-db --remote --command "PRAGMA table_info(coach_photos);"
```

Confirm columns: `coach_id, slug, photo_url, r2_key, created_at`.

### 3. Confirm slug allowlist in roster worker

The roster worker has `VALID_COACH_SLUGS` (set of 12 slugs). The new `assign-coach` endpoint in the library worker needs the same allowlist — otherwise the library worker writes to `coach_photos` with arbitrary slug values. Decide:

- **Option (a):** Hardcode the same 12-slug set in the library worker. Cheap, but two places to update when coaches change.
- **Option (b):** Library worker does `SELECT slug FROM coaches WHERE slug = ?` against canonniers-db to validate. One source of truth (the `coaches` table from directive #1), but requires the library worker to have the D1 binding to canonniers-db.

**Report which D1 binding the library worker already has, then default to Option (b) if `coaches` is reachable, Option (a) if not.**

### 4. STOP and report

After steps 1-3, Claude Code must:
- Post findings to Jay
- Wait for Jay to confirm or adjust the patch direction
- Do NOT proceed to step 2 without that confirmation

---

## Step 2 — New endpoint: `POST /api/library/:id/assign-coach`

Once findings are confirmed, add the endpoint to `canonniers-library-worker`. The patch below assumes `assign-player` reads the library R2 object, writes a copy under a new key, and upserts into `players.photo_url`. **If `assign-player` works differently, mirror its exact pattern instead of the template below.**

### Template patch — place alongside the existing `assign-player` handler

```javascript
// ── POST /api/library/:id/assign-coach
// Mirrors /assign-player: reads the library file from R2, writes a copy under a
// new coach-photo key, upserts coach_photos row, returns the public URL.
// Library copy is left intact.
if (assignCoachMatch = path.match(/^\/api\/library\/(\d+)\/assign-coach$/)) {
  // [AUTH] — same auth check as /assign-player (CF Access cookie or whatever pattern)

  const libraryId = parseInt(assignCoachMatch[1], 10);

  let body;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON', 400); }

  const slug = (body.slug || '').trim();

  // SLUG VALIDATION — use whichever option Jay confirmed in pre-flight:
  // Option (a) — hardcoded allowlist
  const VALID_COACH_SLUGS = new Set([
    'dave-dufour','mathieu-fontaine','jean-christophe-masson','vincent-leveille',
    'jonathan-landry','jean-pierre-chamberland','mathieu-vachon','loic-masse',
    'mathieu-deschenes','arthur-perrois','laurent-savard','francis-verge',
  ]);
  if (!VALID_COACH_SLUGS.has(slug)) {
    return jsonError('Invalid coach slug', 400);
  }
  // Option (b) — DB lookup (use this INSTEAD of the set above if library worker
  // has the canonniers-db binding):
  // const coach = await env.DB.prepare('SELECT slug FROM coaches WHERE slug = ?').bind(slug).first();
  // if (!coach) return jsonError('Invalid coach slug', 400);

  // 1) Look up the library row to get its R2 key + filename + mime
  const libRow = await env.DB.prepare(
    'SELECT r2_key, filename, mime_type FROM library_photos WHERE id = ?'   // adjust table/cols to match library schema
  ).bind(libraryId).first();
  if (!libRow) return jsonError('Library photo not found', 404);

  // 2) Read the original library object from R2
  const libObj = await env.BUCKET.get(libRow.r2_key);
  if (!libObj) return jsonError('Library file missing in R2', 500);

  // 3) Pick a coach-photo R2 key + read existing coach_photos.r2_key for cleanup
  const ext = (libRow.mime_type === 'image/png') ? 'png'
            : (libRow.mime_type === 'image/webp') ? 'webp'
            : 'jpg';
  const newKey = `coach-${slug}-${Date.now()}.${ext}`;

  const existing = await env.DB.prepare(
    'SELECT r2_key FROM coach_photos WHERE slug = ?'
  ).bind(slug).first();

  // 4) Write the copy under the new key
  await env.BUCKET.put(newKey, libObj.body, {
    httpMetadata: { contentType: libRow.mime_type || 'image/jpeg' }
  });

  // 5) Upsert coach_photos
  const photoUrl = `/api/photos/${newKey}`;
  await env.DB.prepare(`
    INSERT INTO coach_photos (slug, photo_url, r2_key, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      photo_url  = excluded.photo_url,
      r2_key     = excluded.r2_key,
      created_at = excluded.created_at
  `).bind(slug, photoUrl, newKey).run();

  // 6) Best-effort cleanup of the previous coach-photo R2 object (fail-open)
  if (existing?.r2_key && existing.r2_key !== newKey) {
    try { await env.BUCKET.delete(existing.r2_key); }
    catch (e) { console.error(`coach R2 cleanup failed slug=${slug} key=${existing.r2_key}: ${e.message}`); }
  }

  return new Response(JSON.stringify({ ok: true, slug, url: photoUrl }), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders }
  });
}
```

### Notes on the template

- **`jsonError(msg, status)`** — placeholder for whatever error helper the library worker actually uses. Match existing style.
- **`library_photos` table name + columns** — adjust to the library's actual schema (Claude Code will know from step 1).
- **R2 bucket binding** — the template assumes the library worker has access to the same R2 bucket the roster worker writes coach photos to (`/api/photos/...` is served by the roster worker). If the library worker uses a different bucket, two options: (1) the copy happens in-bucket on whichever bucket serves coach photos, requiring the library worker to also bind to it; (2) the library worker stays in its own bucket and the roster worker proxies the read. **Pre-flight step 1 will reveal which scenario we're in.**
- **EXIF stripping** — `assign-player` for roster doesn't seem to re-strip EXIF (library files were already stripped on library upload, presumably). Mirror that. Coach photos uploaded via Path B still go through the roster worker's EXIF strip via canvas re-encode on the client.

### Deploy

```powershell
cd <canonniers-library-worker dir>
wrangler deploy
```

Note version ID for rollback.

---

## Step 3 — Patch `admin-coaches.html` to add Path A

This is additive — the existing device-upload flow (Path B) stays intact. We add the tab UI and the library picker modal.

### 3a. Add CSS for path tabs + library picker

Insert into the `<style>` block in `admin-coaches.html` (place near the other form styles):

```css
/* Photo path tabs */
.photo-path-tabs {
  display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap;
}
.path-tab {
  flex:1; min-width:140px; padding:10px 14px;
  background:rgba(6,16,42,0.4); border:1px solid var(--border);
  color:var(--text-mid); font-family:'Barlow Condensed',sans-serif;
  font-size:12px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
  border-radius:4px; cursor:pointer; transition:all 0.18s;
  display:flex; align-items:center; justify-content:center; gap:8px;
}
.path-tab.active { background:rgba(106,176,212,0.15); color:#fff; border-color:var(--sky); }
.path-tab:hover:not(.active) { border-color:var(--border-hi); color:var(--sky-light); }
.tab-badge {
  background:var(--sky); color:var(--navy); padding:1px 6px; border-radius:3px;
  font-size:9px; letter-spacing:0.05em;
}

/* Library picker modal */
.lib-picker-overlay {
  position:fixed; inset:0; background:rgba(6,16,42,0.85); backdrop-filter:blur(4px);
  z-index:1000; display:none; align-items:center; justify-content:center; padding:20px;
}
.lib-picker-overlay.active { display:flex; }
.lib-picker-box {
  width:100%; max-width:900px; max-height:90vh;
  background:var(--surface-2); border:1px solid var(--border-hi);
  border-radius:8px; display:flex; flex-direction:column; overflow:hidden;
}
.lib-picker-header { padding:18px 20px; border-bottom:1px solid var(--border); }
.lib-picker-header h2 {
  font-family:'Barlow Condensed',sans-serif; font-size:18px; font-weight:800;
  text-transform:uppercase; color:#fff; letter-spacing:0.02em; margin-bottom:12px;
}
.lib-picker-tabs { display:flex; gap:6px; flex-wrap:wrap; }
.lib-picker-tab {
  background:rgba(6,16,42,0.4); border:1px solid var(--border); color:var(--text-mid);
  font-family:'Barlow Condensed',sans-serif; font-size:11px; font-weight:700;
  letter-spacing:0.06em; padding:6px 12px; border-radius:3px; cursor:pointer;
}
.lib-picker-tab.active { background:var(--sky); color:var(--navy); border-color:var(--sky); }

.lib-reauth { display:none; padding:14px 20px; background:rgba(217,119,6,0.15);
  color:#fbbf24; font-size:13px; border-bottom:1px solid var(--border); }
.lib-reauth a { color:var(--sky-light); text-decoration:underline; }

.lib-picker-grid-wrap { flex:1; overflow-y:auto; padding:14px 20px; }
.lib-picker-grid {
  display:grid; grid-template-columns:repeat(auto-fill, minmax(120px, 1fr));
  gap:10px;
}
.lib-picker-tile {
  cursor:pointer; border:2px solid transparent; border-radius:4px; overflow:hidden;
  background:rgba(6,16,42,0.4); transition:all 0.15s; display:flex; flex-direction:column;
}
.lib-picker-tile:hover { border-color:var(--border-hi); }
.lib-picker-tile.selected { border-color:var(--sky); box-shadow:0 0 0 3px var(--glow); }
.lib-picker-thumb-wrap { position:relative; padding-top:100%; }
.lib-picker-thumb-wrap img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
.lib-picker-thumb-wrap img.loading { opacity:0; }
.lib-picker-thumb-placeholder {
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  color:var(--text-dim);
}
.lib-picker-tile-name {
  font-size:10px; color:var(--text-mid); padding:4px 6px;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  font-family:'Barlow Condensed',sans-serif;
}

.lib-picker-footer {
  padding:14px 20px; border-top:1px solid var(--border);
  display:flex; align-items:center; gap:12px; flex-wrap:wrap;
}
.lib-picker-preview-img {
  width:40px; height:40px; object-fit:cover; border-radius:3px;
  border:1px solid var(--border-hi); display:none;
}
.lib-picker-selected-name { flex:1; font-size:12px; color:var(--sky-light); min-width:0; word-break:break-word; }
.btn-cancel {
  background:none; border:1px solid var(--border-hi); color:var(--text-mid);
  font-family:'Barlow Condensed',sans-serif; font-size:12px; font-weight:700;
  text-transform:uppercase; letter-spacing:0.08em;
  padding:8px 14px; border-radius:4px; cursor:pointer;
}
.btn-cancel:hover { color:#fff; background:rgba(106,176,212,0.1); }

.lib-spinner {
  width:24px; height:24px; border:2.5px solid rgba(168,212,236,0.2);
  border-top-color:var(--sky); border-radius:50%; animation:spin 0.8s linear infinite;
}
```

### 3b. Replace the photo block in the IDENTITY card

Find this in the existing admin-coaches.html (inside the IDENTITY card, the `.photo-row` block):

```html
<div class="photo-row">
  <div class="photo-preview" id="photo-preview"></div>
  <div class="photo-controls">
    <label class="field-label" style="margin-bottom:0;">
      <span class="fr-text">Photo (JPEG, PNG, WEBP — max 5 Mo)</span>
      <span class="en-text">Photo (JPEG, PNG, WEBP — max 5 MB)</span>
    </label>
    <input type="file" id="c-photo-file" accept="image/jpeg,image/png,image/webp" class="field-input" style="padding:7px;">
    <p class="photo-hint">
      <span class="fr-text">Les métadonnées EXIF sont retirées automatiquement.</span>
      <span class="en-text">EXIF metadata is automatically stripped.</span>
    </p>
  </div>
</div>
```

Replace with:

```html
<div class="photo-row">
  <div class="photo-preview" id="photo-preview"></div>
  <div class="photo-controls">
    <label class="field-label" style="margin-bottom:0;">Photo</label>

    <div class="photo-path-tabs">
      <button type="button" class="path-tab active" id="tab-path-a" onclick="switchPhotoPath('A')">
        <span class="fr-text">Bibliothèque</span><span class="en-text">Library</span>
        <span class="tab-badge">Reco</span>
      </button>
      <button type="button" class="path-tab" id="tab-path-b" onclick="switchPhotoPath('B')">
        <span class="fr-text">Appareil</span><span class="en-text">Device</span>
      </button>
    </div>

    <!-- Path A: library picker -->
    <div id="photo-path-a">
      <button type="button" class="btn-secondary" onclick="openLibraryPicker()" style="width:100%;">
        <span class="fr-text">Choisir depuis la bibliothèque…</span>
        <span class="en-text">Choose from library…</span>
      </button>
      <div id="path-a-status" style="margin-top:8px; font-size:12px; color:var(--text-dim);"></div>
    </div>

    <!-- Path B: device upload -->
    <div id="photo-path-b" style="display:none;">
      <input type="file" id="c-photo-file" accept="image/jpeg,image/png,image/webp" class="field-input" style="padding:7px;">
      <p class="photo-hint">
        <span class="fr-text">JPEG, PNG ou WEBP — max 5 Mo. EXIF retiré automatiquement.</span>
        <span class="en-text">JPEG, PNG or WEBP — max 5 MB. EXIF auto-stripped.</span>
      </p>
    </div>
  </div>
</div>
```

### 3c. Add the library picker modal markup

Place just before the closing `</body>` tag (above `<div id="toast" class="toast"></div>` is fine):

```html
<!-- Library picker modal -->
<div class="lib-picker-overlay" id="lib-picker-modal">
  <div class="lib-picker-box">

    <div class="lib-picker-header">
      <h2>
        <span class="fr-text">Choisir depuis la bibliothèque</span>
        <span class="en-text">Choose from library</span>
      </h2>
      <div class="lib-picker-tabs">
        <button class="lib-picker-tab active" data-filter="all" onclick="switchPickerTab(this)">
          <span class="fr-text">Toutes</span><span class="en-text">All</span>
        </button>
        <button class="lib-picker-tab" data-filter="unsorted" onclick="switchPickerTab(this)">
          <span class="fr-text">Non triées</span><span class="en-text">Unsorted</span>
        </button>
        <button class="lib-picker-tab" data-filter="u15" onclick="switchPickerTab(this)">15U</button>
        <button class="lib-picker-tab" data-filter="u17d1" onclick="switchPickerTab(this)">17U D1</button>
        <button class="lib-picker-tab" data-filter="u17d2" onclick="switchPickerTab(this)">17U D2</button>
      </div>
    </div>

    <div class="lib-reauth" id="lib-reauth">
      <strong>
        <span class="fr-text">Session bibliothèque expirée.</span>
        <span class="en-text">Library session expired.</span>
      </strong>
      <span class="fr-text">
        Ouvrez <a href="https://canonniers-library-worker.chisholm2000.workers.dev/" target="_blank">ce lien</a>
        pour vous reconnecter, puis <a href="#" onclick="location.reload()">rechargez la page</a>.
      </span>
      <span class="en-text">
        Open <a href="https://canonniers-library-worker.chisholm2000.workers.dev/" target="_blank">this link</a>
        to re-authenticate, then <a href="#" onclick="location.reload()">reload the page</a>.
      </span>
    </div>

    <div class="lib-picker-grid-wrap">
      <div class="lib-picker-grid" id="lib-picker-grid">
        <div style="grid-column:1/-1;text-align:center;padding:40px 0;">
          <div class="lib-spinner" style="margin:auto;"></div>
        </div>
      </div>
    </div>

    <div class="lib-picker-footer">
      <img class="lib-picker-preview-img" id="lib-picker-preview" src="" alt="">
      <span class="lib-picker-selected-name" id="lib-picker-selected-name">
        <span style="color:var(--text-dim);">
          <span class="fr-text">Aucune photo sélectionnée</span>
          <span class="en-text">No photo selected</span>
        </span>
      </span>
      <button type="button" class="btn-cancel" onclick="closeLibraryPicker()">
        <span class="fr-text">Annuler</span><span class="en-text">Cancel</span>
      </button>
      <button type="button" class="btn-primary" id="btn-confirm-pick" onclick="confirmLibraryPick()" disabled>
        <span class="fr-text">Utiliser cette photo</span>
        <span class="en-text">Use this photo</span>
      </button>
    </div>

  </div>
</div>
```

### 3d. Add the JS for path switching + library picker

Place inside the existing `<script>` block in admin-coaches.html, before the `init()` call at the bottom:

```javascript
const LIBRARY_URL = 'https://canonniers-library-worker.chisholm2000.workers.dev';

let currentPhotoPath = 'A';

function libHeaders(extra) {
  // Library worker uses CF Access cookie auth via credentials:include.
  // No bearer needed for library reads from a browser session.
  return { ...(extra || {}) };
}

function switchPhotoPath(path) {
  currentPhotoPath = path;
  document.getElementById('tab-path-a').classList.toggle('active', path === 'A');
  document.getElementById('tab-path-b').classList.toggle('active', path === 'B');
  document.getElementById('photo-path-a').style.display = path === 'A' ? 'block' : 'none';
  document.getElementById('photo-path-b').style.display = path === 'B' ? 'block' : 'none';
  if (path === 'A') {
    const fi = document.getElementById('c-photo-file');
    if (fi) fi.value = '';
  }
}

// ── LIBRARY PICKER ────────────────────────────────────────────────────
let pickerSelectedId   = null;
let pickerSelectedName = null;
let pickerThumbURLs    = new Map();
let pickerObserver     = null;

function openLibraryPicker() {
  if (!currentSlug) {
    showToast('Sélectionnez un entraîneur d\'abord / Select a coach first');
    return;
  }
  pickerSelectedId   = null;
  pickerSelectedName = null;
  document.getElementById('lib-picker-preview').style.display = 'none';
  document.getElementById('lib-picker-selected-name').innerHTML =
    '<span style="color:var(--text-dim);"><span class="fr-text">Aucune photo sélectionnée</span><span class="en-text">No photo selected</span></span>';
  document.getElementById('btn-confirm-pick').disabled = true;
  document.querySelectorAll('.lib-picker-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
  document.getElementById('lib-picker-modal').classList.add('active');
  loadPickerPhotos('all');
}

function closeLibraryPicker() {
  document.getElementById('lib-picker-modal').classList.remove('active');
  if (pickerObserver) { pickerObserver.disconnect(); pickerObserver = null; }
  pickerThumbURLs.forEach(u => URL.revokeObjectURL(u));
  pickerThumbURLs.clear();
}

function switchPickerTab(btn) {
  document.querySelectorAll('.lib-picker-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  loadPickerPhotos(btn.dataset.filter);
}

async function loadPickerPhotos(filter) {
  pickerSelectedId = null;
  document.getElementById('btn-confirm-pick').disabled = true;
  document.getElementById('lib-picker-grid').innerHTML =
    '<div style="grid-column:1/-1;text-align:center;padding:40px 0;"><div class="lib-spinner" style="margin:auto;"></div></div>';

  try {
    const res = await fetch(`${LIBRARY_URL}/api/library?filter=${filter}`, {
      headers: libHeaders(),
      credentials: 'include'
    });
    if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
      document.getElementById('lib-reauth').style.display = 'block';
      document.getElementById('lib-picker-grid').innerHTML = '';
      return;
    }
    const data = await res.json();
    renderPickerGrid(data.photos || []);
  } catch (e) {
    document.getElementById('lib-picker-grid').innerHTML =
      '<div style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-dim);font-size:13px;">Erreur de chargement / Load error</div>';
  }
}

function renderPickerGrid(photos) {
  if (pickerObserver) pickerObserver.disconnect();
  pickerThumbURLs.forEach(u => URL.revokeObjectURL(u));
  pickerThumbURLs.clear();

  pickerObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      pickerObserver.unobserve(img);
      const id = img.dataset.id;
      if (pickerThumbURLs.has(id)) { applyPickerThumb(img, pickerThumbURLs.get(id)); continue; }
      fetch(`${LIBRARY_URL}/api/library/file/${id}?thumb=1`, {
        headers: libHeaders(),
        credentials: 'include'
      })
        .then(r => r.ok ? r.blob() : Promise.reject())
        .then(blob => {
          const url = URL.createObjectURL(blob);
          pickerThumbURLs.set(id, url);
          applyPickerThumb(img, url);
        })
        .catch(() => {
          const ph = img.closest('.lib-picker-thumb-wrap')?.querySelector('.lib-picker-thumb-placeholder');
          if (ph) ph.textContent = '×';
        });
    }
  }, { rootMargin: '150px' });

  const grid = document.getElementById('lib-picker-grid');
  grid.innerHTML = '';

  if (!photos.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-dim);font-size:13px;"><span class="fr-text">Aucune photo.</span><span class="en-text">No photos.</span></div>';
    return;
  }

  for (const p of photos) {
    const tile = document.createElement('div');
    tile.className = 'lib-picker-tile';
    tile.dataset.id       = p.id;
    tile.dataset.filename = p.filename;
    tile.innerHTML =
      '<div class="lib-picker-thumb-wrap">' +
        `<img class="loading" data-id="${p.id}" alt="${escapeHtml(p.filename)}">` +
        '<div class="lib-picker-thumb-placeholder"><div class="lib-spinner" style="width:14px;height:14px;border-width:1.5px;"></div></div>' +
      '</div>' +
      `<div class="lib-picker-tile-name" title="${escapeHtml(p.filename)}">${escapeHtml(p.filename)}</div>`;
    tile.addEventListener('click', () => selectPickerTile(tile, p.id, p.filename));
    grid.appendChild(tile);
    pickerObserver.observe(tile.querySelector('img'));
  }
}

function applyPickerThumb(img, url) {
  img.onload = () => {
    img.classList.remove('loading');
    const ph = img.closest('.lib-picker-thumb-wrap')?.querySelector('.lib-picker-thumb-placeholder');
    if (ph) ph.style.display = 'none';
  };
  img.src = url;
}

function selectPickerTile(tile, id, filename) {
  document.querySelectorAll('.lib-picker-tile').forEach(t => t.classList.remove('selected'));
  tile.classList.add('selected');
  pickerSelectedId   = id;
  pickerSelectedName = filename;
  document.getElementById('lib-picker-selected-name').textContent = filename;
  document.getElementById('btn-confirm-pick').disabled = false;

  const previewImg = document.getElementById('lib-picker-preview');
  const thumbUrl   = pickerThumbURLs.get(String(id));
  if (thumbUrl) { previewImg.src = thumbUrl; previewImg.style.display = 'block'; }
}

async function confirmLibraryPick() {
  if (!pickerSelectedId || !currentSlug) return;

  const btn = document.getElementById('btn-confirm-pick');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    const res = await fetch(`${LIBRARY_URL}/api/library/${pickerSelectedId}/assign-coach`, {
      method: 'POST',
      headers: libHeaders({ 'Content-Type': 'application/json' }),
      credentials: 'include',
      body: JSON.stringify({ slug: currentSlug }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    closeLibraryPicker();

    // Update preview + local photo map
    const photoUrl = data.url && data.url.startsWith('http') ? data.url : `${API_URL}${data.url}`;
    coachPhotoMap[currentSlug] = photoUrl;

    // Refresh main preview
    const c = coachesCache.find(x => x.slug === currentSlug);
    if (c) renderPhotoPreview(c);

    const statusEl = document.getElementById('path-a-status');
    statusEl.style.color = '#86efac';
    statusEl.textContent = '✓ ' + pickerSelectedName;
    showToast('Photo assignée depuis la bibliothèque / Photo assigned from library');
  } catch (e) {
    showToast('Erreur / Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="fr-text">Utiliser cette photo</span><span class="en-text">Use this photo</span>';
  }
}
```

### 3e. Update `saveCoach()` to skip the photo upload step when Path A was used

Find the existing `saveCoach()` function. The photo-upload section starts with:

```javascript
const photoFile = document.getElementById('c-photo-file').files[0];
if (photoFile) {
```

Change the guard to also check we're on Path B:

```javascript
const photoFile = currentPhotoPath === 'B'
  ? document.getElementById('c-photo-file').files[0]
  : null;
if (photoFile) {
```

This prevents the device-upload step from running when the user picked from the library (Path A handles the photo assignment immediately when "Use this photo" is clicked, not on save).

### 3f. Reset Path A status when switching coaches

Find `populateForm()`. After the existing line `document.getElementById('c-photo-file').value = '';`, add:

```javascript
const pathAStatus = document.getElementById('path-a-status');
if (pathAStatus) pathAStatus.textContent = '';
switchPhotoPath('A');  // default new selection back to library tab
```

---

## Deploy

```powershell
git add admin-coaches.html
git commit -m "admin-coaches: add Path A library picker (directive #4)

- New tabs: Library (default) / Device
- Library picker modal mirrors roster admin pattern
- Photo assignment via library worker assign-coach endpoint
- Path B (device upload) preserved as fallback
"
git push
```

Pages auto-deploys.

---

## Post-deploy verification

Single end-to-end test:

1. Open `/admin-coaches.html` past CF Access.
2. Pick **Dave Dufour**.
3. Default tab should be "Library / Bibliothèque". Click "Choose from library…".
4. Modal opens. After 1-2s, library thumbs appear.
5. Click any photo. "Use this photo" button enables.
6. Click "Use this photo". Modal closes. Status under Path A button shows "✓ <filename>". Photo preview in the form updates.
7. Open `/coach.html?id=dave-dufour` in new tab. Photo shows.
8. Reload admin, pick Dave Dufour again. Photo preview shows the library-assigned photo (proves it persisted to D1).

**Path B regression check:** Pick Jonathan Landry. Switch to "Device" tab. Choose a small JPG from your phone. Hit Save. Confirm public page shows it.

**Failure modes worth distinguishing:**
- Modal opens but never loads thumbs → library worker auth issue (CF Access cookie not present for that domain). Reauth banner should appear.
- "Use this photo" returns 400/404/500 → assign-coach endpoint issue. Check worker logs: `wrangler tail canonniers-library-worker`.
- Public page doesn't show new photo → coach_photos table didn't update OR `/api/photos/<key>` isn't serving the new key. Curl the URL directly.

---

## Open questions for Claude Code

1. **Pre-flight findings:** Report the four bullets in pre-flight step 1 BEFORE writing any patch.
2. **Slug validation:** Option (a) hardcoded set or Option (b) DB lookup? Based on whether library worker has canonniers-db binding.
3. **`assign-player` shape:** Does the template patch in step 2 actually match? If the real `assign-player` is meaningfully different, mirror it exactly.

---

## How to break this (Attack Vectors)

- **Assigning to arbitrary slugs** — slug validation (allowlist or DB lookup) blocks unknown slugs.
- **Stale R2 cleanup race** — if two assign-coach calls fire back-to-back for the same slug, the second's cleanup of `existing.r2_key` might delete the first's new key. Window is small but real. Acceptable; coach uploads are not high-concurrency.
- **Library worker auth bypass** — CF Access cookie required; same posture as the existing library admin page.
- **Library file ID brute force** — `/api/library/:id` already enforces auth; non-existent IDs return 404.
- **Path A status spoofing** — the "✓ filename" badge is cosmetic; the actual photo state is determined by what `/api/coach-photos` returns on next page load.

---

## Rollback

```powershell
# Library worker
cd <canonniers-library-worker dir>
wrangler deployments list
wrangler rollback <previous-version-id>

# HTML
git revert HEAD
git push
```

Coach data and existing coach_photos rows are unaffected by rollback. Photos already assigned via Path A stay in the coach-photo R2 bucket; they're just unreachable via the Path A UI until redeploy.

---

**This completes the coach-editing workflow.** Path A is the default tab; coaches typically pick from the library; Path B is the fallback for ad-hoc uploads.
