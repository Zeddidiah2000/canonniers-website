# DIRECTIVE: Admin Auth — Cloudflare Access + Role Worker + admin.html Rewrite

## Overview
Replace the hardcoded password gate on `admin.html` with a Cloudflare Access-aware identity screen. Create a new standalone Worker (`canonniers-auth-worker`) that reads the Access JWT header, extracts the user's email, and returns their role from a secret lookup table. Update `admin.html` to show a branded welcome screen (logo, email, role) with an Enter button — no password form.

---

## PRE-FLIGHT — Read before touching anything

1. Read current `admin.html` from GitHub:
   `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/admin.html`
   Confirm it still contains `ADMIN_PASSWORD = 'canonniers2026'` and the `#login-screen` div. If not, stop and ask Jay.

2. Confirm `AAACanonLogo.png` exists at repo root:
   `https://raw.githubusercontent.com/Zeddidiah2000/canonniers-website/main/AAACanonLogo.png`
   If missing, stop and ask Jay.

---

## DELIVERABLE 1 — New Worker: `canonniers-auth-worker`

### Create file: `workers/canonniers-auth-worker/index.js`

```js
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://canonniersdequebec.ca',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // Cloudflare Access injects this header — it is already verified by CF before reaching here
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');

  if (!jwt) {
    return new Response(JSON.stringify({ error: 'No Access JWT found' }), {
      status: 401,
      headers: corsHeaders,
    });
  }

  // Decode JWT payload (base64url middle segment) — no need to re-verify, CF already did
  let email = null;
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    email = (payload.email || '').toLowerCase().trim();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JWT payload' }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  if (!email) {
    return new Response(JSON.stringify({ error: 'No email in JWT' }), {
      status: 400,
      headers: corsHeaders,
    });
  }

  // ROLE_MAP is a Worker secret — JSON string stored in Cloudflare dashboard
  let roleMap = {};
  try {
    roleMap = JSON.parse(ROLE_MAP);
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
```

### Create file: `workers/canonniers-auth-worker/wrangler.toml`

```toml
name = "canonniers-auth-worker"
main = "index.js"
compatibility_date = "2024-01-01"
```

### Deploy the Worker

```bash
cd workers/canonniers-auth-worker
wrangler deploy
```

### Add the ROLE_MAP secret

After deploy, run:

```bash
wrangler secret put ROLE_MAP
```

When prompted, paste this exact JSON (single line):

```
{"jay@canonniers.ca":"admin","jp@canonniers.ca":"admin","coach15u@canonniers.ca":"coach","coach17d1@canonniers.ca":"coach","coach17d2@canonniers.ca":"coach","manager15u@canonniers.ca":"manager","manager17d1@canonniers.ca":"manager","manager17d2@canonniers.ca":"manager","social15u@canonniers.ca":"social","social17d1@canonniers.ca":"social","social17d2@canonniers.ca":"social"}
```

### Verify Worker

```bash
curl https://canonniers-auth-worker.chisholm2000.workers.dev
```
Expected: `{"error":"No Access JWT found"}` with status 401. That confirms it's live and rejecting unauthenticated requests correctly.

---

## DELIVERABLE 2 — Rewrite `admin.html`

### What changes

| Remove | Add |
|---|---|
| `ADMIN_PASSWORD = 'canonniers2026'` | Auth Worker fetch on page load |
| `doLogin()` function | `initAuth()` async function |
| `doLogout()` function | Simple `doLogout()` that just redirects to `/` |
| `sessionStorage` auth check | Role from Worker response |
| `#login-screen` div (password form) | `#identity-screen` div (logo + email + role + Enter button) |
| `getCurrentRole()` URL param logic | Role returned from Worker |
| `CQ` text in login logo circle | `<img src="/AAACanonLogo.png">` |

### New identity screen HTML (replaces `#login-screen` div entirely)

```html
<!-- ══════════════ IDENTITY SCREEN ══════════════ -->
<div id="identity-screen">
  <div class="login-logo">
    <img src="/AAACanonLogo.png" alt="Canonniers de Québec" style="width:72px;height:72px;object-fit:contain;border-radius:50%;">
  </div>
  <div class="login-title">
    <span class="fr-text">Bienvenue</span>
    <span class="en-text">Welcome</span>
  </div>
  <div class="login-sub">
    <span class="fr-text">Portail Admin · Canonniers de Québec</span>
    <span class="en-text">Admin Portal · Canonniers de Québec</span>
  </div>
  <div class="login-box" id="identity-box">
    <div id="identity-loading" style="text-align:center;padding:16px 0;color:var(--text-dim);font-size:13px;letter-spacing:0.08em;">
      <span class="fr-text">Vérification de l'identité…</span>
      <span class="en-text">Verifying identity…</span>
    </div>
    <div id="identity-info" style="display:none;">
      <div style="margin-bottom:20px;">
        <div class="login-label">
          <span class="fr-text">Courriel</span>
          <span class="en-text">Email</span>
        </div>
        <div id="identity-email" style="font-family:'JetBrains Mono',monospace;font-size:14px;color:var(--sky-light);padding:10px 0;border-bottom:1px solid var(--border);"></div>
      </div>
      <div style="margin-bottom:28px;">
        <div class="login-label">
          <span class="fr-text">Rôle</span>
          <span class="en-text">Role</span>
        </div>
        <div id="identity-role-badge" style="margin-top:6px;"></div>
      </div>
      <button class="login-btn" onclick="enterPortal()">
        <span class="fr-text">Entrer →</span>
        <span class="en-text">Enter →</span>
      </button>
    </div>
    <div id="identity-error" style="display:none;text-align:center;padding:16px 0;">
      <div style="color:#f87171;font-size:13px;margin-bottom:16px;">
        <span class="fr-text">Accès non autorisé.</span>
        <span class="en-text">Access not authorized.</span>
      </div>
      <a href="/" style="color:var(--sky);font-size:12px;text-decoration:none;">
        <span class="fr-text">← Retour au site</span>
        <span class="en-text">← Back to site</span>
      </a>
    </div>
  </div>
</div>
```

### New CSS — add inside `<style>` block (replace `.login-logo` rule only, keep all other login CSS)

Replace the existing `.login-logo` rule:

```css
.login-logo {
  width: 110px;
  height: 110px;
  background: linear-gradient(135deg, rgba(106,176,212,0.15) 0%, rgba(30,58,138,0.3) 100%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1.5px solid rgba(106,176,212,0.4);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 24px;
  box-shadow: 0 0 40px rgba(0,212,255,0.15), inset 0 1px 0 rgba(255,255,255,0.1);
  animation: logo-pulse 4s ease-in-out infinite alternate;
  overflow: hidden;
}
```

Also update the CSS selector reference from `#login-screen` to `#identity-screen`:

```css
.lang-bar, #identity-screen, #admin-screen { position: relative; z-index: 1; }

#identity-screen {
  min-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
```

### New JS — replace entire `<script>` block contents

```js
const AUTH_WORKER_URL = 'https://canonniers-auth-worker.chisholm2000.workers.dev';

const ROLE_LABELS = {
  admin:     { fr: 'Admin',      en: 'Admin' },
  coach:     { fr: 'Entraîneur', en: 'Coach' },
  manager:   { fr: 'Gérant',     en: 'Manager' },
  treasurer: { fr: 'Trésorier',  en: 'Treasurer' },
  social:    { fr: 'Réseaux sociaux', en: 'Social Media' },
};

const ROLE_COLORS = {
  admin:     { bg: 'rgba(106,176,212,0.2)',  color: '#a8d4ec', border: 'rgba(106,176,212,0.4)' },
  coach:     { bg: 'rgba(106,176,212,0.12)', color: '#6ab0d4', border: 'rgba(106,176,212,0.25)' },
  manager:   { bg: 'rgba(168,212,236,0.1)',  color: '#a8d4ec', border: 'rgba(168,212,236,0.2)' },
  treasurer: { bg: 'rgba(250,200,100,0.12)', color: '#facb70', border: 'rgba(250,200,100,0.3)' },
  social:    { bg: 'rgba(100,200,150,0.12)', color: '#6dc8a0', border: 'rgba(100,200,150,0.3)' },
};

const TILES = [
  {
    id: 'social',
    href: '/admin-social.html',
    icon: 'megaphone',
    titleFr: 'Outils sociaux',
    titleEn: 'Social Tools',
    descFr: 'Générateur de publications Facebook et cartes graphiques de match.',
    descEn: 'Facebook post generator and game day card generator.',
    allowed: ['admin', 'coach', 'manager', 'social'],
    status: 'active',
    phase: null
  },
  {
    id: 'roster',
    href: '/admin-roster.html',
    icon: 'user',
    titleFr: 'Éditeur d\'alignement',
    titleEn: 'Roster Editor',
    descFr: 'Ajouter, modifier ou supprimer des joueurs. Photos, positions, statistiques.',
    descEn: 'Add, edit, or remove players. Photos, positions, stats.',
    allowed: ['admin', 'coach', 'manager'],
    status: 'active',
    phase: null
  },
  {
    id: 'photos',
    href: '/admin-photos.html',
    icon: 'camera',
    titleFr: 'Galerie photos',
    titleEn: 'Photo Gallery',
    descFr: 'Téléverser des photos de matchs par équipe et par date.',
    descEn: 'Upload game photos by team and date. Powers /galerie.html.',
    allowed: ['admin', 'coach', 'manager'],
    status: 'active',
    phase: null
  },
  {
    id: 'replays',
    href: null,
    icon: 'video',
    titleFr: 'Gestion des rediffusions',
    titleEn: 'Replay Manager',
    descFr: 'Lier les UIDs Cloudflare Stream aux matchs terminés.',
    descEn: 'Link Cloudflare Stream UIDs to completed games.',
    allowed: ['admin', 'coach', 'manager'],
    status: 'coming-soon',
    phase: 'Phase 3'
  },
  {
    id: 'finance',
    href: null,
    icon: 'wallet',
    titleFr: 'Finances d\'équipe',
    titleEn: 'Team Finance',
    descFr: 'Suivre les fonds, dons, dépenses. Stockage de documents.',
    descEn: 'Track funds, donations, expenses. Document storage.',
    allowed: ['admin', 'treasurer'],
    status: 'coming-soon',
    phase: 'Phase 4'
  }
];

// ── LANG ────────────────────────────────────────────────────────────
function setLang(lang) {
  document.body.className = 'lang-' + lang;
  document.documentElement.lang = lang;
  const btnFr = document.getElementById('btn-fr');
  const btnEn = document.getElementById('btn-en');
  if (btnFr) btnFr.classList.toggle('active', lang === 'fr');
  if (btnEn) btnEn.classList.toggle('active', lang === 'en');
  localStorage.setItem('lang', lang);
}

// ── AUTH ─────────────────────────────────────────────────────────────
let currentUserEmail = null;
let currentUserRole  = null;

async function initAuth() {
  const savedLang = localStorage.getItem('lang') || 'fr';
  setLang(savedLang);

  try {
    const res  = await fetch(AUTH_WORKER_URL);
    const data = await res.json();

    if (!res.ok || !data.role || data.role === 'unknown') {
      showIdentityError();
      return;
    }

    currentUserEmail = data.email;
    currentUserRole  = data.role;
    showIdentityInfo(data.email, data.role);

  } catch (e) {
    showIdentityError();
  }
}

function showIdentityInfo(email, role) {
  document.getElementById('identity-loading').style.display = 'none';
  document.getElementById('identity-info').style.display    = 'block';
  document.getElementById('identity-email').textContent     = email;

  const label  = ROLE_LABELS[role]  || { fr: role, en: role };
  const colors = ROLE_COLORS[role]  || ROLE_COLORS.manager;
  const lang   = localStorage.getItem('lang') || 'fr';

  document.getElementById('identity-role-badge').innerHTML =
    `<span style="
      display:inline-block;
      background:${colors.bg};
      color:${colors.color};
      border:1px solid ${colors.border};
      border-radius:99px;
      padding:4px 16px;
      font-family:'Barlow Condensed',sans-serif;
      font-size:14px;
      font-weight:700;
      letter-spacing:0.08em;
      text-transform:uppercase;
    ">
      <span class="fr-text">${label.fr}</span>
      <span class="en-text">${label.en}</span>
    </span>`;
}

function showIdentityError() {
  document.getElementById('identity-loading').style.display = 'none';
  document.getElementById('identity-error').style.display   = 'block';
}

function enterPortal() {
  document.getElementById('identity-screen').style.display = 'none';
  document.getElementById('admin-screen').style.display    = 'block';
  renderTiles();
}

function doLogout() {
  window.location.href = '/';
}

// ── TILE RENDERING ───────────────────────────────────────────────────
function renderTiles() {
  const role = currentUserRole || 'unknown';

  const roleLabel = ROLE_LABELS[role] || { fr: role, en: role };
  document.getElementById('current-role-fr').textContent = roleLabel.fr;
  document.getElementById('current-role-en').textContent = roleLabel.en;

  const active   = TILES.filter(t => t.status === 'active');
  const upcoming = TILES.filter(t => t.status === 'coming-soon');

  renderTileSection('section-active',   active,   role);
  renderTileSection('section-upcoming', upcoming, role);
}

function renderTileSection(containerId, tiles, role) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  for (const tile of tiles) {
    const allowed  = tile.allowed.includes(role);
    const isActive = tile.status === 'active';
    const div = document.createElement('div');
    div.className = 'tile' + (allowed ? '' : ' tile-locked') + (isActive ? '' : ' tile-coming-soon');

    const roleTagsHtml = tile.allowed.map(r => {
      const label = ROLE_LABELS[r] || { fr: r, en: r };
      return `<span class="role-tag role-${r}">` +
        `<span class="fr-text">${label.fr}</span>` +
        `<span class="en-text">${label.en}</span>` +
        `</span>`;
    }).join('');

    div.innerHTML =
      `<div class="tile-header">` +
        `<div class="tile-icon">${getIconSvg(tile.icon)}</div>` +
        `<div class="role-tags">${roleTagsHtml}</div>` +
      `</div>` +
      `<div class="tile-title">` +
        `<span class="fr-text">${escapeHtml(tile.titleFr)}</span>` +
        `<span class="en-text">${escapeHtml(tile.titleEn)}</span>` +
      `</div>` +
      `<div class="tile-desc">` +
        `<span class="fr-text">${escapeHtml(tile.descFr)}</span>` +
        `<span class="en-text">${escapeHtml(tile.descEn)}</span>` +
      `</div>` +
      `<div class="tile-cta">` +
        (isActive && allowed
          ? `<span class="fr-text">Ouvrir →</span><span class="en-text">Open →</span>`
          : !allowed
            ? `<span class="tile-lock-msg"><span class="fr-text">Accès restreint</span><span class="en-text">Access restricted</span></span>`
            : `<span class="fr-text">Bientôt · ${escapeHtml(tile.phase)}</span><span class="en-text">Coming soon · ${escapeHtml(tile.phase)}</span>`
        ) +
      `</div>`;

    if (isActive && allowed) {
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => { window.location.href = tile.href; });
    } else if (!allowed) {
      div.style.cursor = 'not-allowed';
    }

    container.appendChild(div);
  }
}

// ── ICONS ────────────────────────────────────────────────────────────
function getIconSvg(name) {
  const icons = {
    megaphone:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="m3 11 18-5v12L3 14v-3z"/>` +
        `<path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>` +
      `</svg>`,
    user:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>` +
        `<circle cx="12" cy="7" r="4"/>` +
      `</svg>`,
    camera:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>` +
        `<circle cx="12" cy="13" r="3"/>` +
      `</svg>`,
    video:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<polygon points="23 7 16 12 23 17 23 7"/>` +
        `<rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>` +
      `</svg>`,
    wallet:
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>` +
        `<path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>` +
        `<path d="M18 12a2 2 0 0 0 0 4h4v-4z"/>` +
      `</svg>`,
  };
  return icons[name] || '';
}

// ── UTILS ────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── ROLE TAG CSS — add to <style> block ──────────────────────────────
// (include this note for Claude Code — add the social role-tag color)
// .role-tag.role-social { background: rgba(100,200,150,0.12); color: #6dc8a0; border: 1px solid rgba(100,200,150,0.2); }

// ── BOOT ─────────────────────────────────────────────────────────────
initAuth();
```

---

## DELIVERABLE 3 — Update `admin.html` CSS

Inside the existing `<style>` block, add the `social` role tag color after the existing `.role-tag` rules:

```css
.role-tag.role-social { background: rgba(100,200,150,0.12); color: #6dc8a0; border: 1px solid rgba(100,200,150,0.2); }
```

---

## DELIVERABLE 4 — Also add `canonniers-auth-worker` to Cloudflare Access policy

After deploying the Worker, add its URL to the Cloudflare Access application so the JWT header is injected when `admin.html` calls it:

In Zero Trust dashboard → Access controls → Applications → your admin application → edit → add a second hostname:
- Domain: `canonniers-auth-worker.chisholm2000.workers.dev`
- Path: (leave blank — protect entire Worker)

This ensures the Worker receives the `Cf-Access-Jwt-Assertion` header on every call from an authenticated user.

---

## POST-DEPLOY VERIFICATION

1. In incognito, go to `canonniersdequebec.ca/admin.html`
2. Cloudflare Access login page appears → enter `jay@canonniers.ca` → receive OTP → enter it
3. Identity screen loads showing:
   - CQ logo
   - "Bienvenue / Welcome"
   - `jay@canonniers.ca`
   - Admin role badge (sky blue)
   - "Entrer →" button
4. Click Enter → tile grid renders with all tiles accessible
5. Confirm no `ADMIN_PASSWORD` string anywhere in page source (`Cmd+F` in DevTools)
6. Confirm no `canonniers2026` string anywhere in page source

---

## ROLLBACK PLAN

If the Worker fails to return a role and identity screen shows error state:
- The old password form is gone — users will see the error screen
- Quick fix: temporarily add `?role=admin` bypass back to `getCurrentRole()` while debugging
- Worker logs available at: Cloudflare dashboard → Workers → canonniers-auth-worker → Logs

If Access JWT header is missing from Worker calls (Worker returns 401):
- Most likely cause: Worker URL not added to Access application (see Deliverable 4)
- Fix: add Worker domain to Access application as described above

---

## OPEN QUESTIONS — Ask Jay if uncertain

1. Is the Worker URL `canonniers-auth-worker.chisholm2000.workers.dev` correct, or does it need a different subdomain?
2. Should `admin-roster.html` and `admin-social.html` also verify the role via the Worker, or is the hub-level role gate sufficient for now?
3. The bearer token `canonniersdequebec2026` is still hardcoded in `admin-roster.html` client JS — is that in scope for this commit or a follow-up?
