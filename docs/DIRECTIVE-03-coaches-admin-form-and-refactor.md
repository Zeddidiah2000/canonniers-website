# Directive #3 — Rebuild admin-coaches.html + Refactor coach.html

**Goal:** Replace `admin-coaches.html` with a full bio + photo editor matching admin-roster's visual style. Refactor `coach.html` to fetch from `/api/coaches/:slug` instead of reading the hardcoded `COACHES` const.

**Risk level:** Medium. Public-facing change to `coach.html`. Mitigation: refactor preserves identical rendering for empty data (the seeded state of all 12 coaches today), so visually nothing changes on day-one deploy.

**Verification approach:** Deploy, open `admin-coaches.html` in a browser past CF Access, edit Dave Dufour's bio + photo, confirm public `coach.html?id=dave-dufour` reflects changes. If that works end-to-end, all 11 other coaches work too — same code path.

**Rollback:** `git revert` the commit. Pages auto-redeploys to previous state. D1 data persists (seeded coaches table is unaffected by HTML rollback).

---

## Pre-flight verification

```powershell
# 1. Confirm worker endpoints from directive #2 are live
curl.exe https://canonniers-roster-worker.chisholm2000.workers.dev/api/coaches/dave-dufour
# Expected: JSON with Dave Dufour data, bio_fr='', playing_bg=[]

# 2. Confirm current admin-coaches.html exists and matches the in-repo version
# (sanity check we're patching the right file)
git status
# Expected: clean working tree
```

If endpoint test fails, STOP — directive #2 didn't land. If working tree isn't clean, commit/stash first.

---

## Step 1 — Replace `admin-coaches.html`

Replace the entire file with the version below. This is a full rewrite — the old file is ~470 lines of photo-only logic; the new file is ~750 lines covering photo + full bio form.

**Key design decisions:**
- Matches admin-roster's dark navy aesthetic (`--surface`, `--text-mid`, `--border` tokens, geometric background).
- Single-form layout: pick coach from dropdown → form auto-populates → edit → save.
- Photo upload: device only (Path B from roster). Reuses existing `POST /api/coach-photos` endpoint (handles EXIF strip + R2 upload + DB upsert server-side). No new worker code.
- Bio fields: textareas with 5000-char counter. Plaintext only — newlines become paragraphs on public render.
- Playing background: dynamic row builder. "+ Add row" button, "✕" per row to remove. Max 20 rows enforced both client- and server-side.
- Year fields: `<input type="number" min="1900" max="2099">` for native phone-keyboard.
- Bearer token: `canonniers2026` (matches what's actually in the worker — confirmed in directive #2 deltas).

**File content** — save as `admin-coaches.html` in repo root, replacing the existing file:

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>Coach Editor — Canonniers de Québec</title>
  <link rel="icon" type="image/png" href="/favicon/favicon-96x96.png" sizes="96x96" />
  <link rel="icon" type="image/svg+xml" href="/favicon/favicon.svg" />
  <link rel="shortcut icon" href="/favicon/favicon.ico" />
  <link rel="apple-touch-icon" sizes="180x180" href="/favicon/apple-touch-icon.png" />
  <link rel="manifest" href="/favicon/site.webmanifest" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
  <script>
    function setLang(lang) {
      document.body.className = 'lang-' + lang;
      document.documentElement.lang = lang;
      const btnFr = document.getElementById('btn-fr');
      const btnEn = document.getElementById('btn-en');
      if (btnFr) btnFr.classList.toggle('active', lang === 'fr');
      if (btnEn) btnEn.classList.toggle('active', lang === 'en');
      localStorage.setItem('lang', lang);
    }
  </script>
  <style>
    :root {
      --navy:#0d1f4e; --navy-mid:#152960; --sky:#6ab0d4; --sky-light:#a8d4ec;
      --white:#fff; --gray:#6b7280; --gray-light:#e5e7eb; --red:#b91c1c; --green:#15803d;
      --surface:#0a1733; --surface-2:#111f45; --surface-3:#172554;
      --border:rgba(106,176,212,0.15); --border-hi:rgba(106,176,212,0.35);
      --text-dim:rgba(168,212,236,0.5); --text-mid:rgba(168,212,236,0.75);
      --glow:rgba(0,212,255,0.18);
    }
    *,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }
    body {
      font-family:'Barlow',sans-serif; background:transparent; color:var(--sky-light);
      min-height:100vh; overflow-x:hidden;
    }
    #bg-canvas {
      position:fixed; inset:0; z-index:0; pointer-events:none; overflow:hidden;
      background:#06102a;
    }
    #bg-canvas::before {
      content:''; position:absolute; inset:0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 10%, rgba(26,58,140,0.75) 0%, transparent 60%),
        radial-gradient(ellipse 60% 50% at 80% 80%, rgba(13,31,78,0.85) 0%, transparent 55%),
        radial-gradient(ellipse 100% 80% at 50% 50%, #06102a 30%, #0a1733 100%);
    }
    #bg-canvas::after {
      content:''; position:absolute; inset:-20%; width:140%; height:140%; opacity:0.055;
      background-image:
        linear-gradient(rgba(106,176,212,1) 1px, transparent 1px),
        linear-gradient(90deg, rgba(106,176,212,1) 1px, transparent 1px);
      background-size:60px 60px; transform:rotate(-8deg) scale(1.3);
    }

    .en-text { display:none !important; }
    body.lang-en .fr-text { display:none !important; }
    body.lang-en .en-text { display:revert !important; }

    .lang-bar {
      position:relative; z-index:10; background:rgba(13,31,78,0.6);
      display:flex; justify-content:flex-end; align-items:center;
      padding:6px 20px; gap:6px; backdrop-filter:blur(8px);
    }
    .lang-btn {
      background:none; border:1.5px solid rgba(168,212,236,0.25);
      color:rgba(168,212,236,0.6); font-family:'Barlow Condensed',sans-serif;
      font-size:11px; font-weight:700; letter-spacing:0.1em;
      padding:3px 11px; border-radius:3px; cursor:pointer; transition:all 0.18s;
    }
    .lang-btn.active, .lang-btn:hover { background:var(--sky); border-color:var(--sky); color:var(--navy); }

    .topbar {
      position:relative; z-index:10; display:flex; justify-content:space-between;
      align-items:center; padding:14px 28px; background:rgba(10,23,51,0.7);
      border-bottom:1px solid var(--border); backdrop-filter:blur(8px);
    }
    .topbar-badge {
      background:rgba(106,176,212,0.15); color:var(--sky-light);
      font-family:'Barlow Condensed',sans-serif; font-size:11px; font-weight:700;
      letter-spacing:0.14em; text-transform:uppercase;
      padding:4px 10px; border-radius:3px; border:1px solid var(--border-hi);
      margin-right:12px;
    }
    .topbar-title {
      font-family:'Barlow Condensed',sans-serif; font-size:14px; font-weight:700;
      letter-spacing:0.08em; color:#fff;
    }
    .btn-ghost {
      background:none; border:1px solid var(--border-hi); color:var(--text-mid);
      font-family:'Barlow Condensed',sans-serif; font-weight:700;
      text-transform:uppercase; letter-spacing:0.08em;
      padding:8px 14px; border-radius:4px; cursor:pointer; text-decoration:none;
      display:inline-flex; align-items:center; gap:6px; transition:all 0.18s;
    }
    .btn-ghost:hover { background:rgba(106,176,212,0.1); color:#fff; border-color:var(--sky); }

    .container {
      position:relative; z-index:10; max-width:960px; margin:32px auto;
      padding:0 24px 64px;
    }

    h1.page-title {
      font-family:'Barlow Condensed',sans-serif; font-size:32px; font-weight:900;
      text-transform:uppercase; color:#fff; letter-spacing:0.02em;
    }
    .page-subtitle { color:var(--text-mid); font-size:14px; margin-top:6px; }

    .card {
      background:rgba(17,31,69,0.7); border:1px solid var(--border);
      border-radius:8px; padding:24px; margin-top:24px; backdrop-filter:blur(8px);
    }
    .card-title {
      font-family:'Barlow Condensed',sans-serif; font-size:13px; font-weight:800;
      letter-spacing:0.14em; text-transform:uppercase; color:var(--sky-light);
      display:flex; align-items:center; gap:10px; margin-bottom:18px;
    }
    .card-title::before {
      content:''; width:3px; height:16px; background:var(--sky); border-radius:2px;
    }

    .field-grid {
      display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));
      gap:14px; margin-bottom:14px;
    }
    .field-group { display:flex; flex-direction:column; }
    .field-label {
      font-family:'Barlow Condensed',sans-serif; font-size:11px; font-weight:700;
      letter-spacing:0.1em; text-transform:uppercase; color:var(--text-mid);
      margin-bottom:6px;
    }
    .field-input, .field-select, textarea.field-input {
      background:rgba(6,16,42,0.6); border:1px solid var(--border-hi);
      color:#fff; font-family:'Barlow',sans-serif; font-size:14px;
      padding:9px 12px; border-radius:4px; width:100%; transition:border-color 0.18s;
    }
    .field-input:focus, .field-select:focus, textarea.field-input:focus {
      outline:none; border-color:var(--sky); box-shadow:0 0 0 3px var(--glow);
    }
    textarea.field-input { resize:vertical; min-height:140px; font-family:'Barlow',sans-serif; line-height:1.55; }
    input[type="number"].field-input::-webkit-outer-spin-button,
    input[type="number"].field-input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
    input[type="number"].field-input { -moz-appearance:textfield; }

    .char-counter { font-size:11px; color:var(--text-dim); margin-top:4px; text-align:right; font-family:'Barlow Condensed',sans-serif; }
    .char-counter.warn { color:#fbbf24; }
    .char-counter.over { color:var(--red); }

    /* Photo block */
    .photo-row { display:flex; gap:18px; align-items:flex-start; margin-bottom:14px; flex-wrap:wrap; }
    .photo-preview {
      width:140px; height:140px; border-radius:6px; overflow:hidden;
      background:linear-gradient(160deg, var(--navy) 0%, var(--surface-3) 100%);
      display:flex; align-items:center; justify-content:center; flex-shrink:0;
      border:1px solid var(--border-hi);
    }
    .photo-preview img { width:100%; height:100%; object-fit:cover; }
    .initials-circle {
      width:64px; height:64px; border-radius:50%;
      background:rgba(106,176,212,0.2); border:2px solid rgba(168,212,236,0.4);
      display:flex; align-items:center; justify-content:center;
      font-family:'Barlow Condensed',sans-serif; font-size:22px; font-weight:900;
      color:var(--sky-light);
    }
    .photo-controls { flex:1; min-width:200px; display:flex; flex-direction:column; gap:8px; }
    .photo-hint { font-size:12px; color:var(--text-dim); line-height:1.5; }

    /* Playing background rows */
    .bg-rows { display:flex; flex-direction:column; gap:10px; margin-bottom:10px; }
    .bg-row-edit {
      display:grid; grid-template-columns:1fr 1fr 1fr 1fr auto; gap:8px;
      align-items:center; padding:10px; background:rgba(6,16,42,0.4);
      border:1px solid var(--border); border-radius:4px;
    }
    .bg-row-edit input { font-size:13px; padding:6px 9px; }
    .bg-row-remove {
      background:none; border:1px solid var(--border-hi); color:var(--red);
      width:32px; height:32px; border-radius:4px; cursor:pointer; font-size:14px;
      display:flex; align-items:center; justify-content:center; transition:all 0.18s;
    }
    .bg-row-remove:hover { background:rgba(185,28,28,0.15); border-color:var(--red); }
    .bg-row-empty { color:var(--text-dim); font-size:13px; font-style:italic; padding:10px; text-align:center; }
    @media (max-width: 640px) {
      .bg-row-edit { grid-template-columns:1fr 1fr; }
      .bg-row-remove { grid-column:1/-1; width:100%; height:28px; }
    }

    .btn-primary, .btn-secondary {
      font-family:'Barlow Condensed',sans-serif; font-weight:700;
      text-transform:uppercase; letter-spacing:0.08em;
      padding:10px 20px; border-radius:4px; cursor:pointer; border:none;
      transition:all 0.18s; font-size:13px;
    }
    .btn-primary { background:var(--sky); color:var(--navy); box-shadow:0 4px 12px rgba(106,176,212,0.3); }
    .btn-primary:hover:not(:disabled) { background:var(--sky-light); transform:translateY(-1px); }
    .btn-primary:disabled { opacity:0.4; cursor:not-allowed; transform:none; }
    .btn-secondary {
      background:rgba(106,176,212,0.1); color:var(--sky-light);
      border:1px solid var(--border-hi);
    }
    .btn-secondary:hover { background:rgba(106,176,212,0.2); }

    .form-actions { display:flex; gap:12px; align-items:center; margin-top:20px; flex-wrap:wrap; }

    /* Status banner */
    .status-banner {
      margin-top:14px; padding:10px 14px; border-radius:4px;
      font-size:13px; font-weight:600; display:none;
    }
    .status-banner.info { background:rgba(106,176,212,0.15); color:var(--sky-light); display:block; }
    .status-banner.success { background:rgba(21,128,61,0.18); color:#86efac; display:block; }
    .status-banner.error { background:rgba(185,28,28,0.18); color:#fca5a5; display:block; }

    /* Loading overlay (form disabled while loading) */
    .loading-overlay {
      position:absolute; inset:0; background:rgba(10,23,51,0.7); backdrop-filter:blur(2px);
      display:none; align-items:center; justify-content:center; z-index:5;
      border-radius:8px;
    }
    .loading-overlay.active { display:flex; }
    .spinner {
      width:32px; height:32px; border:3px solid rgba(168,212,236,0.2);
      border-top-color:var(--sky); border-radius:50%; animation:spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }

    .toast {
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:var(--surface-2); border:1px solid var(--border-hi);
      color:var(--sky-light); padding:12px 20px; border-radius:6px;
      font-size:14px; font-weight:600; z-index:100;
      opacity:0; transition:opacity 0.3s; pointer-events:none;
      box-shadow:0 8px 24px rgba(0,0,0,0.4);
    }
    .toast.show { opacity:1; }

    .empty-state {
      padding:32px 20px; text-align:center; color:var(--text-dim); font-size:14px;
    }
  </style>
</head>
<body>

<div id="bg-canvas"></div>

<div class="lang-bar">
  <button class="lang-btn" id="btn-fr" onclick="setLang('fr')">FR</button>
  <button class="lang-btn" id="btn-en" onclick="setLang('en')">EN</button>
</div>

<div class="topbar">
  <div>
    <span class="topbar-badge"><span class="fr-text">Éditeur d'entraîneurs</span><span class="en-text">Coach Editor</span></span>
    <span class="topbar-title">Canonniers de Québec</span>
  </div>
  <div style="display:flex; gap:10px;">
    <a href="/admin.html" class="btn-ghost" style="font-size:11px; padding:6px 14px;">
      <span class="fr-text">← Portail admin</span>
      <span class="en-text">← Admin Portal</span>
    </a>
  </div>
</div>

<div class="container">

  <h1 class="page-title">
    <span class="fr-text">Éditeur d'entraîneurs</span>
    <span class="en-text">Coach Editor</span>
  </h1>
  <p class="page-subtitle">
    <span class="fr-text">Modifiez la photo, la biographie et le parcours sportif des entraîneurs.</span>
    <span class="en-text">Edit coach photos, bios, and playing backgrounds.</span>
  </p>

  <!-- Coach selector -->
  <div class="card" style="position:relative;">
    <div class="card-title">
      <span class="fr-text">Sélectionner un entraîneur</span>
      <span class="en-text">Select a coach</span>
    </div>
    <select id="coach-select" class="field-select" onchange="onCoachSelected()">
      <option value="">—</option>
    </select>
  </div>

  <!-- Editor form (hidden until coach selected) -->
  <form id="coach-form" style="display:none;" onsubmit="saveCoach(event)">

    <!-- IDENTITY -->
    <div class="card" style="position:relative;">
      <div class="loading-overlay" id="loading-overlay"><div class="spinner"></div></div>
      <div class="card-title">
        <span class="fr-text">Identité</span>
        <span class="en-text">Identity</span>
      </div>

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

      <div class="field-grid">
        <div class="field-group">
          <label class="field-label">
            <span class="fr-text">Nom complet</span>
            <span class="en-text">Full name</span>
          </label>
          <input type="text" id="c-name" class="field-input" maxlength="100" required>
        </div>
        <div class="field-group">
          <label class="field-label">
            <span class="fr-text">N° de chandail</span>
            <span class="en-text">Jersey number</span>
          </label>
          <input type="text" id="c-number" class="field-input" maxlength="3" inputmode="numeric" pattern="\d*">
        </div>
        <div class="field-group">
          <label class="field-label">Équipe / Team</label>
          <select id="c-team" class="field-select">
            <option value="u15">15U AAA</option>
            <option value="u17d1">17U D1</option>
            <option value="u17d2">17U D2</option>
          </select>
        </div>
      </div>

      <div class="field-grid">
        <div class="field-group">
          <label class="field-label">
            <span class="fr-text">Rôle (français)</span>
            <span class="en-text">Role (French)</span>
          </label>
          <input type="text" id="c-role-fr" class="field-input" maxlength="60" placeholder="Entraîneur-chef">
        </div>
        <div class="field-group">
          <label class="field-label">
            <span class="fr-text">Rôle (anglais)</span>
            <span class="en-text">Role (English)</span>
          </label>
          <input type="text" id="c-role-en" class="field-input" maxlength="60" placeholder="Head Coach">
        </div>
        <div class="field-group">
          <label class="field-label">
            <span class="fr-text">Entraîneur depuis (année)</span>
            <span class="en-text">Coaching since (year)</span>
          </label>
          <input type="number" id="c-coaching-since" class="field-input" min="1900" max="2099" inputmode="numeric">
        </div>
        <div class="field-group">
          <label class="field-label">
            <span class="fr-text">Avec l'organisation depuis</span>
            <span class="en-text">With organization since</span>
          </label>
          <input type="number" id="c-with-org-since" class="field-input" min="1900" max="2099" inputmode="numeric">
        </div>
      </div>
    </div>

    <!-- BIOS -->
    <div class="card">
      <div class="card-title">
        <span class="fr-text">Biographie</span>
        <span class="en-text">Biography</span>
      </div>

      <div class="field-group" style="margin-bottom:16px;">
        <label class="field-label">
          <span class="fr-text">Biographie (français)</span>
          <span class="en-text">Biography (French)</span>
        </label>
        <textarea id="c-bio-fr" class="field-input" maxlength="5000" placeholder="Paragraphes séparés par une ligne vide..."></textarea>
        <div class="char-counter" id="bio-fr-counter">0 / 5000</div>
      </div>

      <div class="field-group">
        <label class="field-label">
          <span class="fr-text">Biographie (anglais)</span>
          <span class="en-text">Biography (English)</span>
        </label>
        <textarea id="c-bio-en" class="field-input" maxlength="5000" placeholder="Paragraphs separated by a blank line..."></textarea>
        <div class="char-counter" id="bio-en-counter">0 / 5000</div>
      </div>
    </div>

    <!-- PLAYING BACKGROUND -->
    <div class="card">
      <div class="card-title">
        <span class="fr-text">Parcours sportif</span>
        <span class="en-text">Playing background</span>
      </div>
      <p style="font-size:12px; color:var(--text-dim); margin-bottom:14px;">
        <span class="fr-text">Maximum 20 entrées. Tous les champs sont optionnels, mais le niveau (FR ou EN) doit être rempli.</span>
        <span class="en-text">Maximum 20 entries. All fields optional, but level (FR or EN) must be filled.</span>
      </p>
      <div class="bg-rows" id="bg-rows"></div>
      <button type="button" class="btn-secondary" onclick="addBgRow()" id="add-bg-btn">
        <span class="fr-text">+ Ajouter une entrée</span>
        <span class="en-text">+ Add an entry</span>
      </button>
    </div>

    <!-- ACTIONS -->
    <div class="card">
      <div class="form-actions">
        <button type="submit" class="btn-primary" id="save-btn">
          <span class="fr-text">Enregistrer</span>
          <span class="en-text">Save</span>
        </button>
        <button type="button" class="btn-secondary" onclick="reloadCurrentCoach()">
          <span class="fr-text">Annuler les modifications</span>
          <span class="en-text">Discard changes</span>
        </button>
        <a href="#" id="view-public-link" target="_blank" class="btn-ghost" style="font-size:11px;">
          <span class="fr-text">Voir la page publique →</span>
          <span class="en-text">View public page →</span>
        </a>
      </div>
      <div class="status-banner" id="status-banner"></div>
    </div>
  </form>

  <div id="empty-state" class="empty-state" style="display:none;">
    <span class="fr-text">Choisissez un entraîneur ci-dessus pour commencer.</span>
    <span class="en-text">Pick a coach above to get started.</span>
  </div>

</div>

<div id="toast" class="toast"></div>

<script>
const API_URL      = 'https://canonniers-roster-worker.chisholm2000.workers.dev';
const ROSTER_TOKEN = 'canonniers2026';

const TEAM_LABELS = { u15: '15U AAA', u17d1: '17U AAA D1', u17d2: '17U AAA D2' };

let coachesCache = [];     // last fetched list of all coaches
let coachPhotoMap = {};    // slug -> photo URL
let currentSlug = null;

function getInitials(name) {
  return (name || '').split(/\s+/).map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function setBanner(text, type) {
  const b = document.getElementById('status-banner');
  b.className = 'status-banner ' + (type || 'info');
  b.textContent = text;
}

function clearBanner() {
  const b = document.getElementById('status-banner');
  b.className = 'status-banner';
  b.textContent = '';
}

// ── INIT ────────────────────────────────────────────────────────────
async function init() {
  setLang(localStorage.getItem('lang') || 'fr');

  // Bind char counters
  ['c-bio-fr', 'c-bio-en'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => updateCounter(id));
  });

  await loadCoaches();
}

async function loadCoaches() {
  try {
    const [coachesRes, photosRes] = await Promise.all([
      fetch(`${API_URL}/api/coaches`),
      fetch(`${API_URL}/api/coach-photos`)
    ]);
    if (!coachesRes.ok) throw new Error(`Coaches list HTTP ${coachesRes.status}`);
    coachesCache = await coachesRes.json();
    coachPhotoMap = photosRes.ok ? await photosRes.json() : {};

    // Normalize photo URLs to absolute
    for (const [slug, url] of Object.entries(coachPhotoMap)) {
      coachPhotoMap[slug] = url && url.startsWith('http') ? url : `${API_URL}${url}`;
    }

    populateSelect();
  } catch (e) {
    showToast('Erreur de chargement / Load error: ' + e.message);
  }
}

function populateSelect() {
  const select = document.getElementById('coach-select');
  // Group coaches by team for the dropdown
  const byTeam = { u15: [], u17d1: [], u17d2: [] };
  for (const c of coachesCache) {
    if (byTeam[c.team]) byTeam[c.team].push(c);
  }

  let html = '<option value="">—</option>';
  for (const team of ['u15', 'u17d1', 'u17d2']) {
    if (byTeam[team].length === 0) continue;
    html += `<optgroup label="${escapeHtml(TEAM_LABELS[team])}">`;
    for (const c of byTeam[team]) {
      html += `<option value="${escapeHtml(c.slug)}">${escapeHtml(c.name)}</option>`;
    }
    html += '</optgroup>';
  }
  select.innerHTML = html;
}

// ── COACH SELECTED ──────────────────────────────────────────────────
function onCoachSelected() {
  const slug = document.getElementById('coach-select').value;
  currentSlug = slug || null;

  const form = document.getElementById('coach-form');
  const empty = document.getElementById('empty-state');

  if (!slug) {
    form.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  form.style.display = 'block';
  empty.style.display = 'none';
  populateForm(slug);
}

function populateForm(slug) {
  const c = coachesCache.find(x => x.slug === slug);
  if (!c) { showToast('Coach introuvable'); return; }

  document.getElementById('c-name').value = c.name || '';
  document.getElementById('c-number').value = c.number || '';
  document.getElementById('c-team').value = c.team || 'u15';
  document.getElementById('c-role-fr').value = c.role_fr || '';
  document.getElementById('c-role-en').value = c.role_en || '';
  document.getElementById('c-coaching-since').value = c.coaching_since || '';
  document.getElementById('c-with-org-since').value = c.with_org_since || '';
  document.getElementById('c-bio-fr').value = c.bio_fr || '';
  document.getElementById('c-bio-en').value = c.bio_en || '';

  renderBgRows(c.playing_bg || []);
  renderPhotoPreview(c);

  updateCounter('c-bio-fr');
  updateCounter('c-bio-en');

  document.getElementById('c-photo-file').value = '';
  clearBanner();

  // Public page link
  const link = document.getElementById('view-public-link');
  link.href = `/coach.html?id=${encodeURIComponent(slug)}`;
}

function renderPhotoPreview(c) {
  const box = document.getElementById('photo-preview');
  const photoUrl = coachPhotoMap[c.slug];
  if (photoUrl) {
    box.innerHTML = `<img src="${escapeHtml(photoUrl)}" alt="">`;
  } else {
    box.innerHTML = `<div class="initials-circle">${escapeHtml(getInitials(c.name))}</div>`;
  }
}

function updateCounter(textareaId) {
  const el = document.getElementById(textareaId);
  const counterId = textareaId.replace('c-bio-', 'bio-') + '-counter';
  const counter = document.getElementById(counterId);
  const len = el.value.length;
  counter.textContent = `${len} / 5000`;
  counter.classList.toggle('warn', len > 4500 && len <= 5000);
  counter.classList.toggle('over', len > 5000);
}

// ── PLAYING BACKGROUND ROWS ─────────────────────────────────────────
function renderBgRows(rows) {
  const box = document.getElementById('bg-rows');
  box.innerHTML = '';
  if (!rows || rows.length === 0) {
    box.innerHTML = `<div class="bg-row-empty"><span class="fr-text">Aucune entrée. Cliquez « Ajouter une entrée » ci-dessous.</span><span class="en-text">No entries. Click "Add an entry" below.</span></div>`;
  } else {
    rows.forEach(r => appendBgRow(r));
  }
  updateAddBtnState();
}

function appendBgRow(row) {
  // Remove the empty-state hint if present
  const empty = document.querySelector('#bg-rows .bg-row-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = 'bg-row-edit';
  div.innerHTML = `
    <input type="text" placeholder="Niveau (FR) / Level (FR)" class="field-input bg-level-fr" maxlength="100" value="${escapeHtml(row?.level_fr || '')}">
    <input type="text" placeholder="Level (EN)" class="field-input bg-level-en" maxlength="100" value="${escapeHtml(row?.level_en || '')}">
    <input type="text" placeholder="Lieu / Where" class="field-input bg-where" maxlength="100" value="${escapeHtml(row?.where || '')}">
    <input type="text" placeholder="Années / Years" class="field-input bg-years" maxlength="100" value="${escapeHtml(row?.years || '')}">
    <button type="button" class="bg-row-remove" onclick="removeBgRow(this)" title="Remove">✕</button>
  `;
  document.getElementById('bg-rows').appendChild(div);
  updateAddBtnState();
}

function addBgRow() {
  if (countBgRows() >= 20) return;
  appendBgRow({});
}

function removeBgRow(btn) {
  btn.closest('.bg-row-edit').remove();
  const box = document.getElementById('bg-rows');
  if (box.children.length === 0) {
    box.innerHTML = `<div class="bg-row-empty"><span class="fr-text">Aucune entrée.</span><span class="en-text">No entries.</span></div>`;
  }
  updateAddBtnState();
}

function countBgRows() {
  return document.querySelectorAll('#bg-rows .bg-row-edit').length;
}

function updateAddBtnState() {
  document.getElementById('add-bg-btn').disabled = countBgRows() >= 20;
}

function collectBgRows() {
  const rows = [];
  document.querySelectorAll('#bg-rows .bg-row-edit').forEach(row => {
    const entry = {
      level_fr: row.querySelector('.bg-level-fr').value.trim(),
      level_en: row.querySelector('.bg-level-en').value.trim(),
      where:    row.querySelector('.bg-where').value.trim(),
      years:    row.querySelector('.bg-years').value.trim(),
    };
    // Drop fully empty rows silently
    if (entry.level_fr || entry.level_en || entry.where || entry.years) {
      rows.push(entry);
    }
  });
  return rows;
}

// ── SAVE ────────────────────────────────────────────────────────────
async function saveCoach(e) {
  e.preventDefault();
  if (!currentSlug) return;

  const saveBtn = document.getElementById('save-btn');
  saveBtn.disabled = true;
  clearBanner();
  setBanner('Sauvegarde en cours… / Saving…', 'info');

  try {
    // Step 1 — upload photo if user selected one
    const photoFile = document.getElementById('c-photo-file').files[0];
    if (photoFile) {
      if (!['image/jpeg','image/png','image/webp'].includes(photoFile.type)) {
        throw new Error('Photo: format invalide (JPEG, PNG, WEBP only)');
      }
      if (photoFile.size > 5 * 1024 * 1024) {
        throw new Error('Photo: max 5 Mo');
      }
      const fd = new FormData();
      fd.append('slug', currentSlug);
      fd.append('file', photoFile, photoFile.name);
      const pRes = await fetch(`${API_URL}/api/coach-photos`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ROSTER_TOKEN}` },
        body: fd
      });
      const pData = await pRes.json().catch(() => ({}));
      if (!pRes.ok) throw new Error(`Photo: ${pData.error || 'HTTP ' + pRes.status}`);
      // Update local map
      coachPhotoMap[currentSlug] = pData.url && pData.url.startsWith('http') ? pData.url : `${API_URL}${pData.url}`;
    }

    // Step 2 — PUT bio fields
    const payload = {
      name:            document.getElementById('c-name').value.trim(),
      number:          document.getElementById('c-number').value.trim(),
      team:            document.getElementById('c-team').value,
      role_fr:         document.getElementById('c-role-fr').value.trim(),
      role_en:         document.getElementById('c-role-en').value.trim(),
      coaching_since:  document.getElementById('c-coaching-since').value.trim(),
      with_org_since:  document.getElementById('c-with-org-since').value.trim(),
      bio_fr:          document.getElementById('c-bio-fr').value,
      bio_en:          document.getElementById('c-bio-en').value,
      playing_bg:      collectBgRows(),
    };

    const res = await fetch(`${API_URL}/api/coaches/${encodeURIComponent(currentSlug)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ROSTER_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // Step 3 — refresh local cache from response
    const idx = coachesCache.findIndex(c => c.slug === currentSlug);
    if (idx >= 0) coachesCache[idx] = data;

    renderPhotoPreview(data);
    setBanner('Enregistré ✓ / Saved ✓', 'success');
    showToast('Mis à jour / Updated');
  } catch (err) {
    setBanner('Erreur / Error: ' + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

function reloadCurrentCoach() {
  if (!currentSlug) return;
  populateForm(currentSlug);
  setBanner('Modifications annulées / Changes discarded', 'info');
}

init();
</script>

</body>
</html>
```

---

## Step 2 — Refactor `coach.html`

This is a **surgical** change: the file already does most of what we need. Only the `init()` function changes — replace the lookup-from-COACHES-const pattern with an API fetch. Everything else (`renderCoach`, the styling, the placeholders, the photo merging) stays.

### Patch — replace the `init()` function in `coach.html`

Find the existing `init()` function (around line 612) and the `WORKER_URL` constant just before it. Replace this block:

```javascript
const WORKER_URL = 'https://canonniers-roster-worker.chisholm2000.workers.dev';

async function init() {
  const savedLang = localStorage.getItem('lang') || 'fr';
  setLang(savedLang);

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id || !COACHES[id]) {
    window.location.href = 'alignement.html';
    return;
  }

  const coach = Object.assign({}, COACHES[id]);

  // Fetch coach photos from the API and merge photo_url if available.
  // Any failure (network error, timeout, bad JSON) falls through to initials.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${WORKER_URL}/api/coach-photos`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const map = await res.json();
      if (map[id]) {
        const raw = map[id];
        coach.photo_url = raw.startsWith('http') ? raw : `${WORKER_URL}${raw}`;
      }
    }
  } catch (_) {
    // Network error or timeout — render with initials
  }

  renderCoach(coach);
}

init();
```

with this:

```javascript
const WORKER_URL = 'https://canonniers-roster-worker.chisholm2000.workers.dev';

async function init() {
  const savedLang = localStorage.getItem('lang') || 'fr';
  setLang(savedLang);

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (!id) {
    window.location.href = 'alignement.html';
    return;
  }

  // Fetch coach data from API. Fall back to hardcoded COACHES const if API fails
  // (back-compat safety net — remove once API has been live + stable for a while).
  let coach = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${WORKER_URL}/api/coaches/${encodeURIComponent(id)}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      coach = await res.json();
    } else if (res.status === 404) {
      // Unknown slug — redirect to roster
      window.location.href = 'alignement.html';
      return;
    }
  } catch (_) {
    // Network error — fall through to const fallback
  }

  // Fallback to hardcoded const if API didn't return data
  if (!coach) {
    if (!COACHES[id]) {
      window.location.href = 'alignement.html';
      return;
    }
    coach = Object.assign({}, COACHES[id]);
  }

  // Merge photo from /api/coach-photos (separate endpoint, photo data lives there)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${WORKER_URL}/api/coach-photos`, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const map = await res.json();
      if (map[id]) {
        const raw = map[id];
        coach.photo_url = raw.startsWith('http') ? raw : `${WORKER_URL}${raw}`;
      }
    }
  } catch (_) {
    // Photo fetch failed — render with initials
  }

  renderCoach(coach);
}

init();
```

**Why keep the `COACHES` const fallback?** Two reasons: (1) if the worker is temporarily down, the public site degrades gracefully instead of redirecting everyone to the roster; (2) lets you delete the const in a follow-up commit after a few days of stable API, without coupling that cleanup to this directive. The const can stay as-is until you remove it.

---

## Deploy

```powershell
git add admin-coaches.html coach.html
git commit -m "coaches: admin editor + public page fetches from API (directive #3)

- admin-coaches.html: full rebuild matching admin-roster aesthetic
- Photo upload (device only), name/number/role/team, bios w/ char counter,
  playing background dynamic rows (max 20)
- Reuses existing POST /api/coach-photos for photos
- PUT /api/coaches/:slug for bio data (added in directive #2)
- coach.html: init() now fetches from /api/coaches/:slug, falls back to
  hardcoded COACHES const on network error (safety net)
"
git push
```

Cloudflare Pages auto-deploys.

---

## Post-deploy verification

End-to-end smoke test in browser:

1. **Open `/admin-coaches.html`** (past CF Access). Dropdown shows all 12 coaches grouped by team.
2. **Pick Dave Dufour.** Form populates with: name=Dave Dufour, number=10, team=15U AAA, role_fr=Entraîneur-chef, role_en=Head Coach. Bios empty. Playing background shows "No entries." Photo shows DD initials.
3. **Edit:**
   - Bio FR: type "Test bio en français — accent test: é à ç"
   - Bio EN: type "Test bio in English"
   - Coaching since: 2018
   - Add a playing background row: level_fr="AAA Junior", level_en="AAA Junior", where="Québec", years="2010-2014"
   - Optionally upload a small JPG/PNG
4. **Click Save.** Status banner turns green ("Enregistré ✓"). Toast appears.
5. **Open `/coach.html?id=dave-dufour`** in a new tab.
   - Bio section shows the FR text. Toggle to EN — shows EN text. Accents render correctly.
   - "Entraîneur depuis" row shows 2018.
   - Playing background section shows the new row.
   - Photo shows the uploaded image (or initials if you skipped photo upload).
6. **Go back to admin, reload the page.** Pick Dave Dufour again. All your edits persist.
7. **Pick a second coach (e.g., Jonathan Landry).** Form populates with HIS data, not Dave's. Confirms slug routing works.

**Reset for clean state** (when you're done testing):
- In the admin form for Dave Dufour, clear bio FR, clear bio EN, clear coaching since, remove the playing background row (click ✕), click Save.

If any step fails, open browser DevTools console — the error from the worker comes back in the response and is displayed in the red banner. Report it.

---

## Commit (already in deploy step above)

---

## Open questions for Claude Code

1. After deploy, does the dropdown on `admin-coaches.html` show all 12 coaches in 3 optgroups?
2. Does the Save flow update both bio text AND photo in a single click (when both are changed)?
3. On the public `/coach.html?id=dave-dufour` page, do accents render correctly after a round-trip through D1?

---

## How to break this (Attack Vectors)

- **XSS via bio field** — public `coach.html` renders bio via `paragraphsToHtml(text)` which calls `escapeHtml(p)` on every paragraph. Inspected. Safe.
- **XSS via playing_bg** — public `coach.html` renders every cell via `escapeHtml(...)`. Inspected. Safe.
- **Bearer token theft** — `canonniers2026` is visible in client JS. Same posture as roster admin. Acceptable; deferred to CF Access JWT migration.
- **Slug forgery** — `coach.html` accepts any `?id=` value, but the API returns 404 for non-existent slugs, which triggers the redirect to alignement.html.
- **Oversized photo** — client checks 5MB; worker also checks 5MB. Double-guarded.
- **Playing_bg exceeding 20** — client disables "Add" button at 20; worker also rejects at 21. Double-guarded.

---

## Rollback

```powershell
git revert HEAD
git push
# Pages auto-redeploys to previous version. D1 data is unaffected.
```

If only `coach.html` is broken but admin works fine, you can also surgically revert only that file:

```powershell
git checkout HEAD~1 -- coach.html
git commit -m "revert coach.html refactor — admin form retained"
git push
```

The admin form will still work (writes hit D1), and the public page goes back to reading the hardcoded const.

---

**This is the final directive in the series.** After verification passes, the coach-editing workflow is complete: coach lands on `admin-coaches.html` past CF Access, picks themselves, edits, saves. Public site reflects the change immediately.
