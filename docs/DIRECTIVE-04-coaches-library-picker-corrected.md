# Directive #4 — CORRECTED PATCH (post pre-flight)

Pre-flight findings confirm 8 deltas from the template. Here is the corrected, ready-to-apply patch.

**Sequence:**
1. Add `/api/library/:id/assign-coach` to library worker → deploy
2. Patch admin-coaches.html (HTML + JS + saveCoach + populateForm) → push
3. Single browser smoke test

---

## Step 1 — Library worker: add `assign-coach` endpoint

**File:** `repo-working/workers/library/src/index.js`

Place this handler alongside the existing `assign-player` handler (matching its structure exactly — same auth pattern, same `json(...)` helper, same `corsHeaders(origin)`, same `env.DB` / `env.LIBRARY` / `env.GALLERY` bindings).

```javascript
// ── POST /api/library/:id/assign-coach
// Copies a library file from LIBRARY (private) to GALLERY (public, same bucket
// used by roster worker for coach photos). Upserts coach_photos. Leaves library
// copy intact. Mirrors assign-player except:
//   - Slug-keyed instead of id-keyed
//   - Timestamped destination key (coach photos can be replaced) → previous
//     coach_photos.r2_key must be cleaned up (fail-open)
//   - Slug validated against coaches table (Option b)
const assignCoachMatch = path.match(/^\/api\/library\/(\d+)\/assign-coach$/);
if (assignCoachMatch && request.method === 'POST') {
  // Auth — same pattern as assign-player
  const identity = await getCallerIdentity(request, env);
  if (!identity || identity.role !== 'admin') {
    return json({ error: 'Unauthorized' }, 401, origin);
  }

  const libraryId = parseInt(assignCoachMatch[1], 10);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const slug = (body.slug || '').trim();
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) {
    return json({ error: 'Invalid slug format' }, 400, origin);
  }

  // Validate slug against coaches table (single source of truth)
  const coach = await env.DB.prepare(
    'SELECT slug FROM coaches WHERE slug = ?'
  ).bind(slug).first();
  if (!coach) {
    return json({ error: 'Coach not found' }, 400, origin);
  }

  // 1) Look up library row
  const photo = await env.DB.prepare(
    'SELECT id, r2_key, mime_type FROM photo_library WHERE id = ?'
  ).bind(libraryId).first();
  if (!photo) {
    return json({ error: 'Library photo not found' }, 404, origin);
  }

  // 2) Read source bytes from private LIBRARY bucket
  const srcObj = await env.LIBRARY.get(photo.r2_key);
  if (!srcObj) {
    return json({ error: 'Library file missing in R2' }, 500, origin);
  }

  // 3) Build destination key (timestamped, matches roster worker convention)
  const mime = photo.mime_type || 'image/jpeg';
  const ext  = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const newKey = `coach-${slug}-${Date.now()}.${ext}`;
  const publicUrl = `/api/photos/${newKey}`;

  // 4) Read existing coach_photos.r2_key for cleanup AFTER write succeeds
  const existing = await env.DB.prepare(
    'SELECT r2_key FROM coach_photos WHERE slug = ?'
  ).bind(slug).first();

  // 5) Write copy to public GALLERY bucket
  await env.GALLERY.put(newKey, srcObj.body, {
    httpMetadata: { contentType: mime }
  });

  // 6) Upsert coach_photos row
  await env.DB.prepare(`
    INSERT INTO coach_photos (slug, photo_url, r2_key, created_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      photo_url  = excluded.photo_url,
      r2_key     = excluded.r2_key,
      created_at = excluded.created_at
  `).bind(slug, publicUrl, newKey).run();

  // 7) Fail-open cleanup of previous coach photo R2 object
  if (existing?.r2_key && existing.r2_key !== newKey) {
    try {
      await env.GALLERY.delete(existing.r2_key);
    } catch (e) {
      console.error(`coach R2 cleanup failed slug=${slug} key=${existing.r2_key}: ${e.message}`);
    }
  }

  return json({ ok: true, slug, photo_url: publicUrl }, 200, origin);
}
```

**Deploy:**

```powershell
cd repo-working/workers/library
wrangler deploy
```

Note the version ID for rollback.

---

## Step 2 — admin-coaches.html patches

Four changes. Apply in order.

### 2a. Add CSS (unchanged from original directive — copy from directive #4 step 3a)

Insert the photo-path-tabs + lib-picker-* CSS into the `<style>` block. **No changes from the previous directive's CSS.** Paste the full CSS block from directive #4 step 3a as-is.

### 2b. Replace the photo block in the IDENTITY card (unchanged from original — copy from directive #4 step 3b)

Replace the existing `.photo-row` block in the IDENTITY card with the tabbed version from directive #4 step 3b. **No changes.**

### 2c. Add the library picker modal markup (unchanged from original — copy from directive #4 step 3c)

Add the `<div class="lib-picker-overlay" id="lib-picker-modal">...</div>` block before the closing `</body>`. **No changes.**

### 2d. JS — CORRECTED VERSION

This is the part that changes. Replace the JS block from directive #4 step 3d with this corrected version:

```javascript
const LIBRARY_URL   = 'https://canonniers-library-worker.chisholm2000.workers.dev';
const LIBRARY_TOKEN = '905f8ead3fa274c21fd8d81aec8ebfd766509b5d5602353f6a0cd5d09de0ee46';

let currentPhotoPath = 'A';

function libHeaders(extra) {
  return { 'Authorization': `Bearer ${LIBRARY_TOKEN}`, ...(extra || {}) };
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
      headers: libHeaders()
    });
    if (res.status === 401) {
      document.getElementById('lib-reauth').style.display = 'block';
      document.getElementById('lib-picker-grid').innerHTML = '';
      return;
    }
    if (!res.ok) {
      document.getElementById('lib-picker-grid').innerHTML =
        `<div style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-dim);font-size:13px;">HTTP ${res.status}</div>`;
      return;
    }
    const data = await res.json();
    renderPickerGrid(data.photos || []);
  } catch (e) {
    document.getElementById('lib-picker-grid').innerHTML =
      '<div style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-dim);font-size:13px;">Erreur réseau / Network error</div>';
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
        headers: libHeaders()
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
      body: JSON.stringify({ slug: currentSlug }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    closeLibraryPicker();

    // Update preview + local photo map
    // assign-coach returns { ok: true, slug, photo_url } — note: photo_url, not url
    const photoUrl = data.photo_url && data.photo_url.startsWith('http')
      ? data.photo_url
      : `${API_URL}${data.photo_url}`;
    coachPhotoMap[currentSlug] = photoUrl;

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

**Key changes from the previous JS draft:**
- `LIBRARY_TOKEN` constant added (exact value from `admin-roster.html`)
- `libHeaders()` returns `{ 'Authorization': 'Bearer ${LIBRARY_TOKEN}', ...extra }`
- All `credentials: 'include'` removed
- `confirmLibraryPick` reads `data.photo_url` (not `data.url`) to match the worker response

### 2e. saveCoach guard (unchanged from original — directive #4 step 3e)

Change the photoFile guard to:

```javascript
const photoFile = currentPhotoPath === 'B'
  ? document.getElementById('c-photo-file').files[0]
  : null;
if (photoFile) {
```

### 2f. populateForm reset (unchanged from original — directive #4 step 3f)

After `document.getElementById('c-photo-file').value = '';` in `populateForm`, add:

```javascript
const pathAStatus = document.getElementById('path-a-status');
if (pathAStatus) pathAStatus.textContent = '';
switchPhotoPath('A');
```

---

## Deploy

```powershell
git add admin-coaches.html
git commit -m "admin-coaches: add Path A library picker (directive #4)

- New tabs: Library (default) / Device
- Bearer-auth fetches to canonniers-library-worker
- New endpoint: POST /api/library/:id/assign-coach
  - Copies from LIBRARY → GALLERY bucket
  - Upserts coach_photos with timestamped key
  - Fail-open R2 cleanup of previous coach photo
  - Slug validated against coaches table
- Path B (device upload) preserved as fallback
"
git push
```

---

## Smoke test (one pass)

1. Open `/admin-coaches.html` past CF Access
2. Pick Dave Dufour. Default tab = Library. Click "Choose from library…"
3. Modal opens, thumbs load (proves bearer auth works)
4. Click any photo, click "Use this photo"
5. Modal closes, preview updates, status shows "✓ <filename>"
6. Open `/coach.html?id=dave-dufour` — photo shows
7. Reload admin, pick Dave Dufour — preview persists (proves D1 upsert worked)
8. Path B regression: pick Jonathan Landry, switch to Device tab, upload a JPG, hit Save, check public page

---

## Failure mode triage

| What you see | Likely cause | Where to look |
|---|---|---|
| Modal opens, thumbs never load | Library worker not deployed / bearer token mismatch | `wrangler tail canonniers-library-worker` |
| "Use this photo" → 401 | LIBRARY_TOKEN in HTML doesn't match worker secret | Worker secrets vs constant in HTML |
| "Use this photo" → 400 "Coach not found" | Slug isn't in `coaches` table | `wrangler d1 execute canonniers-db --remote --command "SELECT slug FROM coaches"` |
| "Use this photo" → 500 "Library file missing in R2" | `photo_library.r2_key` references a key not in LIBRARY bucket | Inspect that row, check R2 bucket directly |
| New photo doesn't show on public page | GALLERY write succeeded, coach_photos didn't update | `wrangler d1 execute canonniers-db --remote --command "SELECT * FROM coach_photos WHERE slug='dave-dufour'"` |

---

## Rollback

```powershell
# Library worker
cd repo-working/workers/library
wrangler deployments list
wrangler rollback <previous-version-id>

# HTML
git revert HEAD
git push
```

Coach data + existing coach_photos rows are unaffected. Photos already assigned via Path A stay in the GALLERY bucket; they're just unreachable via the UI until redeploy.

---

**Ready to apply.** Stop after deploy and report smoke test result.
